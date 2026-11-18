// 离线验证 projection.js 的折叠语义（不依赖 DSH）。
// 事件顺序按真实日志：step/start → assistant/attempt（无路由）→ assistant/message（带路由）。
const { applyEvent, initialState, viewOf } = await import(
  '../projection.js'
)

const PEAK = Date.UTC(2026, 10, 18, 3, 0, 0) // 周三 11:00 北京 → 高峰
const OFF = Date.UTC(2026, 10, 18, 12, 0, 0) // 周三 20:00 北京 → 空闲
const SAT = Date.UTC(2026, 10, 21, 3, 0, 0) // 周六 11:00 北京 → 空闲

const flash = { provider: 'deepseek-account', model: 'deepseek-flash' }
const pro = { provider: 'deepseek-account', model: 'deepseek-v4-pro' }

const message = (turn, step, usage, source, time) => ({
  type: 'assistant/message',
  time,
  data: { turn, step, usage, message: { source } },
})
const attempt = (turn, step, usage, time) => ({
  type: 'assistant/attempt',
  time,
  data: { turn, step, stream: [{ type: 'chunk', chunk: { type: 'usage', usage } }] },
})
const retryStarted = (turn, step, time) => ({ type: 'llm/retry-started', time, data: { turn, step } })

const rowsOf = state => viewOf(state).rows
  .map(row => `${row.model || '(none)'}|${row.period}|in=${row.uncachedInputTokens}|cr=${row.cacheReadTokens}|cw=${row.cacheWriteTokens}|out=${row.outputTokens}`)
  .sort()

const checks = []
function step(name, state, event, expected, expectSameReference = false) {
  const next = applyEvent(state, event)
  const actual = rowsOf(next)
  checks.push({
    name,
    pass: JSON.stringify(actual) === JSON.stringify(expected)
      && (!expectSameReference || next === state),
    actual,
    expected,
  })
  return next
}

let state = initialState()

state = step('1. 高峰 message 记一行', state,
  message(1, 1, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 }, flash, PEAK),
  ['deepseek-flash|peak|in=1000|cr=200|cw=0|out=500'])

state = step('2. 同值重放不改引用', state,
  message(1, 1, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 }, flash, PEAK),
  ['deepseek-flash|peak|in=1000|cr=200|cw=0|out=500'], true)

state = step('3. attempt 先记（无路由）', state,
  attempt(1, 2, { inputTokens: 100, outputTokens: 50 }, PEAK),
  ['(none)|peak|in=100|cr=0|cw=0|out=50', 'deepseek-flash|peak|in=1000|cr=200|cw=0|out=500'])

state = step('4. message 覆盖同 step 并补上路由', state,
  message(1, 2, { inputTokens: 120, outputTokens: 60 }, flash, PEAK),
  ['deepseek-flash|peak|in=1120|cr=200|cw=0|out=560'])

state = step('5. 重试第 1 次', state,
  attempt(1, 3, { inputTokens: 10, outputTokens: 5 }, PEAK),
  ['(none)|peak|in=10|cr=0|cw=0|out=5', 'deepseek-flash|peak|in=1120|cr=200|cw=0|out=560'])

state = step('6. retry-started 只清槽不动行', state,
  retryStarted(1, 3, PEAK),
  ['(none)|peak|in=10|cr=0|cw=0|out=5', 'deepseek-flash|peak|in=1120|cr=200|cw=0|out=560'])

state = step('7. 重试第 2 次累加（不覆盖第 1 次）', state,
  attempt(1, 3, { inputTokens: 20, outputTokens: 10 }, PEAK),
  ['(none)|peak|in=30|cr=0|cw=0|out=15', 'deepseek-flash|peak|in=1120|cr=200|cw=0|out=560'])

state = step('8. 重试后的 message 只替换最后一次 attempt', state,
  message(1, 3, { inputTokens: 30, outputTokens: 15 }, flash, PEAK),
  ['(none)|peak|in=10|cr=0|cw=0|out=5', 'deepseek-flash|peak|in=1150|cr=200|cw=0|out=575'])

state = step('9. 另一模型 + 空闲时段独立成行', state,
  message(1, 4, { inputTokens: 7, outputTokens: 3 }, pro, OFF),
  ['(none)|peak|in=10|cr=0|cw=0|out=5', 'deepseek-flash|peak|in=1150|cr=200|cw=0|out=575', 'deepseek-v4-pro|offPeak|in=7|cr=0|cw=0|out=3'])

state = step('10. 周末同一模型进空闲行', state,
  message(1, 5, { inputTokens: 2, outputTokens: 1 }, flash, SAT),
  ['(none)|peak|in=10|cr=0|cw=0|out=5', 'deepseek-flash|offPeak|in=2|cr=0|cw=0|out=1', 'deepseek-flash|peak|in=1150|cr=200|cw=0|out=575', 'deepseek-v4-pro|offPeak|in=7|cr=0|cw=0|out=3'])

state = step('11. 无 source 的 message 归入空模型行', state,
  message(1, 6, { inputTokens: 5, outputTokens: 2 }, undefined, PEAK),
  ['(none)|peak|in=15|cr=0|cw=0|out=7', 'deepseek-flash|offPeak|in=2|cr=0|cw=0|out=1', 'deepseek-flash|peak|in=1150|cr=200|cw=0|out=575', 'deepseek-v4-pro|offPeak|in=7|cr=0|cw=0|out=3'])

state = step('12. 无关事件保持引用', state,
  { type: 'turn/start', time: PEAK, data: { turn: 2 } },
  rowsOf(state), true)

// 总量守恒：所有行加总 = 六条 message + 重试中未被 message 结算的第 1 次 attempt（10/5）
const totalIn = viewOf(state).rows.reduce((sum, row) => sum + row.uncachedInputTokens, 0)
const totalOut = viewOf(state).rows.reduce((sum, row) => sum + row.outputTokens, 0)
checks.push({
  name: '13. 总量守恒（失败被重试的 attempt 计入）',
  pass: totalIn === 1000 + 120 + 30 + 7 + 2 + 5 + 10 && totalOut === 500 + 60 + 15 + 3 + 1 + 2 + 5,
  actual: { totalIn, totalOut },
  expected: { totalIn: 1174, totalOut: 586 },
})

// 14. 按轮拆分：两个 turn 各自成表，互不混淆
let twoTurns = initialState()
twoTurns = applyEvent(twoTurns, message(1, 1, { inputTokens: 100, outputTokens: 50 }, flash, PEAK))
twoTurns = applyEvent(twoTurns, message(2, 1, { inputTokens: 7, outputTokens: 3 }, pro, OFF))
const twoTurnsView = viewOf(twoTurns)
checks.push({
  name: '14. 按轮拆分',
  pass: twoTurnsView.turns.length === 2
    && twoTurnsView.turns[0].turn === 1 && twoTurnsView.turns[1].turn === 2
    && twoTurnsView.turns[0].rows[0].model === 'deepseek-flash'
    && twoTurnsView.turns[1].rows[0].model === 'deepseek-v4-pro',
  actual: twoTurnsView.turns,
  expected: 'turn1 flash / turn2 pro',
})

// 15. 替换同时作用于会话级与按轮级，不留残影
let replaced = initialState()
replaced = applyEvent(replaced, attempt(1, 1, { inputTokens: 100, outputTokens: 50 }, PEAK))
replaced = applyEvent(replaced, message(1, 1, { inputTokens: 120, outputTokens: 60 }, flash, PEAK))
const replacedView = viewOf(replaced)
checks.push({
  name: '15. 替换同时作用于两层',
  pass: replacedView.rows.length === 1
    && replacedView.rows[0].model === 'deepseek-flash'
    && replacedView.rows[0].uncachedInputTokens === 120
    && replacedView.turns.length === 1
    && replacedView.turns[0].rows.length === 1
    && replacedView.turns[0].rows[0].uncachedInputTokens === 120,
  actual: replacedView,
  expected: 'one row / one turn, 120 each',
})

const failed = checks.filter(check => check.pass === false)
process.stdout.write(JSON.stringify({ failed: failed.length, failedChecks: failed, checks: checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}`) }, null, 2) + '\n')

