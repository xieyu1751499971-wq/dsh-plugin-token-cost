// 价格抓取侧的离线用例：解析真实结构、拒绝不可信结果。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePricingHtml, validatePricing } from '../pricing-source.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = name => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8')
const zh = read('pricing-zh.html')
const usd = read('pricing-usd.html')

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
}

// 1. 真实结构 → 解析出两个模型 × 六档价格，且通过校验
const parsed = parsePricingHtml(zh)
const valid = validatePricing(parsed)
check('1. 解析中文页', parsed.ok && parsed.table.currency === '¥', parsed.ok ? parsed.table : parsed.reason)
check('2. 两模型六档齐全', parsed.ok
  && Object.keys(parsed.table.models).length === 2
  && parsed.table.models['deepseek-flash'].peak.output === 8
  && parsed.table.models['deepseek-v4-pro'].offPeak.cacheHit === 0.15,
  parsed.ok ? parsed.table.models : undefined)
check('3. 通过校验', valid.ok, valid)

// 4. 页码里的「并发限制」行不得被当成价格
check('4. 忽略非价格表', parsed.ok && parsed.table.models['deepseek-flash'].peak.cacheMiss === 2, undefined)

// 5. 缺输出价 → 应被拒
const missing = parsePricingHtml(zh.replace(/<tr><td>百万tokens输出[\s\S]*?<\/tr>\s*<tr><td>高峰时段[\s\S]*?<\/tr>/, ''))
check('5. 缺档被拒', missing.ok === true && validatePricing(missing).ok === false, validatePricing(missing))

// 6. 空闲价不再是高峰价的一半 → 应被拒
const broken = parsePricingHtml(zh.replace('0.02元', '0.032元'))
check('6. 半价关系被破坏时拒绝', broken.ok === true && validatePricing(broken).ok === false, validatePricing(broken))

// 7. 美元页 → 币种不符，应被拒
const usdParsed = parsePricingHtml(usd)
check('7. 美元页被拒', usdParsed.ok === true
  && usdParsed.table.currency === '$'
  && validatePricing(usdParsed).ok === false, validatePricing(usdParsed))

// 8. 价格超出可信区间 → 应被拒
const huge = parsePricingHtml(zh.replace('27.0元', '270000元'))
check('8. 异常高价被拒', huge.ok === true && validatePricing(huge).ok === false, validatePricing(huge))

// 9. 登录页/错误页 → 解析失败而不是误判为通过
check('9. 非价格页被拒', validatePricing(parsePricingHtml('<html><body><h1>404</h1></body></html>')).ok === false, undefined)

// 10. 模型列顺序变化仍按表头映射
const swapped = parsePricingHtml(zh
  .replace('<td>deepseek-flash (1)</td><td>deepseek-v4-pro</td>', '<td>deepseek-v4-pro</td><td>deepseek-flash (1)</td>')
  .replace('<td>0.02元</td><td>0.15元</td>', '<td>0.15元</td><td>0.02元</td>')
  .replace('<td>0.04元</td><td>0.30元</td>', '<td>0.30元</td><td>0.04元</td>')
  .replace('<td>1元</td><td>4.5元</td>', '<td>4.5元</td><td>1元</td>')
  .replace('<td>2元</td><td>9.0元</td>', '<td>9.0元</td><td>2元</td>')
  .replace('<td>4元</td><td>13.5元</td>', '<td>13.5元</td><td>4元</td>')
  .replace('<td>8元</td><td>27.0元</td>', '<td>27.0元</td><td>8元</td>'))
check('10. 列顺序变化按表头映射', swapped.ok
  && swapped.table.models['deepseek-flash'].peak.cacheHit === 0.04
  && swapped.table.models['deepseek-v4-pro'].peak.cacheHit === 0.3, undefined)

const failed = checks.filter(entry => entry.pass === false)
process.stdout.write(JSON.stringify({
  failed: failed.length,
  failedChecks: failed,
  checks: checks.map(entry => `${entry.pass ? 'PASS' : 'FAIL'} ${entry.name}`),
}, null, 2) + '\n')
