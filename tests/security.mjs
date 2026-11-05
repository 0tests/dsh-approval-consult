// 安全回归：2026-11-03 安全审查四项缺陷（源码级隔离检查，不联网、不写盘）。
// 覆盖：审查记录关联、带图提问并发、重新评估去重、附件超额先拒。
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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
  return vm.runInNewContext(`(${src.slice(start, end)})`, {
    ...helpers,
    refreshReconstructed: (record) => record,
    randomUUID,
    MAX_THREADS_PER_RECORD: 200,
    MAX_REVIEW_ATTEMPTS: 5,
    MAX_RELAYS_PER_RECORD: 5,
    MAX_PENDING_AGE_MS: 24 * 60 * 60 * 1000,
    ATTACHMENT_BYTES_PER_CONSULT: 24 * 1024 * 1024,
    ...env,
  })
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
    eventsForSession: () => agent.session.snapshotEvents(),
    noteError() {},
  })
  const resolvePending = fn('resolvePending', {
    state,
    refreshReconstructed,
    reconstructPending: () => null,
  })
  const found = resolvePending({ consultKey: 're:1', sessionId: 'A' })
  assert.equal(found, record)
  assert.notEqual(record.resolvedAt, null)
  assert.equal(record.outcome, 'deny')
  assert.equal(state.attachments.size, 0)
  check('重建记录命中缓存时同步审批结果，并统一执行结束清理')
}

// 8) consultKey 顺序编号：显式 sessionId 不一致时不得返回别的会话记录
{
  const record = { key: 'ac:1', sessionId: 'A', resolvedAt: null, reconstructed: false }
  const state = { pendings: new Map([[record.key, record]]), pendingBySession: new Map([['A', [record.key]]]) }
  const resolvePending = fn('resolvePending', { state, refreshReconstructed: (item) => item, reconstructPending: () => null })
  assert.equal(resolvePending({ consultKey: 'ac:1', sessionId: 'B' }), null)
  assert.equal(resolvePending({ consultKey: 'ac:1', sessionId: 'A' }), record)
  check('resolvePending: 跨会话 consultKey 访问被拒绝')
}

// 9) job id 顺序编号：poll 带 consultKey 时必须与任务归属一致
{
  const job = { id: 'j:1', consultKey: 'ac:1', target: 'executor', threadId: 'q:1', status: 'streaming', text: 'abc', cursor: 0, question: 'q', usage: null, error: null, createdAt: Date.now(), finishedAt: null }
  const state = { jobs: new Map([[job.id, job]]), pendings: new Map() }
  const buildPollResponse = fn('buildPollResponse', { state, httpError, refreshReconstructed: (item) => item })
  assert.throws(() => buildPollResponse({ jobId: 'j:1', consultKey: 'ac:2' }), (error) => error.status === 404)
  const ok = buildPollResponse({ jobId: 'j:1', consultKey: 'ac:1', cursor: 0 })
  assert.equal(ok.delta, 'abc')
  check('poll: consultKey 不匹配的 job 不可读')
}

// 10) 线程数上限：顺序提问不能无限撑大内存
{
  let seq = 0
  const record = {
    key: 'ac:1',
    sessionId: 'A',
    resolvedAt: null,
    jobs: new Set(),
    threads: { executor: Array.from({ length: 200 }, (_, i) => ({ id: `q:${i}`, status: 'done' })), reviewer: [] },
  }
  const state = { mainRequests: new Map([['A', {}]]), jobs: new Map(), stats: { asks: 0 } }
  const startAsk = fn('startAsk', {
    state,
    cfg: { maxQuestionChars: 2000, maxConcurrentJobs: 3, attachmentsEnabled: false, maxAttachmentsPerAsk: 3, maxAskImageBytes: 0 },
    resolvePending: () => record,
    httpError,
    nextSeq: () => ++seq,
    AbortController,
    runJob: () => {},
  })
  await assert.rejects(startAsk({ question: 'x' }), (error) => error.status === 429 && error.code === 'thread-limit')
  check('startAsk: 单审批 200 条问答上限生效')
}

// 11) 附件累计字节预算：张数没超但总量超限也拒绝
{
  const state = { attachments: new Map([['att:old', { consultKey: 'ac:1', ref: { bytes: 20 * 1024 * 1024 } }]]), attachmentPending: new Map(), stats: { attachments: 0 } }
  const attachmentsForConsult = (key) => [...state.attachments.values()].filter((item) => item.consultKey === key)
  const registerAttachment = fn('registerAttachment', { state, cfg: { maxAttachmentsPerConsult: 3 }, httpError, attachmentsForConsult })
  assert.throws(
    () => registerAttachment({ bytes: 8 * 1024 * 1024 }, 'ac:1', 'A'),
    (error) => error.status === 413 && error.code === 'attachment-budget-exceeded',
  )
  check('附件：单审批累计字节预算生效')
}

// 12) 省略 sessionId 不能绕过 consultKey 归属校验（安全审计 2026-11-05 的 omission 绕过）
{
  const record = { key: 'ac:1', sessionId: 'A', resolvedAt: null, reconstructed: false }
  const state = { pendings: new Map([[record.key, record]]), pendingBySession: new Map([['A', [record.key]]]) }
  const resolvePending = fn('resolvePending', { state, refreshReconstructed: (item) => item, reconstructPending: () => null })
  assert.equal(resolvePending({ consultKey: 'ac:1' }), null)
  assert.equal(resolvePending({ consultKey: 'ac:1', sessionId: 'B' }), null)
  assert.equal(resolvePending({ consultKey: 'ac:1', sessionId: 'A' }), record)
  check('resolvePending: 省略/错误 sessionId 均不能读取 consultKey')
}

// 13) poll 不带 consultKey 视为不存在（job id 不是能力凭证）
{
  const job = { id: 'j:1', consultKey: 'ac:1', target: 'executor', threadId: 'q:1', status: 'done', text: 'abc', question: 'q', usage: null, error: null, createdAt: Date.now(), finishedAt: null }
  const state = { jobs: new Map([[job.id, job]]), pendings: new Map() }
  const buildPollResponse = fn('buildPollResponse', { state, httpError, refreshReconstructed: (item) => item })
  assert.throws(() => buildPollResponse({ jobId: 'j:1' }), (error) => error.status === 404)
  check('poll: 缺少 consultKey 时拒绝')
}

// 14) /relay 只允许转达服务端已保存的审查回答，且有次数上限
{
  let injected = 0
  const record = {
    key: 'ac:1',
    sessionId: 'A',
    resolvedAt: null,
    toolName: 'shell',
    threads: {
      executor: [],
      reviewer: [{ id: 'q:1', status: 'done', answer: '服务端保存的回答', truncated: false, relayedAt: null }],
    },
    relays: [],
  }
  const env = {
    resolvePending: () => record,
    httpError,
    liveAgent: () => ({ inject: () => { injected += 1 } }),
    describePendingForPrompt: () => '',
    makeInjectedMessage: (body) => ({ body }),
    summaryLine: (text) => text,
    INJECT_SOURCE_KIND: 'approval-consult',
    state: { stats: { injections: 0 } },
    MAX_RELAYS_PER_RECORD: 5,
  }
  const relay = fn('relayToExecutor', env)
  assert.throws(() => relay({ kind: 'reviewer', threadId: 'q:1', text: '伪造内容' }), (error) => error.status === 400)
  assert.throws(() => relay({ kind: 'reviewer', threadId: 'nope', text: '服务端保存的回答' }), (error) => error.status === 400)
  assert.throws(() => relay({ kind: 'bogus', threadId: 'q:1', text: 'x' }), (error) => error.status === 400)
  relay({ kind: 'reviewer', threadId: 'q:1', text: '服务端保存的回答' })
  assert.equal(injected, 1)
  assert.throws(() => relay({ kind: 'reviewer', threadId: 'q:1', text: '服务端保存的回答' }), (error) => error.status === 409)
  record.relays = Array.from({ length: 5 }, () => ({ kind: 'note', at: Date.now(), length: 1 }))
  assert.throws(() => relay({ kind: 'note', text: '又一条' }), (error) => error.status === 429)
  check('relay: 只转达已保存回答，伪造/重复/超额均拒绝')
}

// 15) 合成审查结论必须与当前工具名一致（理由文本不可信）
{
  const verdict = helpers.autoReviewVerdictFromReason('Auto review denied tool "shell": 危险')
  assert.equal(verdict?.toolName, 'shell')
  assert.equal(verdict?.kind, 'deny')
  assert.equal(helpers.autoReviewVerdictFromReason('Auto review denied tool "shell": 危险')?.toolName, 'shell')
  check('autoReviewVerdictFromReason: 提取工具名用于一致性校验')
}

console.log(`\nsecurity regression ok: ${passed} 项`)
