import assert from 'node:assert/strict'
import { test } from 'node:test'
import { client } from './helpers/client.mjs'

const pollFns = ['pollJob', 'findThread', 'updateThread', 'stopReadPolls', 'transientError', 'reconnectLater', 'clearReconnect', 'canReadTransport']
function polling(extra = [], overrides = {}) {
  const h = client([...pollFns, ...extra], overrides)
  h.state.store.threads.executor.push({ id: 'q:1', jobId: 'j:1', answer: '已读🙂', status: 'streaming' })
  h.ctx.pollJob('executor', 'q:1', 'j:1', 0, '已读🙂'.length)
  return h
}

for (const code of ['network', 'http-503']) {
  test(`${code}: transient poll failure preserves partial text and retries only context reads`, async () => {
    const h = polling(['loadContext'])
    const tick = h.scheduled.shift()()
    assert.match(h.requests[0].url, /cursor=4/)
    h.requests[0].reject(Object.assign(new Error('disconnect'), { code, status: code === 'http-503' ? 503 : undefined }))
    await tick
    assert.equal(h.state.store.threads.executor[0].answer, '已读🙂')
    assert.equal(h.state.store.threads.executor[0].status, 'streaming')
    assert.equal(h.state.store.connection, 'recovering')
    assert.equal(h.scheduled[0].ms, 500)
    h.scheduled.shift()()
    assert.equal(h.requests[1].url, '/context')
    assert.ok(h.requests.every((r) => !r.options?.method || r.options.method === 'GET'))
    h.requests[1].resolve({ restored: true }); await new Promise((r) => setImmediate(r))
    assert.equal(h.state.store.connection, 'online')
  })
}

test('reconnect backoff is bounded, paused while hidden, and cancelled on cleanup', () => {
  const h = client(['reconnectLater', 'clearReconnect', 'canReadTransport', 'stopReadPolls'], { loadContext() {} })
  for (const expected of [500, 1000, 2000, 4000, 5000, 5000]) {
    h.ctx.reconnectLater()
    const task = h.scheduled.shift(); assert.equal(task.ms, expected); task()
  }
  h.state.document.visibilityState = 'hidden'
  h.ctx.reconnectLater(); assert.equal(h.scheduled.length, 0)
  h.state.document.visibilityState = 'visible'
  h.ctx.reconnectLater(); h.ctx.clearReconnect()
  assert.equal(h.scheduled[0].cancelled, true)
  assert.equal(h.state.runtime.reconnectAttempts, 0)
})

for (const change of ['stop', 'new-session', 'dispose']) {
  test(`late poll error after ${change} cannot mark the current thread failed`, async () => {
    const h = polling()
    const tick = h.scheduled.shift()()
    if (change === 'stop') h.ctx.stopReadPolls()
    if (change === 'new-session') h.state.pollGeneration++
    if (change === 'dispose') h.state.runtime.disposed = true
    h.emitted.length = 0
    h.requests[0].reject(Object.assign(new Error('old network error'), { code: 'network' }))
    await tick
    assert.equal(h.emitted.length, 0)
    assert.equal(h.scheduled.length, 0)
  })
}

test('a logical poll failure is surfaced, not retried indefinitely', async () => {
  const h = polling(), tick = h.scheduled.shift()()
  h.requests[0].reject(Object.assign(new Error('job missing'), { code: 'job-not-found', status: 404 }))
  await tick
  assert.equal(h.state.store.threads.executor[0].status, 'error')
  assert.equal(h.scheduled.length, 0)
})

test('lost POST acknowledgement is reconciled by request id without a duplicate question row', async () => {
  const h = client(['sendQuestion', 'updateThread', 'mergeThreads', 'transientError', 'reconnectLater', 'canReadTransport'])
  const pending = h.ctx.sendQuestion('executor')
  const requestId = JSON.parse(h.requests[0].options.body).requestId
  h.requests[0].reject(Object.assign(new Error('lost ack'), { code: 'network' }))
  await pending
  assert.equal(h.state.store.threads.executor[0].uncertain, true)
  const merged = h.ctx.mergeThreads({ executor: [{ id: 'q:host', requestId, status: 'done', answer: 'finished' }], reviewer: [] }, h.state.store.threads)
  assert.equal(merged.executor.length, 1)
  assert.equal(merged.executor[0].answer, 'finished')
  assert.equal(h.requests.length, 1)
})

test('manual retry of an unconfirmed send reuses its identifier and attachments', () => {
  let received
  const h = client(['retryThread', 'findThread'], { sendQuestion(...args) { received = args } })
  h.state.store.threads.executor.push({ id: 'local', requestId: 'request:1', uncertain: true, question: 'why?', attachments: [{ id: 'img:1' }] })
  h.ctx.retryThread('executor', 'local')
  assert.equal(received[2].requestId, 'request:1')
  assert.equal(received[2].attachmentIds[0], 'img:1')
})

test('foreground recovery applies the full snapshot before resuming at its UTF-16 cursor', async () => {
  const h = polling(['transportChanged', 'loadContext', 'mergeThreads', 'resumeStreamingPolls'], {
    applyContext(payload) {
      h.state.store.threads = h.ctx.mergeThreads(payload.threads, h.state.store.threads)
      h.ctx.resumeStreamingPolls()
    },
  })
  const oldTick = h.scheduled.shift()()
  h.state.document.visibilityState = 'hidden'; h.ctx.transportChanged()
  assert.equal(h.requests[0].options.signal.aborted, true)
  h.state.document.visibilityState = 'visible'; h.ctx.transportChanged()
  h.requests[1].resolve({ threads: { executor: [{ id: 'q:1', jobId: 'j:1', answer: '完整🙂快照', status: 'streaming' }], reviewer: [] } })
  await new Promise((r) => setImmediate(r))
  h.requests[0].resolve({ delta: 'OLD', cursor: 7, status: 'streaming' }); await oldTick
  const nextTick = h.scheduled.filter((fn) => !fn.cancelled).at(-1)()
  assert.match(h.requests[2].url, /cursor=6/)
  h.requests[2].resolve({ delta: '新', cursor: 7, status: 'done' }); await nextTick
  assert.equal(h.state.store.threads.executor[0].answer, '完整🙂快照新')
  assert.equal(h.state.store.draft, 'why?')
})

test('offline and background reads do not run and do not clear the draft', async () => {
  const h = client(['loadContext', 'canReadTransport', 'sendQuestion'])
  for (const [online, visibility] of [[false, 'visible'], [true, 'hidden']]) {
    h.state.window.navigator.onLine = online; h.state.document.visibilityState = visibility
    await h.ctx.loadContext()
    assert.equal(await h.ctx.sendQuestion('executor'), false)
    assert.equal(h.requests.length, 0)
    assert.equal(h.state.store.draft, 'why?')
  }
})

test('GET timeout aborts a hung fetch and removes its timer', async () => {
  let timeout, cleared = 0
  const h = client(['requestJson'], {
    window: { setTimeout(fn, ms) { assert.equal(ms, 15000); timeout = fn; return 1 }, clearTimeout() { cleared++ } },
    fetch(_url, opts) { return new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))) },
  })
  const request = h.ctx.requestJson('/context')
  timeout()
  await assert.rejects(request, (e) => e.code === 'network')
  assert.equal(cleared, 1)
})

test('scheduled refreshes let a slow context response complete', async () => {
  const h = client(['loadContext'])
  const first = h.ctx.loadContext()
  for (let i = 0; i < 3; i++) await h.ctx.loadContext({ silent: true })
  assert.equal(h.requests.length, 1)
  h.requests[0].resolve({ revision: 1 })
  await first
  assert.equal(h.state.store.context.revision, 1)
  assert.equal(h.state.store.loadingContext, false)
  const next = h.ctx.loadContext({ silent: true })
  assert.equal(h.requests.length, 2)
  h.requests[1].resolve({ revision: 2 })
  await next
})

const deliveryFns = ['sendQuestion', 'retryThread', 'stopThread', 'findThread', 'updateThread', 'mergeThreads', 'resumeStreamingPolls', 'pollJob', 'transientError']

function delivery() {
  return client(deliveryFns, { loadContext() {}, reconnectLater() {} })
}

function receiveSnapshot(h, turn) {
  h.state.store.threads = h.ctx.mergeThreads({ executor: [turn], reviewer: [] }, h.state.store.threads)
  h.ctx.resumeStreamingPolls()
}

test('snapshot before ask acknowledgement retains exactly one poll starting at the saved cursor', async () => {
  const h = delivery()
  const ask = h.ctx.sendQuestion('executor')
  const pending = h.state.store.threads.executor[0]
  receiveSnapshot(h, { ...pending, id: 'q:1', jobId: 'j:1', answer: 'A' })
  h.requests[0].resolve({ threadId: 'q:1', jobId: 'j:1', consultKey: 'ac:A' })
  await ask
  assert.equal(h.scheduled.filter((task) => task.ms === 70).length, 1)
  const tick = h.scheduled.shift()()
  assert.match(h.requests[1].url, /cursor=1/)
  h.requests[1].resolve({ delta: 'B', cursor: 2, status: 'done' })
  await tick
  assert.equal(h.state.store.threads.executor[0].answer, 'AB')
})

for (const ack of ['first', 'lost', 'other-panel']) {
  test(`Stop before ask acknowledgement (${ack}) cancels the original job once`, async () => {
    const h = delivery()
    const ask = h.ctx.sendQuestion('executor')
    const pending = h.state.store.threads.executor[0]
    await h.ctx.stopThread('executor', pending.id)
    assert.equal(h.state.store.threads.executor[0].status, 'stopping')
    const accepted = { threadId: 'q:1', jobId: 'j:1', consultKey: 'ac:A' }
    if (ack === 'other-panel') {
      h.state.pollGeneration++
      Object.assign(h.state.store, { sessionId: 'B', consultKey: 'ac:B', threads: { executor: [], reviewer: [] } })
    }
    if (ack === 'lost') {
      h.requests[0].reject(Object.assign(new Error('disconnected'), { code: 'network' }))
      await ask
      h.ctx.retryThread('executor', pending.id)
      assert.equal(h.requests.length, 1)
      receiveSnapshot(h, { ...pending, id: 'q:1', jobId: 'j:1' })
    } else {
      h.requests[0].resolve(accepted)
      await ask
    }
    assert.equal(h.requests.length, 2)
    assert.match(h.requests[1].url, /\/cancel$/)
    assert.deepEqual(JSON.parse(h.requests[1].options.body), { sessionId: 'A', consultKey: 'ac:A', jobId: 'j:1' })
    assert.equal(h.scheduled.length, 0)
    h.requests[1].resolve({ status: 'cancelled' })
    await new Promise((resolve) => setImmediate(resolve))
    if (ack === 'other-panel') assert.equal(h.state.store.threads.executor.length, 0)
    else assert.equal(h.state.store.threads.executor[0].status, 'cancelled')
    assert.equal(h.state.runtime.pendingStops.size, 0)
  })
}

test('failed cancel can be retried and does not claim the host stopped', async () => {
  const h = delivery()
  h.state.store.threads.executor.push({ id: 'q:1', jobId: 'j:1', status: 'streaming' })
  const stop = h.ctx.stopThread('executor', 'q:1')
  h.requests[0].reject(new Error('lost cancel'))
  await stop
  assert.equal(h.state.store.threads.executor[0].status, 'streaming')
  const retry = h.ctx.stopThread('executor', 'q:1')
  h.requests[1].resolve({ status: 'done' })
  await retry
  assert.equal(h.state.store.threads.executor[0].status, 'done')
})

test('a closed panel with a lost ask receipt reconciles and stops only the original request', async () => {
  const h = client([...deliveryFns, 'watchdogStreamingPolls', 'reconcileDetachedStop'], { URLSearchParams })
  const ask = h.ctx.sendQuestion('executor')
  const pending = h.state.store.threads.executor[0]
  await h.ctx.stopThread('executor', pending.id)
  h.state.pollGeneration++
  Object.assign(h.state.store, { open: false, sessionId: 'B', consultKey: 'ac:B', threads: { executor: [], reviewer: [] } })
  h.requests[0].reject(Object.assign(new Error('receipt lost'), { code: 'network' }))
  await ask
  h.ctx.watchdogStreamingPolls()
  const url = new URL(h.requests[1].url, 'https://fixture.invalid')
  assert.equal(url.searchParams.get('sessionId'), 'A')
  assert.equal(url.searchParams.get('consultKey'), 'ac:A')
  h.requests[1].resolve({ consultKey: 'ac:A', threads: { executor: [
    { id: 'q:other', jobId: 'j:other', requestId: 'other', status: 'streaming' },
    { id: 'q:1', jobId: 'j:1', requestId: pending.requestId, status: 'streaming' },
  ] } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(JSON.parse(h.requests[2].options.body), { jobId: 'j:1', consultKey: 'ac:A', sessionId: 'A' })
  h.requests[2].resolve({ status: 'cancelled' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.state.runtime.pendingStops.size, 0)
  assert.equal(h.state.store.threads.executor.length, 0)
})

test('an interrupted 200 response and an incomplete ask receipt both preserve the request id for retry', async () => {
  const wire = client(['requestJson'], { fetch: async () => ({ ok: true, status: 200, json() { throw new TypeError('body interrupted') } }) })
  let deliveryError
  await assert.rejects(wire.ctx.requestJson('/dsh-approval-consult/ask', { method: 'POST' }), (error) => { deliveryError = error; return error.code === 'network' })
  for (const incomplete of [false, true]) {
    const h = delivery()
    const ask = h.ctx.sendQuestion('executor')
    const key = JSON.parse(h.requests[0].options.body).requestId
    if (incomplete) h.requests[0].resolve({ ok: true })
    else h.requests[0].reject(deliveryError)
    await ask
    const failed = h.state.store.threads.executor[0]
    assert.equal(failed.uncertain, true)
    h.state.store.draft = 'a new question'
    h.ctx.retryThread('executor', failed.id)
    assert.equal(JSON.parse(h.requests[1].options.body).requestId, key)
    assert.equal(h.state.store.draft, 'a new question')
    h.requests[1].resolve({ threadId: 'q:1', jobId: 'j:1', consultKey: 'ac:A' })
    await new Promise((resolve) => setImmediate(resolve))
  }
})

test('sending a preset preserves the draft and a delayed receipt only clears its own images', async () => {
  const revoked = []
  const h = client([...deliveryFns, 'readyAttachmentMeta', 'clearAttachments'], {
    revokeAttachmentPreview(item) { revoked.push(item.id) },
  })
  h.state.store.attachments = [{ id: 'att:1', status: 'ready' }]
  const ask = h.ctx.sendQuestion('executor', 'preset')
  assert.equal(h.state.store.draft, 'why?')
  h.state.store.attachments.push({ id: 'att:2', status: 'uploading' })
  h.requests[0].resolve({ threadId: 'q:1', jobId: 'j:1', consultKey: 'ac:A' })
  await ask
  assert.deepEqual(Array.from(h.state.store.attachments, (item) => item.id), ['att:2'])
  assert.deepEqual(revoked, ['att:1'])
})

test('a snapshot acknowledging a pictured ask preserves images added after the POST', async () => {
  const h = client([...deliveryFns, 'readyAttachmentMeta', 'clearAttachments'], { revokeAttachmentPreview() {}, reconnectLater() {} })
  h.state.store.attachments = [{ id: 'att:1', status: 'ready' }]
  const ask = h.ctx.sendQuestion('executor')
  const pending = h.state.store.threads.executor[0]
  h.requests[0].reject(Object.assign(new Error('missing receipt'), { code: 'network' }))
  await ask
  h.state.store.attachments.push({ id: 'att:2', status: 'ready' })
  receiveSnapshot(h, { ...pending, id: 'q:1', jobId: 'j:1', status: 'done' })
  assert.deepEqual(Array.from(h.state.store.attachments, (item) => item.id), ['att:2'])
})

function viewport(options = {}) {
  const { height = 800, keyboard = 0, vv, insets = {} } = options
  return client(['readViewport'], {
    window: { innerHeight: height, visualViewport: vv, __dshAppKeyboard: keyboard,
      getComputedStyle: () => ({ getPropertyValue: (key) => String(insets[key.split('-').at(-1)] ?? 0) }) },
    document: { documentElement: {} },
  }).ctx.readViewport()
}

test('Go keyboard inset lifts a non-resizing WebView above IME and safe chrome', () => {
  const v = viewport({ keyboard: 320, insets: { top: 44, bottom: 24, left: 10, right: 10 } })
  assert.equal(v.height, 436); assert.equal(v.bottom, 320); assert.equal(v.top, 44)
  assert.equal(v.left, 10)
})
test('native and visual keyboard heights are unioned, never subtracted twice', () => {
  const v = viewport({ keyboard: 320, vv: { height: 480, offsetTop: 0, scale: 1 } })
  assert.equal(v.height, 480); assert.equal(v.bottom, 320)
})
test('ordinary mobile browser, offset viewport, rotation, and closed keyboard fit available height', () => {
  assert.equal(viewport({ vv: { height: 460, offsetTop: 20, scale: 1 } }).height, 460)
  assert.equal(viewport({ height: 360, keyboard: 220, insets: { top: 20 } }).height, 120)
  assert.equal(viewport({ insets: { bottom: 24 } }).height, 776)
  assert.equal(viewport({ height: 480 }).height, 480)
})
test('pinch zoom is not misidentified as a keyboard', () => {
  const v = viewport({ vv: { height: 400, offsetTop: 30, scale: 2 } })
  assert.equal(v.keyboard, 0); assert.equal(v.height, 800)
})

test('inset observer follows Go style replacement and cleans up without a VisualViewport', () => {
  let callback, disconnected = false, changes = 0
  const events = new Set()
  const h = client(['observeViewport'], {
    window: { addEventListener: (n) => events.add(n), removeEventListener: (n) => events.delete(n) },
    document: { head: {} }, MutationObserver: class {
      constructor(fn) { callback = fn } observe() {} disconnect() { disconnected = true }
    },
  })
  const stop = h.ctx.observeViewport(() => changes++)
  callback([{ target: { id: 'dsh-app-keyboard' }, addedNodes: [], removedNodes: [] }])
  callback([{ target: {}, addedNodes: [{ id: 'unrelated-style' }], removedNodes: [] }])
  callback([{ target: {}, addedNodes: [{ id: 'dsh-app-insets' }], removedNodes: [] }])
  assert.equal(changes, 3)
  stop(); assert.equal(events.size, 0); assert.equal(disconnected, true)
})

test('phone Enter and IME never send, including landscape; desktop Enter still sends', () => {
  let coarse = true
  const h = client(['enterSends'], { window: { matchMedia: () => ({ matches: coarse }) } })
  assert.equal(h.ctx.enterSends({ key: 'Enter' }, false), false)
  coarse = false
  for (const e of [{ isComposing: true }, { nativeEvent: { isComposing: true } }, { keyCode: 229 }, { shiftKey: true }]) {
    assert.equal(h.ctx.enterSends({ key: 'Enter', ...e }, false), false)
  }
  assert.equal(h.ctx.enterSends({ key: 'Enter' }, false), true)
  assert.equal(h.ctx.enterSends({ key: 'Enter' }, true), false)
})

test('Go body Escape closes only our top layer and listener is removed on unmount', () => {
  let listener, closes = 0
  const root = { isConnected: true, getClientRects: () => [1] }
  const other = { ...root }, body = {}, html = {}
  let layers = [root]
  const h = client(['listenForGoBack'], {
    window: { __dshAppBack() {} }, document: { body, documentElement: html,
      querySelectorAll: () => layers, addEventListener: (_n, fn) => { listener = fn }, removeEventListener: () => { listener = null } },
  })
  const stop = h.ctx.listenForGoBack(root, () => closes++)
  const press = (extra = {}) => listener({ target: body, key: 'Escape', preventDefault() {}, stopImmediatePropagation() {}, ...extra })
  press(); assert.equal(closes, 1)
  layers = [root, other]; press(); assert.equal(closes, 1)
  layers = [root]; press({ isComposing: true }); press({ target: {} }); assert.equal(closes, 1)
  delete h.state.window.__dshAppBack; press(); assert.equal(closes, 1)
  stop(); assert.equal(listener, null)
})
