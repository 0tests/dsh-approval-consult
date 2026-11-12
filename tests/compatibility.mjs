// Public hooks and HTTP routes with an in-memory host; no provider calls or disk writes.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { apply, __test } from '../lib/impl.js'

const STATE = '__DSH_APPROVAL_CONSULT_STATE_V1__'
const policy = readFileSync(new URL('../lib/review-policy.txt', import.meta.url), 'utf8')
const schema = { name: 'shell', description: 'Run a command', parameters: { type: 'object' } }
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const turn = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

export function reviewOptions(mode = 'native', args = { command: 'echo test' }) {
  return {
    provider: 'mock', model: 'mock', sessionId: 'A', system: policy, purpose: 'auto-review',
    messages: [user('ENVIRONMENT\n{"cwd":"/project"}'),
      user(JSON.stringify({ kind: 'user-message', role: 'user-instruction', source: { kind: 'user' }, content: [{ type: 'text', text: 'test task' }] })),
      user(JSON.stringify({ kind: 'tool-schema', role: 'fact', mode, ...schema })),
      user(JSON.stringify({ kind: 'tool-call', role: 'fact', mode, name: schema.name, arguments: JSON.stringify(args) })),
    ],
  }
}

function host(t, config = {}) {
  delete globalThis[STATE]
  const routes = new Map(), hooks = new Map(), intervals = new Map(), events = [], injections = []
  const session = {
    id: 'A', header: { cwd: '/project' }, surface: { nodes: [] }, isOwnSeq: () => true,
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'mock', model: 'mock' }, tools: [schema] }),
  }
  const agent = { session, status: 'running', ctx: { on: () => () => {} }, inject: (m) => injections.push(m) }
  const ctx = {
    registry: new Map(), agents: { list: () => [agent], get: () => agent }, sessions: {},
    webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path) } },
    connection: { requestRejection: () => undefined },
    on: (name, fn, prepend) => { hooks.set(name, { fn, prepend }); return () => hooks.delete(name) },
    inject: (_services, fn) => { fn(ctx); return { dispose() {} } },
    llm: { stream: async function* () { yield { type: 'text-delta', text: 'test answer' } } },
  }
  const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => { const timer = { unref() {} }; intervals.set(timer, { fn, ms }); return timer }
  let dispose
  try { dispose = apply(ctx, { reviewerMode: 'on', ...config }, { log: { info() {}, warn() {}, error() {} } }) }
  finally { globalThis.setInterval = originalInterval }
  t.after(() => {
    globalThis.clearInterval = (timer) => intervals.delete(timer)
    try { dispose() } finally { globalThis.clearInterval = originalClear; delete globalThis[STATE] }
    assert.equal(intervals.size, 0)
  })
  const append = (type, data, visible = false) => {
    const event = { seq: events.length, time: Date.now(), type, data }
    events.push(event)
    if (visible) session.surface.nodes.push(event.seq)
    return event
  }
  append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'test task' }] }, true)
  const request = (path, body) => new Promise((resolve, reject) => {
    const req = Object.assign(new EventEmitter(), { url: `/dsh-approval-consult${path}`, method: body === undefined ? 'GET' : 'POST', headers: {}, destroy() {} })
    const timer = setTimeout(() => reject(new Error(`route timeout: ${path}`)), 1000)
    let status
    routes.get(req.url.split('?')[0])(req, {
      writeHead(code) { status = code },
      end(data) { clearTimeout(timer); resolve({ status, body: JSON.parse(data) }) },
      destroy() { clearTimeout(timer); reject(new Error('response destroyed')) },
    })
    if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
  })
  return {
    ctx, agent, hooks, session, events, append, injections, request,
    get state() { return globalThis[STATE] },
    async capture(options, chunks) {
      const stream = hooks.get('llm/stream').fn(options, async function* () { yield* chunks })
      for await (const _ of stream) { /* Consume the transparent host stream. */ }
    },
    main() {
      const options = { sessionId: 'A', provider: 'mock', model: 'mock', tools: [schema], messages: [{ role: 'system', content: [{ type: 'text', text: 'system' }] }] }
      hooks.get('llm/stream').fn(options, () => null)
      return options
    },
    pending(id = 'call-1', args = { command: 'echo test' }, ptc = false) {
      const exec = { agent, name: schema.name, callId: id, rootCallId: ptc ? 'root' : id, arguments: args,
        ...(ptc ? { parent: { callId: 'root' }, schema } : {}) }
      append(ptc ? 'tool/ptc-dispatch-start' : 'tool/call', ptc
        ? { subCallId: id, rootCallId: 'root', parentCallId: 'root', name: schema.name, arguments: args }
        : { callId: id, name: schema.name, arguments: JSON.stringify(args) })
      hooks.get('tools/pre-execute').fn(exec, () => null)
      append('approval/asked', { id, callId: id, toolName: schema.name })
      const completion = deferred()
      const result = hooks.get('approval/request').fn({ agent, callId: id, toolName: schema.name }, () => completion.promise)
      t.after(async () => { completion.resolve('rejected'); await result })
      return [...globalThis[STATE].pendings.values()].at(-1)
    },
    sweep() { for (const timer of intervals.values()) if (timer.ms === 60000) timer.fn() },
  }
}

for (const mode of ['native', 'ptc-inner']) {
  test(`rc.2 ${mode}: capture, match exact action and preserve the review prefix`, async (t) => {
    const h = host(t), original = reviewOptions(mode)
    await h.capture(original, [{ type: 'text-delta', text: '{"risk":"medium","decision":"deny","reason":"needs confirmation"}' }, { type: 'finish', reason: { kind: 'stop' } }])
    const record = h.pending('call-1', { command: 'echo test' }, mode === 'ptc-inner')
    assert.equal(record.review, h.state.reviews.get('A')[0])
    assert.equal(record.review.historyCount, 1)
    assert.equal(record.review.action.mode, mode)
    let sent
    h.ctx.llm.stream = async function* (options) { sent = options; yield { type: 'text-delta', text: 'explanation' } }
    assert.equal((await h.request('/ask', { sessionId: 'A', consultKey: record.key, target: 'reviewer', question: 'why?' })).status, 200)
    await turn()
    assert.deepEqual(sent.messages.slice(0, original.messages.length), original.messages)
    assert.equal(sent.sessionId, 'A')
    assert.equal(sent.purpose, 'approval-consult')
    assert.equal(original.purpose, 'auto-review')
    assert.equal(h.injections.length, 0)
  })
}

test('rc.2 parser uses the latest schema of the same mode and rejects incomplete final items', () => {
  const options = reviewOptions('ptc-inner')
  options.messages.splice(2, 0, user(JSON.stringify({ kind: 'tool-schema', mode: 'native', ...schema, description: 'wrong mode' })))
  assert.equal(__test.parseReviewRequest(options).action.description, schema.description)
  options.messages.push(user('{invalid'))
  assert.equal(__test.parseReviewRequest(options).action, null)
  options.messages.pop()
  options.messages.pop()
  assert.equal(__test.parseReviewRequest(options).action, null)
})

test('legacy four-section reviews still match with their original messages', async (t) => {
  const h = host(t), original = reviewOptions()
  original.messages = [user('ENVIRONMENT\n\n{}\n\nPROJECT_INSTRUCTIONS\n\n[]\n\nFILTERED_HISTORY\n\n[]\n\nPENDING_ACTION\n\n' + JSON.stringify({ mode: 'native', ...schema, arguments: { command: 'echo test' } }))]
  await h.capture(original, [{ type: 'text-delta', text: '{"risk":"medium","decision":"deny"}' }])
  assert.equal(h.pending().review.options, original)
})

for (const ptc of [false, true]) {
  test(`advisory ${ptc ? 'PTC' : 'native'} retains arguments and uses the bundled policy's item format`, async (t) => {
    const h = host(t), args = { command: 'echo pending', text: 'PENDING_ACTION\n\nnot a delimiter' }
    const record = h.pending('call-1', args, ptc)
    assert.equal(h.hooks.get('tools/pre-execute').prepend, true)
    assert.deepEqual(__test.normalizeArguments(record.advisorySnapshot.action.arguments), args)
    let sent
    h.ctx.llm.stream = async function* (options) { sent = options; yield { type: 'text-delta', text: '{"risk":"low","decision":"allow"}' } }
    assert.equal((await h.request('/review', { sessionId: 'A', consultKey: record.key })).body.ok, true)
    assert.deepEqual(__test.normalizeArguments(__test.parseReviewRequest(sent).action.arguments), args)
    assert.equal(__test.parseReviewRequest(sent).action.mode, ptc ? 'ptc-inner' : 'native')
    assert.equal(sent.purpose, 'approval-consult')
  })
}

test('advisory declines missing schemas', (t) => {
  const h = host(t)
  h.session.requestHeader = () => ({ config: { provider: 'mock', model: 'mock' }, tools: [] })
  assert.equal(h.pending().advisorySnapshot, null)
})

test('advisory distinguishes SDK instructions, child creation text, constraints and images', (t) => {
  const h = host(t)
  h.session.header = { origin: 'subagent', parentSession: 'parent' }
  h.append('subagent/descriptor', {})
  h.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'child task' }, { type: 'image', attachment: {} }] }, true)
  h.append('user/message', { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'project constraint' }] }, true)
  const record = h.pending()
  const items = record.advisorySnapshot.messages.slice(1).map((message) => JSON.parse(message.content[0].text))
  assert.equal(items.find((item) => item.content?.[0]?.text === 'child task').role, 'direct-parent-instruction')
  assert.equal(items.find((item) => item.content?.[0]?.type === 'image').role, 'fact')
  assert.equal(items.find((item) => item.content?.[0]?.text === 'project constraint').role, 'constraint')
})

for (const kind of ['error', 'aborted', 'length']) {
  test(`a ${kind} finish cannot publish or reuse a parsed advisory verdict`, async (t) => {
    const h = host(t), record = h.pending()
    h.ctx.llm.stream = async function* () {
      yield { type: 'text-delta', text: '{"risk":"low","decision":"allow"}' }
      yield { type: 'finish', reason: { kind, failure: 'test failure' } }
    }
    const result = await h.request('/review', { sessionId: 'A', consultKey: record.key })
    assert.equal(result.body.ok, false)
    assert.equal(record.advisoryReview.decision, null)
  })
}

test('illegal risk/decision combinations are rejected', () => {
  for (const value of [{ risk: 'high', decision: 'allow' }, { risk: 'low', decision: 'deny' }, { risk: 'unknown', decision: 'allow' }, { risk: 'low', decision: 'allow', reason: 'not permitted' }]) {
    assert.equal(__test.parseReviewDecision(JSON.stringify(value)), null)
  }
})

test('auxiliary model requests do not replace the executor context', (t) => {
  const h = host(t), main = h.main()
  h.hooks.get('llm/stream').fn({ ...main, purpose: 'another-plugin' }, () => null)
  assert.equal(h.state.mainRequests.get('A').options, main)
})

test('cloned consultation requests are not recaptured as official reviews', async (t) => {
  const h = host(t)
  await h.capture({ ...reviewOptions(), purpose: 'approval-consult' }, [{ type: 'text-delta', text: 'explanation' }])
  assert.equal(h.state.reviews.size, 0)
  assert.equal(h.state.stats.reviews, 0)
})

test('reconstructed PTC approvals recover inner arguments without inventing a native schema', async (t) => {
  const h = host(t)
  h.append('tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'root', subCallId: 'inner', name: 'shell', arguments: { command: 'echo inner' } })
  h.append('approval/asked', { id: 'approval', callId: 'inner', toolName: 'shell' })
  const { body } = await h.request('/context?sessionId=A&callId=inner')
  const record = h.state.pendings.get(body.consultKey)
  assert.deepEqual(record.exec.args, { command: 'echo inner' })
  assert.equal(record.exec.parent.callId, 'root')
  assert.equal(record.advisorySnapshot, null, 'the absent PTC binding schema must not be guessed')
})

test('block-end-only text is accepted without retry even when a tool block follows', async (t) => {
  const h = host(t), main = h.main(), record = h.pending()
  let calls = 0
  h.ctx.llm.stream = async function* (options) {
    calls++
    assert.equal(options.purpose, 'approval-consult')
    assert.deepEqual(options.messages.slice(0, main.messages.length), main.messages)
    yield { type: 'block-end', block: { type: 'text', text: 'answer' } }
    yield { type: 'block-end', block: { type: 'tool-call', name: 'never-executed' } }
  }
  const ask = await h.request('/ask', { sessionId: 'A', consultKey: record.key, question: 'why?' })
  await turn()
  assert.equal(calls, 1)
  assert.equal(h.state.jobs.get(ask.body.jobId).status, 'done')
  assert.equal(h.injections.length, 1)
})

test('optional plugin detection accepts iterable fibers and requires an active instance', async (t) => {
  const h = host(t, { reviewerMode: 'auto' })
  const fixtures = [undefined, {}, [], { length: 1 }].map((fibers) => ({ fibers, active: false }))
  for (const state of [0, 1, 2, 3, 4, 5]) {
    fixtures.push(
      { fibers: [{ state }], active: state === 2 },
      { fibers: { length: 1, *[Symbol.iterator]() { yield { state } } }, active: state === 2 },
    )
  }
  fixtures.push({ fibers: new Set([{ state: 3 }, { state: 2 }]), active: true })
  for (const { fibers, active } of fixtures) {
    h.ctx.registry.set('review', { name: 'experimental-auto-review', fibers })
    h.ctx.registry.set('timeout', { name: 'approval-timeout', fibers })
    const { body } = await h.request('/context?sessionId=A')
    assert.equal(body.features.reviewerAvailable, active)
    assert.equal(body.features.timeoutAvailable, active)
  }
})

for (const cause of ['eviction', 'timeout']) {
  test(`${cause} aborts active model work before reclaiming it`, async (t) => {
    const h = host(t, { maxPendingPerSession: 1 }), record = h.pending()
    h.main()
    let signal
    h.ctx.llm.stream = async function* (options) {
      signal = options.signal
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    const ask = await h.request('/ask', { sessionId: 'A', consultKey: record.key, question: 'why?' })
    if (cause === 'eviction') h.pending('call-2')
    else { h.state.jobs.get(ask.body.jobId).createdAt -= 11 * 60000; h.sweep() }
    assert.equal(signal.aborted, true)
    await turn()
    assert.equal(h.injections.length, 0)
  })
}
