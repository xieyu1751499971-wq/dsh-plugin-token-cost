/**
 * Pricing source: fetch-side pure helpers for the DeepSeek price page.
 *
 * The page is a Docusaurus-rendered HTML table whose pricing block reads like:
 *
 *   价格(2) | 百万tokens输入（缓存命中） | 空闲时段 | 0.02元 | 0.15元
 *           |                          | 高峰时段 | 0.04元 | 0.30元
 *           | 百万tokens输入（缓存未命中）| 空闲时段 | 1元    | 4.5元
 *           |                          | 高峰时段 | 2元    | 9.0元
 *
 * Column order after the first two cells is the model order from the table head.
 * Nothing here performs I/O, so it can be exercised offline against saved HTML.
 */

/** Page the plugin reads; the Chinese page is priced in CNY, the English one in USD. */
export const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** The currency this plugin prices in. */
const REQUIRED_CURRENCY = '¥'

const METRIC_PATTERNS = [
  ['cacheHit', /缓存命中|cache\s*hit/i],
  ['cacheMiss', /缓存未命中|cache\s*miss/i],
  ['output', /(^|[^入])输出|output/i],
]

const PERIOD_OFFPEAK = /空闲|off[-\s]*peak/i
const PERIOD_PEAK = /高峰|^peak$/i

/** Strip tags, decode the entities this page uses, and collapse whitespace. */
function cellText(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every `<tr>` of the document, each as its ordered cell texts. */
function tableRows(html) {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  const rows = []
  for (const rowMatch of withoutNoise.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = []
    for (const cellMatch of rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
      cells.push(cellText(cellMatch[1]))
    }
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

/** One price cell → `{ value, currency }`, or undefined when it is not a price. */
function priceCell(text) {
  const match = /^(?:([¥$€])\s*)?(\d+(?:\.\d+)?)\s*(元|¥|\$)?$/.exec(text.trim())
  if (match === null) return undefined
  const symbol = match[1] ?? match[3]
  const currency = symbol === '$' ? '$' : '¥'
  const value = Number(match[2])
  if (!Number.isFinite(value)) return undefined
  return { value, currency }
}

/** Metric key named by one leading cell, if any. */
function metricOf(text) {
  for (const [key, pattern] of METRIC_PATTERNS) {
    if (pattern.test(text)) return key
  }
  return undefined
}

/** Period key named by one cell, if any. */
function periodOf(text) {
  if (PERIOD_OFFPEAK.test(text)) return 'offPeak'
  if (PERIOD_PEAK.test(text)) return 'peak'
  return undefined
}

/** Model column names from the table head row (`模型` / `MODEL`). */
function modelColumns(rows) {
  for (const cells of rows) {
    if (cells.length < 2) continue
    if (!/^(模型|model)/i.test(cells[0])) continue
    return cells.slice(1)
      .map(name => name.replace(/[（(]\s*\d+\s*[)）]/g, '').trim().toLowerCase())
      .filter(name => name.length > 0)
  }
  return []
}

/**
 * Parse the pricing page.
 * @param html - page HTML.
 * @returns `{ ok: true, table }` or `{ ok: false, reason }`; never throws.
 */
export function parsePricingHtml(html) {
  if (typeof html !== 'string' || html.length < 1000) return { ok: false, reason: 'page is too small' }
  const rows = tableRows(html)
  if (rows.length === 0) return { ok: false, reason: 'no table rows found' }

  const models = modelColumns(rows)
  if (models.length < 1) return { ok: false, reason: 'model column header not found' }

  let started = false
  let currentMetric
  let currency
  const table = Object.create(null)

  for (const cells of rows) {
    if (!started) {
      if (/^(价格|pricing)/i.test(cells[0] ?? '')) started = true
      else continue
    } else if (/^(并发限制|concurrency)/i.test(cells[0] ?? '')) {
      break
    }

    // Trailing cells are the per-model prices; the cell before them is the period.
    let end = cells.length
    while (end > 0 && priceCell(cells[end - 1]) !== undefined) end -= 1
    const prices = cells.slice(end).map(priceCell)
    if (prices.length !== models.length) continue
    const period = end > 0 ? periodOf(cells[end - 1]) : undefined
    if (period === undefined) continue

    const leading = end > 0 ? cells.slice(0, end - 1) : []
    let metric
    for (const cell of leading) {
      const found = metricOf(cell)
      if (found !== undefined) metric = found
    }
    if (metric !== undefined) currentMetric = metric
    if (currentMetric === undefined) continue

    models.forEach((model, index) => {
      const price = prices[index]
      if (price === undefined) return
      if (currency === undefined) currency = price.currency
      if (price.currency !== currency) return
      table[model] ??= { peak: {}, offPeak: {} }
      table[model][period][currentMetric] = price.value
    })
  }

  if (!started) return { ok: false, reason: 'pricing block not found' }
  if (currency === undefined) return { ok: false, reason: 'no price cells parsed' }
  return { ok: true, table: { currency, models: table } }
}

/**
 * Reject a parsed table that cannot be trusted with money.
 * Rules: the required models and all six rates are present, every rate is a
 * plausible positive amount, and off-peak is half of peak (the page states it).
 * @param parsed - result of {@link parsePricingHtml}.
 * @returns `{ ok: true }` or `{ ok: false, reason }`.
 */
export function validatePricing(parsed) {
  if (parsed?.ok !== true) return { ok: false, reason: parsed?.reason ?? 'parse failed' }
  const { currency, models } = parsed.table
  if (currency !== REQUIRED_CURRENCY) {
    return { ok: false, reason: `currency is ${currency}, expected ${REQUIRED_CURRENCY}` }
  }
  const names = Object.keys(models)
  if (names.length === 0) return { ok: false, reason: 'no models parsed' }
  if (!names.includes('deepseek-flash')) return { ok: false, reason: 'deepseek-flash missing' }

  for (const name of names) {
    const entry = models[name]
    for (const period of ['peak', 'offPeak']) {
      for (const metric of ['cacheHit', 'cacheMiss', 'output']) {
        const value = entry?.[period]?.[metric]
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1000) {
          return { ok: false, reason: `${name}.${period}.${metric} is not a plausible rate` }
        }
      }
      const halfOfPeak = entry.peak
      const offPeak = entry.offPeak
      for (const metric of ['cacheHit', 'cacheMiss', 'output']) {
        const expected = halfOfPeak[metric] / 2
        if (Math.abs(offPeak[metric] - expected) > expected * 0.01) {
          return { ok: false, reason: `${name}.${metric}: off-peak is not half of peak` }
        }
      }
    }
  }
  return { ok: true }
}
