// 完整 apply()/路由回归：内存宿主、可控模型/存储和后台时钟，不联网、不写附件。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { apply } from '../lib/impl.js'

const STATE_KEY = '__DSH_APPROVAL_CONSULT_STATE_V1__'
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function host() {
  delete globalThis[STATE_KEY]
  const routes = new Map(), hooks = new Map(), intervals = new Map()
  const events = [], injections = []
  let snapshots = 0, saves = 0, reads = 0, disposed = false
  const session = {
    id: 'A', header: {}, surface: { nodes: [] },
    snapshotEvents: () => { snapshots++; return events },
    requestHeader: () => ({ config: { provider: 'mock', model: 'mock' }, tools: [] }),
  }
  const agent = { status: 'running', session, ctx: { on: () => () => {} }, inject: (m) => injections.push(m) }
  const llm = { resolveModelInfo: async () => ({ inputModalities: ['image'] }) }
  const storage = {
    save: async () => ({ mediaType: 'image/png', bytes: 4 }),
    read: async (ref) => ({ data: Buffer.from('mock'), ref }),
  }
  const ctx = {
    webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path) } },
    connection: { requestRejection: (req) => req.headers['x-test-deny'] ? 401 : undefined },
    agents: { get: (id) => id === 'A' ? agent : null, list: () => [agent] },
    sessions: {}, tools: {}, approval: {}, llm,
    on: (name, handler) => { hooks.set(name, handler); return () => hooks.delete(name) },
    inject: (_services, cb) => { cb(ctx); return { dispose() {} } },
    attachments: {
      saveImage: async (input) => { saves++; return storage.save(input) },
      readImage: async (ref) => { reads++; return storage.read(ref) },
    },
  }
  // 捕获真实实现注册的周期任务；手动推进时钟避免测试等待/计时抖动。
  const originalSetInterval = globalThis.setInterval, originalClearInterval = globalThis.clearInterval
  const fakeSetInterval = (callback, ms) => { const timer = { unref() {} }; intervals.set(timer, { callback, ms }); return timer }
  const fakeClearInterval = (timer) => intervals.delete(timer)
  function withClock(fn) {
    globalThis.setInterval = fakeSetInterval
    globalThis.clearInterval = fakeClearInterval
    try { return fn() } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  }
  const dispose = withClock(() => apply(ctx, { reviewerMode: 'on', maxAttachmentsPerConsult: 1 }, { log: { info() {}, warn() {}, error() {} } }))
  const begin = (suffix, method = 'GET', headers = {}) => {
    const req = Object.assign(new EventEmitter(), { url: `/dsh-approval-consult${suffix}`, method, headers, destroy() {} })
    const done = deferred()
    const res = {
      headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true },
      end(data) {
        const json = String(this.headers?.['content-type']).startsWith('application/json')
        done.resolve({ status: this.status, body: json ? JSON.parse(data) : data })
      },
      destroy() { done.resolve({ status: 0 }) },
    }
    const timeout = setTimeout(() => done.resolve({ status: -1, body: 'test timeout' }), 3000)
    const promise = done.promise.finally(() => clearTimeout(timeout))
    routes.get(req.url.split('?')[0])(req, res)
    return { promise, send: (body) => {
      req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)))
      req.emit('end')
    } }
  }
  const post = (path, body) => { const request = begin(path, 'POST'); request.send(body); return request.promise }
  const uploadUrl = (key) => `/attachment?sessionId=A&consultKey=${encodeURIComponent(key)}&mediaType=image/png`
  const imageUrl = (key, id) => `/attachment?sessionId=A&consultKey=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`
  return {
    begin, post, llm, storage, injections, uploadUrl, imageUrl,
    get saves() { return saves }, get reads() { return reads }, get snapshots() { return snapshots },
    get state() { return globalThis[STATE_KEY] },
    upload: (key) => post(uploadUrl(key), Buffer.from('mock')),
    async rebuild(id = '1') {
      events.push({ type: 'tool/call', data: { callId: id, name: 'shell', arguments: {} } })
      events.push({ type: 'approval/asked', data: { id, callId: id, toolName: 'shell' } })
      const r = await begin(`/context?sessionId=A&callId=${id}`).promise
      assert.equal(r.status, 200)
      assert.ok(r.body.consultKey.startsWith('re:'))
      return r.body.consultKey
    },
    decide: (id = '1') => events.push({ type: 'approval/decided', data: { id, outcome: 'rejected' } }),
    captureMain() {
      hooks.get('llm/stream')({ sessionId: 'A', provider: 'mock', model: 'mock', messages: [{ role: 'system', content: [{ type: 'text', text: 'test' }] }], tools: [] }, () => null)
    },
    tick() {
      const tasks = [...intervals.values()].filter((t) => t.ms <= 1000)
      assert.equal(tasks.length, 1, 'one bounded background refresh must be registered')
      tasks.forEach((t) => t.callback())
    },
    dispose() {
      if (disposed) return
      disposed = true
      withClock(dispose)
      assert.equal(intervals.size, 0, 'all background timers must be removed')
    },
  }
}

let passed = 0
async function test(name, fn) {
  const h = host()
  try { await fn(h); passed++; console.log(`  ok  ${name}`) } finally { h.dispose() }
}

await test('结束后直接 GET 图片，无需先请求 context', async (h) => {
  const key = await h.rebuild(), uploaded = await h.upload(key)
  assert.equal(uploaded.status, 200)
  const url = h.imageUrl(key, uploaded.body.attachment.id)
  assert.equal((await h.begin(url).promise).status, 200)
  h.decide()
  assert.equal((await h.begin(url).promise).status, 404)
  assert.equal(h.reads, 1)
  assert.equal(h.state.attachments.size, 0)
})

for (const stage of ['body', 'save']) {
  await test(`重建审批在 ${stage} 等待期间结束，上传不登记且释放名额`, async (h) => {
    const key = await h.rebuild()
    let response
    if (stage === 'body') {
      const request = h.begin(h.uploadUrl(key), 'POST')
      h.decide(); request.send(Buffer.from('mock')); response = await request.promise
    } else {
      const gate = deferred(), started = deferred()
      h.storage.save = async () => { started.resolve(); await gate.promise; return { mediaType: 'image/png' } }
      const upload = h.upload(key)
      await started.promise
      assert.equal((await h.upload(key)).status, 413)
      h.decide(); gate.resolve(); response = await upload
    }
    assert.equal(response.status, 409)
    assert.equal(h.saves, stage === 'body' ? 0 : 1)
    assert.equal(h.state.attachments.size, 0)
    assert.equal(h.state.attachmentPending.size, 0)
  })
}

await test('等待 readImage 期间结束，禁止发送已读字节', async (h) => {
  const key = await h.rebuild(), uploaded = await h.upload(key)
  const gate = deferred(), started = deferred()
  h.storage.read = async (ref) => { started.resolve(); await gate.promise; return { data: Buffer.from('mock'), ref } }
  const response = h.begin(h.imageUrl(key, uploaded.body.attachment.id)).promise
  await started.promise; h.decide(); gate.resolve()
  assert.equal((await response).status, 404)
})

await test('模型图片能力查询期间结束，不启动侧调用', async (h) => {
  const key = await h.rebuild(), uploaded = await h.upload(key)
  h.captureMain()
  const gate = deferred(), started = deferred()
  h.llm.resolveModelInfo = async () => { started.resolve(); await gate.promise; return { inputModalities: ['image'] } }
  const request = h.post('/ask', { consultKey: key, sessionId: 'A', question: 'test', attachmentIds: [uploaded.body.attachment.id] })
  await started.promise; h.decide(); gate.resolve()
  assert.equal((await request).status, 409)
  assert.equal(h.state.jobs.size, 0)
})

function abortableModel(h) {
  const started = deferred()
  let signal
  h.llm.stream = async function* (options) {
    signal = options.signal
    started.resolve()
    await new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  return { started: started.promise, get signal() { return signal } }
}

for (const trigger of ['poll', 'background']) {
  await test(`${trigger} 同步结束并取消运行中的回答`, async (h) => {
    const key = await h.rebuild()
    h.captureMain()
    const model = abortableModel(h)
    const ask = await h.post('/ask', { consultKey: key, sessionId: 'A', question: 'test' })
    assert.equal(ask.status, 200)
    await model.started
    h.decide()
    if (trigger === 'background') {
      h.tick()
      assert.equal(model.signal.aborted, true, 'background must cancel before any poll request')
    }
    const poll = await h.begin(`/poll?jobId=${ask.body.jobId}&consultKey=${encodeURIComponent(key)}`).promise
    assert.equal(poll.body.status, 'cancelled')
    assert.equal(model.signal.aborted, true)
    assert.equal(h.injections.length, 0)
  })
}

await test('没有客户端查询时，后台独立取消重新评估', async (h) => {
  const key = await h.rebuild(), model = abortableModel(h)
  const review = h.post('/review', { consultKey: key, sessionId: 'A' })
  await model.started
  h.decide(); h.tick()
  assert.equal(model.signal.aborted, true)
  assert.equal((await review).body.ok, false)
  assert.equal(h.state.pendings.get(key).advisoryReview.classifyController, null)
})

await test('模型先于下一次后台轮询返回，也不注入过期回答', async (h) => {
  const key = await h.rebuild(), gate = deferred()
  h.captureMain()
  h.llm.stream = async function* () { await gate.promise; yield { type: 'text-delta', text: 'mock' } }
  const ask = await h.post('/ask', { consultKey: key, sessionId: 'A', question: 'test' })
  h.decide(); gate.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.state.jobs.get(ask.body.jobId).status, 'cancelled')
  assert.equal(h.injections.length, 0)
})

await test('重新评估先于后台轮询返回，不接受审批结束后的结论', async (h) => {
  const key = await h.rebuild(), gate = deferred(), started = deferred()
  h.llm.stream = async function* () {
    started.resolve(); await gate.promise
    yield { type: 'text-delta', text: '{"risk":"low","decision":"allow"}' }
  }
  const review = h.post('/review', { consultKey: key, sessionId: 'A' })
  await started.promise; h.decide(); gate.resolve()
  assert.equal((await review).body.ok, false)
  assert.equal(h.state.pendings.get(key).advisoryReview.decision, null)
})

await test('同会话后台只读一次快照；不提前结束其它审批', async (h) => {
  const first = await h.rebuild('1'), second = await h.rebuild('2')
  h.decide('1')
  const before = h.snapshots
  h.tick()
  assert.equal(h.snapshots - before, 1)
  assert.notEqual(h.state.pendings.get(first).resolvedAt, null)
  assert.equal(h.state.pendings.get(second).resolvedAt, null)
  assert.equal((await h.upload(second)).status, 200)
})

await test('存储失败释放配额，后续成功上传；鉴权守卫保留', async (h) => {
  const key = await h.rebuild()
  assert.equal((await h.begin(h.uploadUrl(key), 'POST', { 'x-test-deny': '1' }).promise).status, 401)
  h.storage.save = async () => { throw new Error('mock failure') }
  assert.equal((await h.upload(key)).status, 500)
  h.storage.save = async () => ({ mediaType: 'image/png' })
  assert.equal((await h.upload(key)).status, 200)
  assert.equal((await h.upload(key)).status, 413)
})

await test('卸载时停止后台检查并取消进行中的重新评估', async (h) => {
  const key = await h.rebuild(), model = abortableModel(h)
  const review = h.post('/review', { consultKey: key, sessionId: 'A' })
  await model.started
  h.dispose()
  assert.equal(model.signal.aborted, true)
  assert.equal((await review).body.ok, false)
})

console.log(`\nsecurity lifecycle ok: ${passed} 项`)
