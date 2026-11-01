/**
 * 离线校验客户端两份字典（ZH / EN）的 key 完全一致。
 * client.js 是浏览器无构建 bundle，不能直接 import；这里用最小解析提取两个对象字面量。
 *
 * 运行：node tests/locale-parity.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function extractObject(name) {
  const marker = `const ${name} = {`
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `找不到 ${name}`)
  const brace = source.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') i += 1
        else if (source[i] === quote) break
        i += 1
      }
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        return new Function(`"use strict"; return (${source.slice(brace, i + 1)})`)()
      }
    }
  }
  throw new Error(`无法解析 ${name}`)
}

const zh = extractObject('ZH')
const en = extractObject('EN')
const zhKeys = Object.keys(zh).sort()
const enKeys = Object.keys(en).sort()
const missingInEn = zhKeys.filter((key) => !(key in en))
const extraInEn = enKeys.filter((key) => !(key in zh))
const emptyValues = [...zhKeys, ...enKeys].filter((key) => {
  const value = key in zh ? zh[key] : en[key]
  return typeof value !== 'string' || value.trim().length === 0
})

assert.deepEqual(missingInEn, [], `EN 缺少 key: ${missingInEn.join(', ')}`)
assert.deepEqual(extraInEn, [], `EN 多出 key: ${extraInEn.join(', ')}`)
assert.deepEqual(emptyValues, [], `空文案: ${emptyValues.join(', ')}`)

console.log(`locale parity ok: ${zhKeys.length} keys in zh/en`)
