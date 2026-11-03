// 安全回归：2026-11-03 安全审查四项缺陷（源码级隔离检查，不联网、不写盘）。
// 覆盖：审查记录关联、带图提问并发、重新评估去重、附件超额先拒。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const root = process.argv[2] || fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(`${root}/lib/impl.js`, 'utf8').replaceAll('\r\n', '\n')
const { __test: helpers } = await import(pathToFileURL(`${root}/lib/impl.js`))
function fn(name, env) {
  const start = src.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'))
  assert.ok(start >= 0, `missing ${name}`)
  const end = src.indexOf('\n  }', start) + 4
  return vm.runInNewContext(`(${src.slice(start, end)})`, { ...helpers, ...env })
}
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code })
const review = (name, args, sessionId) => ({ sessionId, claimedBy: null, error: null, action: { name, arguments: args }, decision: { risk: 'low', decision: 'allow' }, at: Date.now() })
let passed = 0
const check = (label) => {
  passed += 1
  console.log(`  ok  ${label}`)
}

// 1) matchReview 只接受可验证关联
{
  const stale = review('shell', { command: 'echo harmless' }, 'A')
  const state = { reviews: new Map([['A', [stale]]]) }
  const match = fn('matchReview', { state })
  assert.equal(match('A', 'shell', { args: { command: 'destructive-operation-placeholder' } }, ''), null)
  const same = review('shell', { command: 'echo same' }, 'A')
  state.reviews = new Map([['A', [same]]])
  assert.equal(match('A', 'shell', { args: { command: 'echo same' } }, ''), same)
  const other = review('shell', { command: 'echo same' }, 'B')
  state.reviews = new Map([['A', [review('different-tool', {}, 'A')]], ['B', [other]]])
  assert.equal(match('A', 'shell', { args: { command: 'echo same' } }, ''), null)
  const reasonHit = review('shell', { command: 'echo x' }, 'A')
  reasonHit.decision.reason = '这条命令会不可逆地删除工作区之外的文件，需要人工确认'
  state.reviews = new Map([['A', [reasonHit]]])
  assert.equal(
    match('A', 'shell', { args: { command: 'other' } }, `Auto review denied tool "shell": ${reasonHit.decision.reason}`),
    reasonHit,
  )
  check('matchReview: 参数不一致 / 跨 session 不复用，参数一致或理由命中才复用')
}

// 2) startAsk 并发名额（await 之后复核）
{
  let seq = 0
  let started = 0
  const record = { key: 'ac:test', sessionId: 'A', resolvedAt: null, jobs: new Set(), threads: { executor: [], reviewer: [] } }
  const state = { mainRequests: new Map([['A', {}]]), jobs: new Map(), stats: { asks: 0 } }
  const start = fn('startAsk', {
    state,
    cfg: { maxQuestionChars: 2000, maxConcurrentJobs: 3, attachmentsEnabled: true, maxAttachmentsPerAsk: 3, maxAskImageBytes: 1000 },
    resolvePending: () => record,
    httpError,
    attachmentStore: {},
    resolveAttachments: () => [{ ref: { bytes: 1 } }],
    attachmentCapabilities: async () => ({ executor: true }),
    attachmentMeta: () => ({}),
    nextSeq: () => ++seq,
    AbortController,
    runJob: () => {
      started += 1
    },
  })
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => start({ question: 'test', attachmentIds: ['att:test'] })))
  const ok = results.filter((r) => r.status === 'fulfilled').length
  const rejected = results.filter((r) => r.status === 'rejected' && r.reason?.status === 429).length
  assert.equal(started, 3)
  assert.equal(ok, 3)
  assert.equal(rejected, 9)
  check('startAsk: maxConcurrentJobs=3 时 12 个并发带图提问只放行 3 个')
}

// 3) classifyAdvisoryReview 去重进行中的评估
{
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const rev = { decision: null, options: {}, text: '', error: null }
  const classify = fn('classifyAdvisoryReview', {
    ensureAdvisoryReview: () => rev,
    httpError,
    AbortController,
    setTimeout,
    clearTimeout,
    state: { sideOptions: new WeakSet(), stats: { sideCalls: 0 } },
    ctx: {
      llm: {
        stream: async function* () {
          calls += 1
          await gate
          yield { type: 'text-delta', text: '{"risk":"low","decision":"allow"}' }
        },
      },
    },
    noteError: () => {},
    friendlySideCallError: String,
  })
  const pending = Array.from({ length: 12 }, () => classify({}))
  assert.equal(calls, 1)
  release()
  const out = await Promise.all(pending)
  assert.ok(out.every((r) => r.review === rev))
  assert.equal(rev.decision?.decision, 'allow')
  check('classifyAdvisoryReview: 12 个并发重新评估共享 1 个模型流')
}

// 4) 附件超额：saveImage 之前拒绝
{
  const state = { attachments: new Map([['existing', { consultKey: 'ac:test' }]]), attachmentPending: new Map(), stats: { attachments: 0 } }
  const attachmentsForConsult = (key) => [...state.attachments.values()].filter((x) => x.consultKey === key)
  const pendingAttachmentCount = (key) => state.attachmentPending.get(key) ?? 0
  const reserveAttachmentSlot = (key) => {
    const existing = attachmentsForConsult(key).length
    const pending = pendingAttachmentCount(key)
    if (existing + pending >= 1) throw httpError(413, 'attachment-too-many', 'too many')
    state.attachmentPending.set(key, pending + 1)
  }
  const releaseAttachmentSlot = (key) => {
    const pending = pendingAttachmentCount(key)
    if (pending <= 1) state.attachmentPending.delete(key)
    else state.attachmentPending.set(key, pending - 1)
  }
  const registerAttachment = fn('registerAttachment', { state, cfg: { maxAttachmentsPerConsult: 1 }, httpError, attachmentsForConsult })
  let saved = 0
  const marker = 'route(`${ROUTE_PREFIX}/attachment`, '
  const start = src.indexOf(marker) + marker.length
  const end = src.indexOf('\n      }),', start) + '\n      }'.length
  const handler = vm.runInNewContext(`(${src.slice(start, end)})`, {
    state,
    cfg: { attachmentsEnabled: true, maxAttachmentBytes: 1024 },
    httpError,
    queryOf: () => new URLSearchParams('sessionId=A&consultKey=ac:test&mediaType=image/png'),
    pickAttachmentMediaType: helpers.pickAttachmentMediaType,
    resolvePending: () => ({ key: 'ac:test', sessionId: 'A', resolvedAt: null }),
    readBinaryBody: async () => Buffer.from('mock image'),
    MAX_ATTACHMENT_BODY_BYTES: 1024,
    sanitizeAttachmentName: helpers.sanitizeAttachmentName,
    attachmentStore: {
      saveImage: async () => {
        saved += 1
        return {}
      },
    },
    registerAttachment,
    reserveAttachmentSlot,
    releaseAttachmentSlot,
  })
  for (let i = 0; i < 5; i += 1) await assert.rejects(handler({ method: 'POST', headers: {} }, {}), (e) => e.status === 413)
  assert.equal(saved, 0)
  check('附件上传：名额已满时在 saveImage 之前拒绝，不消耗存储')
}

console.log(`\nsecurity regression ok: ${passed} 项`)
