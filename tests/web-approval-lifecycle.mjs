import assert from 'node:assert/strict'
import { test } from 'node:test'
import { client } from './helpers/client.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))

function approvalClient(names, overrides = {}) {
  const answers = []
  let activeSession = 'A', live
  const card = (key) => ({ kind: 'approval', key, answerable: true, answer: async (outcome) => answers.push([key, outcome]) })
  live = card('approval:1')
  const h = client(['panelApproval', ...names], {
    currentSession: { get: () => activeSession },
    pendingOf: (sessionId) => sessionId === activeSession ? live : null,
    URLSearchParams,
    ...overrides,
  })
  Object.assign(h.state.store, { approvalKey: live.key, resolved: false, timeoutAvailable: true, timeout: { cancelled: false } })
  return { ...h, answers, first: live, switchCard: () => { live = card('approval:2') }, switchSession: () => { activeSession = 'B' } }
}

test('decision re-reads the official card before the next React render', async () => {
  for (const change of ['switchCard', 'switchSession']) {
    const h = approvalClient(['decide'])
    h[change]()
    await h.ctx.decide(h.first, 'allowed-once')
    assert.deepEqual(h.answers, [])
    assert.equal(h.state.store.resolved, true)
  }
  const h = approvalClient(['decide'])
  await h.ctx.decide(h.first, 'rejected')
  await h.ctx.decide(h.first, 'allowed-once')
  assert.deepEqual(h.answers, [['approval:1', 'rejected']])
  assert.equal(h.state.store.outcome, 'rejected')
})

test('an answer failure never fabricates the attempted decision', async () => {
  const h = approvalClient(['decide'], { loadContext() {} })
  h.first.answer = async () => { throw new Error('offline') }
  await h.ctx.decide(h.first, 'allowed-once')
  assert.equal(h.state.store.outcome, undefined)
  assert.equal(h.state.store.deciding, false)
})

test('a browser render key never identifies a host record and a missing callId leaves the original decision available', async () => {
  const h = approvalClient(['contextQuery', 'loadContext', 'decide'])
  const query = () => new URL(h.ctx.contextQuery('A'), 'https://example.test').searchParams
  assert.equal(query().get('callId'), '1')
  assert.equal(query().get('approvalId'), null)
  Object.assign(h.state.store, { callId: null, consultKey: null, toolName: 'shell' })
  assert.equal(query().get('toolName'), null)
  await h.ctx.loadContext()
  assert.equal(h.requests.length, 0)
  assert.equal(h.scheduled.length, 0)
  assert.equal(h.state.store.contextMissing, true)
  await h.ctx.decide(h.first, 'rejected')
  assert.deepEqual(h.answers, [['approval:1', 'rejected']])
})

function timeoutClient({ rejectPost = false } = {}) {
  const writes = [], notices = []
  const h = approvalClient(['probeTimeout', 'matchingTimeout', 'pauseAllTimeouts', 'loadContext'], {
    TIMEOUT_API: '/timeout',
    fetch: async (url) => { writes.push(url); return { ok: !rejectPost } },
    toast: (message) => notices.push(message),
  })
  return { ...h, writes, notices }
}
const countdown = (cancelled = false) => ({ ok: true, timeoutMs: 60000, pending: [{ callId: '1', elapsedMs: 300, cancelled }] })

test('history mode never starts a consultation read, timeout probe or pause', async () => {
  const h = timeoutClient()
  Object.assign(h.state.store, { mode: 'history', timeoutConfirming: true })
  await h.ctx.loadContext()
  await h.ctx.probeTimeout()
  await h.ctx.pauseAllTimeouts()
  assert.equal(h.requests.length, 0)
  assert.equal(h.writes.length, 0)
})

test('countdowns match an unambiguous call and a confirmed write requires a successful state readback', async () => {
  const h = timeoutClient()
  assert.equal(h.ctx.matchingTimeout({ pending: [{ toolName: 'shell' }] }), null)
  assert.equal(h.ctx.matchingTimeout({ pending: [{ callId: '1' }, { callId: '1' }] }), null)
  assert.equal(h.ctx.matchingTimeout({ pending: [{ callId: '1', sessionId: 'B' }] }), null)
  await h.ctx.pauseAllTimeouts()
  assert.equal(h.requests.length, 0)
  const probe = h.ctx.probeTimeout()
  h.requests[0].resolve(countdown()); await probe
  assert.equal(h.writes.length, 0)
  h.state.store.timeoutConfirming = true
  const write = h.ctx.pauseAllTimeouts()
  h.requests[1].resolve(countdown()); await tick()
  assert.deepEqual(h.writes, ['/timeout/cancel'])
  assert.equal(h.notices.length, 0)
  h.requests[2].resolve(countdown(true)); await write
  assert.deepEqual(h.notices, ['toastPaused'])
  assert.equal(h.state.store.timeout.cancelled, true)
})

test('timeout status failures, card switches and failed writes do not report a successful pause', async () => {
  for (const failure of ['status', 'switch', 'post', 'unconfirmed']) {
    const h = timeoutClient({ rejectPost: failure === 'post' })
    h.state.store.timeoutConfirming = true
    const task = h.ctx.pauseAllTimeouts()
    if (failure === 'switch') h.switchCard()
    if (failure === 'status') h.requests[0].reject(new Error('offline'))
    else h.requests[0].resolve(countdown())
    await tick()
    if (failure === 'unconfirmed') h.requests[1].resolve(countdown(false))
    await task
    assert.equal(h.writes.length, ['status', 'switch'].includes(failure) ? 0 : 1)
    assert.equal(h.notices.includes('toastPaused'), false)
    assert.equal(h.state.store.timeout.cancelled, false)
  }
})

function historyClient() {
  const historyCache = new Map(), historyRevisions = new Map(), observed = []
  const h = client(['loadHistory', 'reloadHistory', 'invalidateHistory', 'notifyTail', 'historyChanged'], {
    historyCache, historyRevisions, historyRequest: 0, HISTORY_TTL_MS: 30000,
    normalizeHistoryItem: (item) => item,
    tailState: { version: 0, listeners: new Set([() => observed.push('updated')]) },
  })
  Object.assign(h.state.store, { mode: 'history' })
  return { ...h, observed, historyCache, historyRevisions }
}

test('late history reads and errors do not replace the active session or a later refresh', async () => {
  for (const late of ['success', 'error']) {
    const h = historyClient()
    const a = h.ctx.reloadHistory()
    h.state.store.sessionId = 'B'
    h.state.pollGeneration++
    const b = h.ctx.reloadHistory()
    const newest = h.ctx.reloadHistory()
    h.requests[2].resolve({ items: ['B-new'] }); await newest
    h.requests[1].resolve({ items: ['B-old'] }); await b
    if (late === 'error') h.requests[0].reject(new Error('A failure'))
    else h.requests[0].resolve({ items: ['A item'] })
    await a
    assert.deepEqual(h.state.store.history.items, ['B-new'])
    assert.deepEqual(h.historyCache.get('B').items, ['B-new'])
    assert.equal(h.state.store.history.error, null)
  }
})

test('first accepted question and terminal answer invalidate mounted history consumers, but every token does not', async () => {
  const h = historyClient()
  const initial = { ...h.state.store, mode: 'pending' }
  const make = (status, answer) => ({ ...initial, threads: { executor: [{ id: 'q1', jobId: 'j1', status, answer }], reviewer: [] } })
  const accepted = make('streaming', ''), delta = make('streaming', 'x'), done = make('done', 'xy')
  assert.equal(h.ctx.historyChanged(initial, accepted), true)
  assert.equal(h.ctx.historyChanged(accepted, delta), false)
  assert.equal(h.ctx.historyChanged(delta, done), true)
  const old = h.ctx.loadHistory('A')
  h.ctx.invalidateHistory('A')
  const fresh = h.ctx.loadHistory('A')
  h.requests[1].resolve({ items: ['q1'] }); await fresh
  h.requests[0].resolve({ items: [] }); await old
  assert.deepEqual(h.historyCache.get('A').items, ['q1'])
  assert.deepEqual(h.observed, ['updated'])
})

test('history distinguishes pending, unknown outcome and cancellation', () => {
  const h = client(['HistoryItem'], {
    OUTCOME_KEYS: { cancelled: 'outcomeCancelled' },
    h: (type, props, ...children) => ({ type, children }),
    fmt: (text) => text, formatDateTime: () => '',
  })
  for (const [resolved, outcome, label] of [[false, null, 'statusWaiting'], [true, null, 'outcomeUnknown'], [true, 'cancelled', 'outcomeCancelled']]) {
    const node = h.ctx.HistoryItem({ t: (name) => name, item: { resolved, outcome } })
    assert.equal(node.children[0].children[1].children[0], label)
  }
})
