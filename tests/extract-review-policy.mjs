/**
 * 从已安装的官方 auto-review 包中原样抽取 REVIEW_POLICY 模板字符串，
 * 写入 lib/review-policy.txt（MIT 许可，来源见 README 的“来源与许可”）。
 * 运行：node tests/extract-review-policy.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = process.env.DSH_AUTO_REVIEW_SRC
  ?? 'D:/ZeroTools/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js'
const target = fileURLToPath(new URL('../lib/review-policy.txt', import.meta.url))

const text = readFileSync(source, 'utf8')
const marker = 'const REVIEW_POLICY = `'
const start = text.indexOf(marker)
if (start < 0) throw new Error('REVIEW_POLICY not found in source')
const bodyStart = start + marker.length
const end = text.indexOf('`;', bodyStart)
if (end < 0) throw new Error('REVIEW_POLICY terminator not found')
const policy = text.slice(bodyStart, end)
if (!policy.startsWith('REVIEW_POLICY')) throw new Error('extracted policy does not start with REVIEW_POLICY')
if (policy.length < 500) throw new Error('extracted policy suspiciously short')
writeFileSync(target, policy, 'utf8')
console.log(`wrote ${target} (${policy.length} chars)`)
