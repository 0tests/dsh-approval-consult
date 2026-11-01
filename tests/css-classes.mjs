#!/usr/bin/env node
/**
 * CSS/JSX 一致性检查：
 * 找出 client.js 里所有「按状态条件挂上的 class」（形如 `ac-x${cond ? ' ac-x-open' : ''}`），
 * 确认每个 class 都能在同一个文件的内置 CSS 里找到样式规则。
 *
 * 起因：2026-11-02 用户反馈「执行 AI 的说明 / 审查理由」点展开文字变成「收起」但内容不动——
 * 根因是 JSX 挂了 `ac-note-text-open`，CSS 里却没有这条规则（漏写）。这类 bug 机器能查出来，
 * 所以固化成测试，避免下次再加开关时又漏样式。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/** 只有状态语义、不需要专属样式的 class（结构变化由条件渲染负责）。 */
const KNOWN_STYLELESS = new Set([
  'ac-context-open', // 展开态只控制 body 是否渲染
  'ac-presets-collapsed', // 折叠态只控制 chips 是否渲染
  'ac-turn-error', // 失败态由 .ac-error-block 呈现
  'ac-reduced', // 减少动效由 @media (prefers-reduced-motion) 处理，不需要专属规则
])

/** 提取 `const CSS = \`...\`` 这一段模板字符串的内容。 */
function extractCss(text) {
  const marker = 'const CSS = `'
  const start = text.indexOf(marker)
  if (start < 0) throw new Error('client.js: 找不到 CSS 常量')
  const bodyStart = start + marker.length
  let index = bodyStart
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2
      continue
    }
    const closing = text.indexOf('`', index)
    if (closing < 0) throw new Error('client.js: CSS 模板字符串没有闭合')
    // CSS 里不会有反引号；第一个出现的反引号就是结尾。
    return text.slice(bodyStart, closing)
  }
  throw new Error('client.js: CSS 模板字符串没有闭合')
}

/** CSS 里定义过的 .ac-* 选择器。 */
function collectDefinedClasses(css) {
  const defined = new Set()
  for (const match of css.matchAll(/\.(ac-[a-z0-9-]+)/g)) defined.add(match[1])
  return defined
}

/** 所有 className 模板里按条件挂上的 `' ac-*'` 片段。 */
function collectConditionalClasses(text) {
  const collected = new Map() // class -> 首次出现行号
  const classNameTemplate = /className:\s*`([^`]*)`/g
  for (const match of text.matchAll(classNameTemplate)) {
    const template = match[1]
    const line = text.slice(0, match.index).split('\n').length
    for (const expression of template.matchAll(/\$\{([^}]*)\}/g)) {
      for (const literal of expression[1].matchAll(/' (ac-[a-z0-9-]+)'/g)) {
        if (!collected.has(literal[1])) collected.set(literal[1], line)
      }
    }
  }
  return collected
}

const css = extractCss(source)
const defined = collectDefinedClasses(css)
const conditional = collectConditionalClasses(source)

const problems = []
for (const [name, line] of conditional) {
  if (defined.has(name) || KNOWN_STYLELESS.has(name)) continue
  problems.push(`lib/client.js:${String(line)} 条件 class "${name}" 在 CSS 里没有定义（可能漏了样式）`)
}

// 回归护栏：这次修复的具体类必须有样式，防止被误删。
if (!defined.has('ac-note-text-open')) {
  problems.push('CSS 缺少 .ac-note-text-open（「执行 AI 的说明」展开态会再次失效）')
}

if (problems.length > 0) {
  console.error('css-classes: FAILED')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`css-classes ok: ${conditional.size} 个条件 class 均有样式或已登记为无语义样式`)
