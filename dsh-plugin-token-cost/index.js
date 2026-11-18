/**
 * Host half of the token-cost bundle.
 *
 * Two jobs:
 *  1. Fold billed tokens per route and price period into the `tokenCost` session
 *     projection the Client renders.
 *  2. Track DeepSeek's published prices: fetch the official page, parse it, refuse
 *     anything that fails validation, keep the last good table on disk, and inject
 *     the current table into each page load.
 *
 * Why this file does not `import 'zod'`: a bundle installed as a link resolves
 * imports from its own directory, so the profile's `node_modules` is out of reach
 * (verified: `ERR_MODULE_NOT_FOUND`). The Harness's own zod copy is loaded by
 * absolute path instead, which also keeps the schema an instance of the same
 * module the projection registry validates with.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyEvent, initialState, viewOf } from './projection.js'
import { PRICING_URL, parsePricingHtml, validatePricing } from './pricing-source.js'

/** Required service: the session projection registry. */
export const inject = ['sessionProjections']

/** Re-check the published page once a day. */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
/** A cached table younger than this is reused at startup instead of refetching. */
const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000

/** Candidate `node_modules` roots holding the Harness's own dependencies, most specific first. */
function nodeModulesRoots() {
  const roots = []
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0 && !roots.includes(value)) roots.push(value)
  }
  const segment = /[\\/]node_modules[\\/]/

  const install = process.env.DSH_INSTALL_DIR
  if (typeof install === 'string' && install.length > 0) {
    const [head] = install.split(segment)
    if (head !== install) add(path.join(head, 'node_modules'))
  }

  for (const argument of process.argv) {
    if (typeof argument !== 'string' || !argument.includes('app.asar')) continue
    const [head] = argument.split(segment)
    if (head !== argument) add(path.join(head, 'node_modules'))
    else add(path.join(argument, 'node_modules'))
  }

  add(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules'))
  return roots
}

/** Import the Harness's zod by absolute file URL. */
async function loadZod() {
  const failures = []
  for (const root of nodeModulesRoots()) {
    const entry = path.join(root, 'zod', 'index.js')
    try {
      return await import(pathToFileURL(entry).href)
    } catch (error) {
      failures.push(`${entry} (${error?.code ?? 'ERR'}: ${(error?.message ?? String(error)).slice(0, 120)})`)
    }
  }
  throw new Error(`token-cost: cannot load the harness zod copy; tried ${failures.join(' | ')}`)
}

/** Positive integer token count. */
function countSchema(z) {
  return z.number().int().nonnegative()
}

/** DSH home, for the pricing cache. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

const CACHE_PATH = path.join(dshHome(), 'storages', 'token-cost-pricing.json')

/** Last good table from disk, or null when absent/invalid. */
async function loadCachedPricing() {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8')
    const cached = JSON.parse(raw)
    const check = validatePricing({ ok: true, table: cached?.table })
    if (!check.ok) return null
    if (typeof cached.fetchedAt !== 'string' || Number.isNaN(Date.parse(cached.fetchedAt))) return null
    return { table: cached.table, fetchedAt: cached.fetchedAt, source: String(cached.source ?? PRICING_URL) }
  } catch {
    return null
  }
}

/** Persist the table so a restart keeps working offline. */
async function saveCachedPricing(pricing) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true })
  await fs.writeFile(CACHE_PATH, JSON.stringify(pricing, null, 2), 'utf8')
}

/** Fetch, parse and validate the published page; throws on any doubt. */
async function fetchPricing() {
  const response = await fetch(PRICING_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'text/html' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const parsed = parsePricingHtml(await response.text())
  const check = validatePricing(parsed)
  if (!check.ok) throw new Error(check.reason)
  return { table: parsed.table, fetchedAt: new Date().toISOString(), source: PRICING_URL }
}

/** Body script handing the current table to the Client module. */
function bootScript(pricing) {
  const payload = JSON.stringify({
    currency: pricing.table.currency,
    models: pricing.table.models,
    fetchedAt: pricing.fetchedAt,
    source: pricing.source,
  })
  return `window.__DSH_TOKEN_COST__ = ${payload.replace(/</g, '\\u003c')};`
}

/**
 * Register the `tokenCost` projection and start tracking the price page.
 * @param ctx - Host plugin context.
 */
export async function apply(ctx) {
  const { z } = await loadZod()

  const bucketsSchema = z.object({
    uncachedInputTokens: countSchema(z),
    cacheReadTokens: countSchema(z),
    cacheWriteTokens: countSchema(z),
    outputTokens: countSchema(z),
  }).strict()

  const periodSchema = z.enum(['peak', 'offPeak'])

  const rowSchema = z.object({
    provider: z.string(),
    model: z.string(),
    period: periodSchema,
    uncachedInputTokens: countSchema(z),
    cacheReadTokens: countSchema(z),
    cacheWriteTokens: countSchema(z),
    outputTokens: countSchema(z),
  }).strict()

  const turnsSchema = z.array(z.object({ turn: countSchema(z), rows: z.array(rowSchema) }).strict())

  const stateSchema = z.object({
    rows: z.array(rowSchema),
    turns: turnsSchema,
    last: z.object({
      turn: countSchema(z),
      step: countSchema(z),
      provider: z.string(),
      model: z.string(),
      period: periodSchema,
      buckets: bucketsSchema,
    }).strict().nullable(),
  }).strict()

  await ctx.sessionProjections.register({
    key: 'tokenCost',
    // v2 adds the per-turn ledger beside the session rows.
    stateVersion: 2,
    stateSchema,
    init: initialState,
    apply: applyEvent,
    wire: {
      viewSchema: z.object({ rows: z.array(rowSchema), turns: turnsSchema }).strict(),
      view: viewOf,
    },
  })

  // ---- published prices -------------------------------------------------
  let pricing = await loadCachedPricing()
  const warn = typeof ctx.logger?.warn === 'function'
    ? message => ctx.logger.warn(message)
    : message => console.warn(message)

  const refresh = async () => {
    try {
      const next = await fetchPricing()
      pricing = next
      await saveCachedPricing(next)
    } catch (error) {
      // Keep the previous table: a stale price is far better than a wrong one.
      warn(`token-cost: pricing refresh failed (${error?.message ?? error}); keeping the previous table`)
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => { void refresh() }, REFRESH_INTERVAL_MS)
    const age = pricing === null ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(pricing.fetchedAt)
    if (age > REFRESH_AFTER_MS) void refresh()
    return () => clearInterval(timer)
  }, 'token-cost: pricing refresh')

  ctx.on('webserver/index-inject', (table) => {
    if (pricing === null) return
    table.push({ kind: 'script', placement: 'body', text: bootScript(pricing) })
  })
}
