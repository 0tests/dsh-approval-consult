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
  // 单函数测试隔离宿主日志；完整的刷新/路由交互另由 security-lifecycle.mjs 覆盖。
  return vm.runInNewContext(`(${src.slice(start, end)})`, { ...helpers, refreshReconstructed: (record) => record, ...env })
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
  // 参数已知且明确不一致：即使理由文字命中也不复用（理由不能替代调用身份）。
  const reasonHit = review('shell', { command: 'echo x' }, 'A')
  reasonHit.decision.reason = '这条命令会不可逆地删除工作区之外的文件，需要人工确认'
  state.reviews = new Map([['A', [reasonHit]]])
  assert.equal(
    match('A', 'shell', { args: { command: 'other' } }, `Auto review denied tool "shell": ${reasonHit.decision.reason}`),
    null,
  )
  // 参数未知时，才允许用「理由原样命中」作为弱证据。
  state.reviews = new Map([['A', [reasonHit]]])
  assert.equal(
    match('A', 'shell', undefined, `Auto review denied tool "shell": ${reasonHit.decision.reason}`),
    reasonHit,
  )
  check('matchReview: 参数冲突一律不复用；参数未知时才用理由命中；跨 session 不复用')
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
    refreshReconstructed: (record) => record,
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

// 5) 重新评估失败后重试：新输出不得被旧缓冲污染
{
  let calls = 0
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
          if (calls === 1) {
            yield { type: 'text-delta', text: '{"risk":' }
            throw new Error('connection interrupted')
          }
          yield { type: 'text-delta', text: '{"risk":"high","decision":"deny"}' }
        },
      },
    },
    noteError: () => {},
    friendlySideCallError: String,
  })
  await classify({ resolvedAt: null })
  assert.equal(rev.decision, null)
  assert.match(String(rev.error), /connection interrupted/)
  await classify({ resolvedAt: null })
  assert.equal(rev.text, '{"risk":"high","decision":"deny"}')
  assert.equal(rev.decision?.decision, 'deny')
  assert.equal(rev.error, null)
  check('classifyAdvisoryReview: 失败重试使用独立缓冲，正常结果可解析')
}

// 6) 上传跨过审批结束边界：不登记、不可再读
{
  const record = { key: 'ac:test', sessionId: 'A', resolvedAt: null }
  const state = {
    attachments: new Map(),
    attachmentPending: new Map(),
    pendings: new Map([[record.key, record]]),
    jobs: new Map(),
    stats: { attachments: 0 },
  }
  const cfg = { attachmentsEnabled: true, maxAttachmentBytes: 1024, maxAttachmentsPerConsult: 3 }
  const attachmentsForConsult = (key) => [...state.attachments.values()].filter((x) => x.consultKey === key)
  const pendingAttachmentCount = (key) => state.attachmentPending.get(key) ?? 0
  const reserveAttachmentSlot = (key) => {
    const existing = attachmentsForConsult(key).length
    const pending = pendingAttachmentCount(key)
    if (existing + pending >= cfg.maxAttachmentsPerConsult) throw httpError(413, 'attachment-too-many', 'too many')
    state.attachmentPending.set(key, pending + 1)
  }
  const releaseAttachmentSlot = (key) => {
    const pending = pendingAttachmentCount(key)
    if (pending <= 1) state.attachmentPending.delete(key)
    else state.attachmentPending.set(key, pending - 1)
  }
  const registerAttachment = fn('registerAttachment', { state, cfg, httpError, attachmentsForConsult })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let response = null
  let imageRead = false
  let query = new URLSearchParams('sessionId=A&consultKey=ac:test&mediaType=image/png')
  const marker = 'route(`${ROUTE_PREFIX}/attachment`, '
  const start = src.indexOf(marker) + marker.length
  const end = src.indexOf('\n      }),', start) + '\n      }'.length
  const handler = vm.runInNewContext(`(${src.slice(start, end)})`, {
    refreshReconstructed: (record) => record,
    state,
    cfg,
    httpError,
    queryOf: () => query,
    pickAttachmentMediaType: helpers.pickAttachmentMediaType,
    resolvePending: () => record,
    readBinaryBody: async () => {
      await gate
      return Buffer.from('mock image')
    },
    MAX_ATTACHMENT_BODY_BYTES: 1024,
    sanitizeAttachmentName: helpers.sanitizeAttachmentName,
    attachmentStore: {
      saveImage: async () => ({ mediaType: 'image/png' }),
      readImage: async () => {
        imageRead = true
        return { data: Buffer.from('mock'), ref: { mediaType: 'image/png' } }
      },
    },
    registerAttachment,
    reserveAttachmentSlot,
    releaseAttachmentSlot,
    attachmentMeta: (item) => ({ id: item.id, mediaType: 'image/png' }),
    sendJson: (_res, status, body) => {
      response = { status, body }
    },
    sendImage: () => {},
  })
  const upload = handler({ method: 'POST', headers: {} }, {})
  record.resolvedAt = Date.now() // 上传等待请求体期间审批结束
  release()
  await assert.rejects(upload, (e) => e.status === 409)
  assert.equal(state.attachments.size, 0)
  // 即使手工塞入引用，审批结束后 GET 也必须失效
  state.attachments.set('att:x', { id: 'att:x', ref: { mediaType: 'image/png' }, consultKey: record.key, expiresAt: Date.now() + 60_000 })
  query = new URLSearchParams({ id: 'att:x', consultKey: record.key })
  await assert.rejects(handler({ method: 'GET' }, {}), (e) => e.status === 404)
  assert.equal(imageRead, false)
  check('附件上传：审批结束边界后不登记；已结束审批的引用不可读')
}

// 7) 从日志重建的审批记录：命中缓存时同步结果并执行统一清理
{
  const record = {
    key: 're:1',
    reconstructed: true,
    approvalId: 'ap:1',
    sessionId: 'A',
    resolvedAt: null,
    outcome: null,
    jobs: new Set(),
    threads: { executor: [], reviewer: [] },
    relays: [],
    review: null,
    advisoryReview: null,
  }
  const state = {
    pendings: new Map([[record.key, record]]),
    pendingBySession: new Map([['A', [record.key]]]),
    jobs: new Map(),
    attachments: new Map([['att:1', { consultKey: record.key }]]),
    stats: {},
  }
  const dropAttachments = (key) => {
    for (const [id, item] of [...state.attachments]) {
      if (item.consultKey === key) state.attachments.delete(id)
    }
  }
  const finalizePending = fn('finalizePending', { state, dropAttachments, log: { info() {} }, noteError() {} })
  const agent = {
    session: {
      snapshotEvents: () => [{ type: 'approval/decided', data: { id: 'ap:1', outcome: 'deny' } }],
    },
  }
  const refreshReconstructed = fn('refreshReconstructed', {
    finalizePending,
    liveAgentBySessionId: () => agent,
    noteError() {},
  })
  const resolvePending = fn('resolvePending', {
    state,
    refreshReconstructed,
    reconstructPending: () => null,
  })
  const found = resolvePending({ consultKey: 're:1' })
  assert.equal(found, record)
  assert.notEqual(record.resolvedAt, null)
  assert.equal(record.outcome, 'deny')
  assert.equal(state.attachments.size, 0)
  check('重建记录命中缓存时同步审批结果，并统一执行结束清理')
}

console.log(`\nsecurity regression ok: ${passed} 项`)
