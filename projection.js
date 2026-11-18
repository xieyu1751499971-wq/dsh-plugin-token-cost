/**
 * Pure fold for per-route token billing.
 *
 * The durable log settles one billed attempt per step boundary. This unit keeps
 * the exact buckets split two ways:
 *   - session totals by the route (provider + model) and the price period;
 *   - the same split per turn, so one message's action row can price itself.
 *
 * Replacement semantics mirror the shipped `tokenUsage` unit: attempts and their
 * settling message report the same step, so a later event for a step REPLACES the
 * earlier one rather than adding to it, and `llm/retry-started` frees the slot so
 * the retried attempt counts separately.
 *
 * Kept free of imports so it can be exercised offline against synthetic events.
 */

/** Price period tags; `peak` is DeepSeek's Beijing-time business window. */
export const PERIOD_PEAK = 'peak'
export const PERIOD_OFFPEAK = 'offPeak'

/** Route used when an event reported usage without provider/model attribution. */
export const UNATTRIBUTED = Object.freeze({ provider: '', model: '' })

/**
 * Whether `time` falls in DeepSeek's peak window: Beijing time (UTC+8, no DST),
 * Monday to Friday, 09:00–12:00 and 14:00–18:00.
 * @param time - epoch milliseconds of the billed settlement.
 * @returns whether the peak rate applies.
 */
export function isPeakAt(time) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return false
  const beijing = new Date(time + 8 * 60 * 60 * 1000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080)
}

/** Fresh state; also the projection's `init`. */
export function initialState() {
  return { rows: [], turns: [], last: null }
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Last `usage` chunk of one durable assistant stream, or undefined. */
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/** One event's bucket set, or undefined when it reports none. */
function bucketsOf(event) {
  const usage = event.type === 'assistant/message' && event.data.usage !== undefined
    ? event.data.usage
    : lastStreamUsage(event.data.stream)
  if (usage === undefined || usage === null || typeof usage !== 'object') return undefined
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return undefined
  return {
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: isCount(usage.cacheReadTokens) ? usage.cacheReadTokens : 0,
    cacheWriteTokens: isCount(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0,
  }
}

/** Route of a settled message, or the unattributed marker. */
function routeOf(event) {
  if (event.type !== 'assistant/message') return UNATTRIBUTED
  const source = event.data.message?.source
  if (typeof source?.provider !== 'string' || typeof source?.model !== 'string') return UNATTRIBUTED
  if (source.provider.length === 0 || source.model.length === 0) return UNATTRIBUTED
  return { provider: source.provider, model: source.model }
}

const FIELDS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']

function sameBuckets(left, right) {
  return FIELDS.every(field => left[field] === right[field])
}

/** Add or subtract one bucket set on the row for a route and period. */
function shiftRow(rows, route, period, buckets, sign) {
  const index = rows.findIndex(row =>
    row.provider === route.provider && row.model === route.model && row.period === period)
  if (index === -1) {
    if (sign < 0) return rows
    return [...rows, {
      provider: route.provider,
      model: route.model,
      period,
      uncachedInputTokens: buckets.uncachedInputTokens,
      cacheReadTokens: buckets.cacheReadTokens,
      cacheWriteTokens: buckets.cacheWriteTokens,
      outputTokens: buckets.outputTokens,
    }]
  }
  const row = rows[index]
  const next = { ...row }
  for (const field of FIELDS) next[field] = Math.max(0, row[field] + sign * buckets[field])
  if (FIELDS.every(field => next[field] === 0)) {
    return rows.filter((_, position) => position !== index)
  }
  const copy = rows.slice()
  copy[index] = next
  return copy
}

/** Add or subtract one bucket set on the per-turn ledger, dropping an emptied turn. */
function shiftTurn(turns, turnNumber, route, period, buckets, sign) {
  const index = turns.findIndex(entry => entry.turn === turnNumber)
  if (index === -1) {
    if (sign < 0) return turns
    return [...turns, { turn: turnNumber, rows: shiftRow([], route, period, buckets, sign) }]
      .sort((left, right) => left.turn - right.turn)
  }
  const rows = shiftRow(turns[index].rows, route, period, buckets, sign)
  const copy = turns.slice()
  if (rows.length === 0) {
    copy.splice(index, 1)
    return copy
  }
  copy[index] = { turn: turns[index].turn, rows }
  return copy
}

/**
 * Fold one session event.
 * @param state - current fold state.
 * @param event - durable session event.
 * @returns the same reference when the event does not change the state.
 */
export function applyEvent(state, event) {
  if (event.type === 'llm/retry-started') {
    const last = state.last
    const same = last !== null && last.turn === event.data.turn && last.step === event.data.step
    return same ? { ...state, last: null } : state
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
  const buckets = bucketsOf(event)
  if (buckets === undefined) return state

  const { turn, step } = event.data
  const route = routeOf(event)
  const period = isPeakAt(event.time) ? PERIOD_PEAK : PERIOD_OFFPEAK

  const last = state.last
  const replaces = last !== null && last.turn === turn && last.step === step
  if (replaces
    && last.provider === route.provider
    && last.model === route.model
    && last.period === period
    && sameBuckets(last.buckets, buckets)) return state

  let rows = state.rows
  let turns = state.turns
  if (replaces) {
    const previousRoute = { provider: last.provider, model: last.model }
    rows = shiftRow(rows, previousRoute, last.period, last.buckets, -1)
    turns = shiftTurn(turns, last.turn, previousRoute, last.period, last.buckets, -1)
  }
  rows = shiftRow(rows, route, period, buckets, 1)
  turns = shiftTurn(turns, turn, route, period, buckets, 1)

  return {
    rows,
    turns,
    last: {
      turn,
      step,
      provider: route.provider,
      model: route.model,
      period,
      buckets,
    },
  }
}

const carriesTokens = rows => rows.filter(row => FIELDS.some(field => row[field] > 0))

/** Wire value: session rows plus the per-turn ledger, both without empty entries. */
export function viewOf(state) {
  return {
    rows: carriesTokens(state.rows),
    turns: state.turns
      .map(entry => ({ turn: entry.turn, rows: carriesTokens(entry.rows) }))
      .filter(entry => entry.rows.length > 0),
  }
}
