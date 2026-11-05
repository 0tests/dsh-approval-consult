/**
 * 离线单元测试：只测 impl.js 里导出的纯函数（不启动 DSH）。
 * 运行：node tests/unit.mjs
 */

import assert from 'node:assert/strict'
import { __test } from '../lib/impl.js'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.error(`  FAIL ${name}`)
    console.error(`       ${error.message}`)
  }
}

/* -------------------------------------------------------------------------- */
/* reviewSection / parsePendingAction                                          */
/* -------------------------------------------------------------------------- */

const reviewUserText = [
  'ENVIRONMENT',
  '{"cwd":"D:\\\\ZeroWork"}',
  'PROJECT_INSTRUCTIONS',
  '[]',
  'FILTERED_HISTORY',
  '[{"kind":"user-message","role":"human-instruction"},{"kind":"tool-call","role":"fact"}]',
  'PENDING_ACTION',
  JSON.stringify({ mode: 'native', name: 'pwsh', description: 'Run PowerShell', parameters: { type: 'object' }, arguments: { command: 'Get-ChildItem' } }),
].join('\n\n')

test('reviewSection 取到 ENVIRONMENT', () => {
  assert.equal(__test.reviewSection(reviewUserText, 'ENVIRONMENT'), '{"cwd":"D:\\\\ZeroWork"}')
})

test('reviewSection 取到 PENDING_ACTION', () => {
  const section = __test.reviewSection(reviewUserText, 'PENDING_ACTION')
  assert.ok(section.startsWith('{"mode":"native"'))
})

test('reviewSection 缺失段返回空串', () => {
  assert.equal(__test.reviewSection('nothing here', 'PENDING_ACTION'), '')
})

test('parsePendingAction 解析 native', () => {
  const action = __test.parsePendingAction(reviewUserText)
  assert.equal(action.mode, 'native')
  assert.equal(action.name, 'pwsh')
  assert.deepEqual(action.arguments, { command: 'Get-ChildItem' })
})

test('parsePendingAction 解析 PTC（arguments 是 JSON 字符串）', () => {
  const text = [
    'ENVIRONMENT',
    '{}',
    'PROJECT_INSTRUCTIONS',
    '[]',
    'FILTERED_HISTORY',
    '[]',
    'PENDING_ACTION',
    JSON.stringify({ mode: 'ptc-inner', name: 'write', arguments: '{"path":"a.txt"}' }),
  ].join('\n\n')
  const action = __test.parsePendingAction(text)
  assert.equal(action.mode, 'ptc-inner')
  assert.equal(action.name, 'write')
  assert.deepEqual(__test.normalizeArguments(action.arguments), { path: 'a.txt' })
})

test('parsePendingAction 非法 JSON 返回 null', () => {
  const text = 'ENVIRONMENT\n\n{}\n\nPROJECT_INSTRUCTIONS\n\n[]\n\nFILTERED_HISTORY\n\n[]\n\nPENDING_ACTION\n\n{not json'
  assert.equal(__test.parsePendingAction(text), null)
})

/* -------------------------------------------------------------------------- */
/* parseReviewDecision                                                         */
/* -------------------------------------------------------------------------- */

test('parseReviewDecision 标准 JSON', () => {
  assert.deepEqual(__test.parseReviewDecision('{"risk":"low","decision":"allow"}'), { risk: 'low', decision: 'allow' })
})

test('parseReviewDecision 带 reason', () => {
  assert.deepEqual(__test.parseReviewDecision('{"risk":"medium","decision":"deny","reason":"需要确认"}'), {
    risk: 'medium',
    decision: 'deny',
    reason: '需要确认',
  })
})

test('parseReviewDecision 容忍前后文本/代码块', () => {
  assert.deepEqual(__test.parseReviewDecision('思考一下\n```json\n{"risk":"high","decision":"deny"}\n```'), {
    risk: 'high',
    decision: 'deny',
  })
})

test('parseReviewDecision 缺字段返回 null', () => {
  assert.equal(__test.parseReviewDecision('{"risk":"low"}'), null)
  assert.equal(__test.parseReviewDecision('plain text'), null)
  assert.equal(__test.parseReviewDecision(''), null)
})

/* -------------------------------------------------------------------------- */
/* canonicalJson / normalizeArguments                                          */
/* -------------------------------------------------------------------------- */

test('canonicalJson 键顺序无关', () => {
  assert.equal(__test.canonicalJson({ a: 1, b: [2, { c: 3, d: 4 }] }), __test.canonicalJson({ b: [2, { d: 4, c: 3 }], a: 1 }))
})

test('canonicalJson 区分不同类型', () => {
  assert.notEqual(__test.canonicalJson({ a: '1' }), __test.canonicalJson({ a: 1 }))
})

test('canonicalJson 处理循环引用', () => {
  const value = { name: 'x' }
  value.self = value
  assert.ok(__test.canonicalJson(value).includes('[[cycle]]'))
})

test('normalizeArguments 解析 JSON 字符串', () => {
  assert.deepEqual(__test.normalizeArguments('{"a":1}'), { a: 1 })
  assert.deepEqual(__test.normalizeArguments('  '), {})
  assert.deepEqual(__test.normalizeArguments('not-json'), { __raw: 'not-json' })
  assert.deepEqual(__test.normalizeArguments(undefined), {})
})

/* -------------------------------------------------------------------------- */
/* 请求识别                                                                    */
/* -------------------------------------------------------------------------- */

test('looksLikeReviewRequest：system 以 REVIEW_POLICY 开头', () => {
  assert.equal(__test.looksLikeReviewRequest({ system: 'REVIEW_POLICY\nYou are...', messages: [{ role: 'user', content: [] }] }), true)
  assert.equal(__test.looksLikeReviewRequest({ system: 'You are helpful', messages: [] }), false)
  assert.equal(__test.looksLikeReviewRequest({ messages: [] }), false)
})

test('looksLikeMainRequest：无 system 字段 + 首条 system + tools', () => {
  const messages = [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }, { role: 'user', content: [] }]
  assert.equal(__test.looksLikeMainRequest({ sessionId: 's1', messages, tools: [] }), true)
  assert.equal(__test.looksLikeMainRequest({ sessionId: 's1', messages, tools: [], system: 'x' }), false)
  assert.equal(__test.looksLikeMainRequest({ messages, tools: [] }), false)
  assert.equal(__test.looksLikeMainRequest({ sessionId: 's1', messages }), false)
})

/* -------------------------------------------------------------------------- */
/* 其他                                                                        */
/* -------------------------------------------------------------------------- */

test('intIn 边界', () => {
  assert.equal(__test.intIn(undefined, 5, 1, 10), 5)
  assert.equal(__test.intIn('7.9', 5, 1, 10), 7)
  assert.equal(__test.intIn(-3, 5, 1, 10), 1)
  assert.equal(__test.intIn(99, 5, 1, 10), 10)
})

test('clip 截断与保持', () => {
  assert.equal(__test.clip('abcdef', 10), 'abcdef')
  assert.equal(__test.clip('abcdef', 4), 'abc…')
  assert.equal(__test.clip(null, 4), '')
})

test('summaryLine 折叠换行并截断', () => {
  assert.equal(__test.summaryLine('a\nb   c'), 'a b c')
  const long = 'x'.repeat(200)
  assert.ok(__test.summaryLine(long).length <= 120)
  assert.ok(__test.summaryLine(long).endsWith('…'))
})

test('normalizePresets 缺省/自定义/非法', () => {
  const defaults = __test.normalizePresets(undefined)
  assert.equal(defaults.executor.length, 5)
  assert.equal(defaults.reviewer.length, 5)
  const custom = __test.normalizePresets({ executor: [' 自定义一 ', '', 42, '自定义二'] })
  assert.deepEqual(custom.executor, ['自定义一', '自定义二'])
  const invalid = __test.normalizePresets({ executor: 'nope', reviewer: [] })
  assert.equal(invalid.executor.length, 5)
  assert.equal(invalid.reviewer.length, 5)
})

test('normalizeTimeoutAutoPause 缺省 on-send / 合法值 / false→off', () => {
  assert.equal(__test.normalizeTimeoutAutoPause(undefined), 'on-send')
  assert.equal(__test.normalizeTimeoutAutoPause('on-open'), 'on-open')
  assert.equal(__test.normalizeTimeoutAutoPause('off'), 'off')
  assert.equal(__test.normalizeTimeoutAutoPause(false), 'off')
  assert.equal(__test.normalizeTimeoutAutoPause('bogus'), 'on-send')
})

test('normalizeReviewerMode 缺省 auto / 合法值 / 布尔映射', () => {
  assert.equal(__test.normalizeReviewerMode(undefined), 'auto')
  assert.equal(__test.normalizeReviewerMode('on'), 'on')
  assert.equal(__test.normalizeReviewerMode('off'), 'off')
  assert.equal(__test.normalizeReviewerMode(true), 'on')
  assert.equal(__test.normalizeReviewerMode(false), 'off')
  assert.equal(__test.normalizeReviewerMode('bogus'), 'auto')
})

test('插件检测按名字匹配 auto-review / approval-timeout', () => {
  assert.equal(__test.isAutoReviewPluginName('experimental-auto-review'), true)
  assert.equal(__test.isAutoReviewPluginName('auto-review'), true)
  assert.equal(__test.isAutoReviewPluginName('approve'), false)
  assert.equal(__test.isAutoReviewPluginName(undefined), false)
  assert.equal(__test.isTimeoutPluginName('dsh-approval-timeout'), true)
  assert.equal(__test.isTimeoutPluginName('approval-timeout'), true)
  assert.equal(__test.isTimeoutPluginName('timeout'), false)
  assert.equal(__test.isTimeoutPluginName(null), false)
})

test('从审批理由提取 auto-review 结论（拒绝/失败）', () => {
  const denied = __test.autoReviewVerdictFromReason('Auto review denied tool "edit": 改动第三方插件源码需要用户明确授权。')
  assert.deepEqual(denied, { kind: 'deny', toolName: 'edit', text: '改动第三方插件源码需要用户明确授权。' })
  const failed = __test.autoReviewVerdictFromReason('Auto review of tool "pwsh" failed; its body was not executed: TRANSPORT: Connection error')
  assert.deepEqual(failed, { kind: 'failed', toolName: 'pwsh', text: 'TRANSPORT: Connection error' })
  assert.equal(__test.autoReviewVerdictFromReason('普通审批理由'), null)
  assert.equal(__test.autoReviewVerdictFromReason(undefined), null)
  assert.equal(__test.autoReviewVerdictFromReason('Auto review denied tool "edit": '), null)
})

test('用户数据目录：显式/覆盖 > profile 目录 > --profile > 用户主目录兜底', () => {
  assert.equal(__test.resolveDataRoot({ DSH_APPROVAL_CONSULT_DATA: ' D:/custom/data ' }), 'D:/custom/data')
  assert.equal(__test.resolveDataRoot({}, [], 'C:/Users/me', ' D:/explicit '), 'D:/explicit')
  const fromProfile = __test.resolveDataRoot({ DSH_PROFILE_DIR: 'C:/Users/me/.dsh/profiles/web' })
  assert.ok(fromProfile.replace(/\\/g, '/').endsWith('profiles/web/data/approval-consult'))
  const fromArgv = __test.resolveDataRoot({}, ['node', 'bin.js', 'web', '--profile', 'work'], 'C:/Users/me')
  assert.ok(fromArgv.replace(/\\/g, '/').endsWith('.dsh/profiles/work/data/approval-consult'))
  const fallback = __test.resolveDataRoot({}, ['node', 'bin.js', 'web'], 'C:/Users/me')
  assert.ok(fallback.replace(/\\/g, '/').endsWith('.dsh-approval-consult'))
})

test('图片附件：文件名清洗 / MIME 白名单 / id 规整 / 字节估算', () => {
  assert.equal(__test.sanitizeAttachmentName('..\\..\\secret.png'), '.. .. secret.png')
  assert.equal(__test.sanitizeAttachmentName('  shot 01.png  '), 'shot 01.png')
  assert.equal(__test.sanitizeAttachmentName('a\u0000b\u001f.png'), 'ab.png')
  assert.equal(__test.sanitizeAttachmentName(''), '图片')
  assert.equal(__test.sanitizeAttachmentName('x'.repeat(200)).length, 118)
  assert.equal(__test.pickAttachmentMediaType('image/png'), 'image/png')
  assert.equal(__test.pickAttachmentMediaType(' IMAGE/JPEG '), 'image/jpeg')
  assert.equal(__test.pickAttachmentMediaType('image/webp'), 'image/webp')
  assert.equal(__test.pickAttachmentMediaType('image/gif'), 'image/gif')
  assert.equal(__test.pickAttachmentMediaType('image/heic'), null)
  assert.equal(__test.pickAttachmentMediaType('application/pdf'), null)
  assert.equal(__test.pickAttachmentMediaType(''), null)
  assert.equal(__test.pickAttachmentMediaType(undefined), null)
  assert.deepEqual(__test.clampAttachmentIds(['a', 'a', 'b', 'c', 'd'], 3), ['a', 'b', 'c'])
  assert.deepEqual(__test.clampAttachmentIds(['a', 1, null, ' ', 'b'], 5), ['a', 'b'])
  assert.deepEqual(__test.clampAttachmentIds('nope', 3), [])
  assert.equal(__test.estimateAttachmentBytes([{ bytes: 100 }, { ref: { bytes: 250 } }, { bytes: 'x' }]), 350)
  assert.equal(__test.estimateAttachmentBytes([]), 0)
  assert.equal(__test.normalizeAttachmentForReviewer('on'), 'on')
  assert.equal(__test.normalizeAttachmentForReviewer('off'), 'off')
  assert.equal(__test.normalizeAttachmentForReviewer('auto'), 'auto')
  assert.equal(__test.normalizeAttachmentForReviewer(true), 'on')
  assert.equal(__test.normalizeAttachmentForReviewer(false), 'off')
  assert.equal(__test.normalizeAttachmentForReviewer(undefined), 'auto')
})

/* -------------------------------------------------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.name}\n${failure.error.stack}`)
  }
  process.exitCode = 1
}
