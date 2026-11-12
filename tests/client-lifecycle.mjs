import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { apply as applyShim } from '../lib/index.js'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
function client(names, overrides = {}) {
  const emitted = [], scheduled = [], requests = []
  const state = {
    store: { open: true, demo: null, sessionId: 'A', consultKey: 'ac:A', callId: '1', draft: 'why?', limits: {},
      threads: { executor: [], reviewer: [] }, context: null, attachments: [], tab: 'executor' },
    runtime: { disposed: false }, pollGeneration: 0, contextRequest: 0, activePolls: new Map(),
    API: '/dsh-approval-consult', POLL_INTERVAL_MS: 120,
    emit(patch) { emitted.push(patch); Object.assign(state.store, patch) },
    after(ms, fn) { scheduled.push(fn) },
    requestJson(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) },
    contextQuery: () => '/context', applyContext: (payload) => { state.store.context = payload },
    describeError: (error) => ({ code: error.code, detail: error.message }),
    readyAttachmentMeta: () => [], nextLocalId: () => 'local:1', ensureTimeoutPaused() {},
    toast() {}, clearAttachments() { state.store.attachments = [] },
    demoStopTimers: new Map(),
    ...overrides,
  }
  const ctx = vm.createContext(state)
  for (const name of new Set(['isCurrentPanel', ...names])) {
    const start = source.search(new RegExp(`^    (?:async )?function ${name}\\(`, 'm'))
    assert.ok(start >= 0, `missing ${name}`)
    const end = source.indexOf('\n    }', start) + 6
    vm.runInContext(source.slice(start, end), ctx)
  }
  return { ctx, state, emitted, scheduled, requests }
}

test('a previous panel context response cannot overwrite the current session', async () => {
  const h = client(['loadContext']), pending = h.ctx.loadContext()
  h.state.pollGeneration++
  h.state.store.sessionId = 'B'
  h.emitted.length = 0
  h.requests[0].resolve({ consultKey: 'ac:A' })
  await pending
  assert.equal(h.state.store.context, null)
  assert.equal(h.emitted.length, 0)
})

test('out-of-order context responses keep the newest snapshot', async () => {
  const h = client(['loadContext']), first = h.ctx.loadContext(), second = h.ctx.loadContext()
  h.requests[1].resolve({ revision: 2 }); await second
  h.requests[0].resolve({ revision: 1 }); await first
  assert.equal(h.state.store.context.revision, 2)
})

for (const failed of [false, true]) {
  test(`late ask ${failed ? 'failure' : 'success'} cannot change another panel`, async () => {
    const h = client(['sendQuestion']), pending = h.ctx.sendQuestion('executor')
    h.state.pollGeneration++
    h.state.store.sessionId = 'B'
    h.state.store.consultKey = 'ac:B'
    h.state.store.threads = { executor: [], reviewer: [] }
    h.emitted.length = 0
    if (failed) h.requests[0].reject(Object.assign(new Error('old error'), { code: 'approval-resolved' }))
    else h.requests[0].resolve({ jobId: 'old-job', threadId: 'old-thread', consultKey: 'ac:A' })
    await pending
    assert.equal(h.state.store.consultKey, 'ac:B')
    assert.equal(h.emitted.length, 0)
  })
}

test('late advisory output cannot label a different approval as allowed', async () => {
  const h = client(['requestAdvisoryReview']), pending = h.ctx.requestAdvisoryReview()
  h.state.pollGeneration++
  h.emitted.length = 0
  h.requests[0].resolve({ risk: 'low', decision: 'allow' })
  await pending
  assert.equal(h.emitted.length, 0)
})

test('stopping a thread prevents an in-flight poll from restoring streaming', async () => {
  const h = client(['pollJob', 'stopThread', 'findThread', 'updateThread'])
  h.state.store.threads.executor.push({ id: 'q:1', jobId: 'j:1', answer: '', status: 'streaming' })
  h.ctx.pollJob('executor', 'q:1', 'j:1', 0)
  const tick = h.scheduled.shift()()
  const stop = h.ctx.stopThread('executor', 'q:1')
  h.requests.find((r) => r.url.endsWith('/cancel')).resolve({ ok: true })
  await stop
  h.requests.find((r) => r.url.includes('/poll?')).resolve({ delta: 'late text', status: 'streaming', cursor: 9 })
  await tick
  assert.equal(h.state.store.threads.executor[0].status, 'cancelled')
  assert.equal(h.state.store.threads.executor[0].answer, '')
})

test('a terminal context snapshot stops outstanding deltas from duplicating the answer', async () => {
  const h = client(['pollJob', 'mergeThreads', 'findThread', 'updateThread'])
  h.state.store.threads.executor.push({ id: 'q:1', answer: 'a', status: 'streaming' })
  h.ctx.pollJob('executor', 'q:1', 'j:1', 0, 1)
  const tick = h.scheduled.shift()()
  h.state.store.threads = h.ctx.mergeThreads({ executor: [{ id: 'q:1', answer: 'answer', status: 'done' }], reviewer: [] }, h.state.store.threads)
  h.requests[0].resolve({ delta: 'nswer', cursor: 6, status: 'done' })
  await tick
  assert.equal(h.state.store.threads.executor[0].answer, 'answer')
  assert.equal(h.state.activePolls.size, 0)
})

test('disposing the shim during dynamic import prevents late host registration', async () => {
  let cleanup, registrations = 0
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { cleanup = fn() },
    on() { registrations++; return () => {} },
  }
  applyShim(ctx, {})
  const state = globalThis.__DSH_APPROVAL_CONSULT__
  assert.equal(state.watcher, null, 'devWatch must be opt-in even without a bundle config')
  cleanup()
  const deadline = Date.now() + 3000
  while (state.swapping && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(state.swapping, false)
  assert.equal(registrations, 0)
  assert.equal(state.current, null)
})
