// Public hooks and HTTP routes with an in-memory host; no provider calls or disk writes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { __test } from '../lib/impl.js'
import { host } from './helpers/host.mjs'

const policy = readFileSync(new URL('../lib/review-policy.txt', import.meta.url), 'utf8')
const schema = { name: 'shell', description: 'Run a command', parameters: { type: 'object' } }
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const turn = () => new Promise((resolve) => setImmediate(resolve))

test('a repeated ask identifier returns the original task after a lost acknowledgement', async (t) => {
  const h = host(t); h.main(); const r = h.pending()
  const body = { sessionId: 'A', consultKey: r.key, target: 'executor', question: 'why?', requestId: 'browser:lost-ack' }
  const [first, replay] = await Promise.all([h.request('/ask', body), h.request('/ask', body)])
  assert.equal(first.status, 200); assert.deepEqual(replay.body, first.body)
  await turn()
  assert.equal(r.threads.executor.length, 1)
  assert.equal(h.state.stats.asks, 1)
  const snapshot = await h.request('/context?sessionId=A&consultKey=' + encodeURIComponent(r.key))
  assert.equal(snapshot.body.threads.executor[0].requestId, body.requestId)
})

test('ask deduplication remains scoped to the approval and rejects changed intent', async (t) => {
  const h = host(t); h.main(); const r = h.pending()
  const body = { sessionId: 'A', consultKey: r.key, question: 'why?', requestId: 'browser:one' }
  await h.request('/ask', body)
  for (const change of [{ question: 'different' }, { target: 'reviewer' }]) {
    const result = await h.request('/ask', { ...body, ...change })
    assert.equal(result.status, 409); assert.equal(result.body.code, 'request-conflict')
  }
  assert.notEqual((await h.request('/ask', { ...body, sessionId: 'B' })).status, 200)
  assert.equal(r.threads.executor.length, 1)
})

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


for (const mode of ['native', 'ptc-inner']) {
  test(`rc.2 ${mode}: capture, match exact action and preserve the review prefix`, async (t) => {
    const h = host(t), original = reviewOptions(mode)
    const record = await h.pending('call-1', { command: 'echo test' }, mode === 'ptc-inner', () => h.capture(original, [
      { type: 'text-delta', text: '{"risk":"medium","decision":"deny","reason":"needs confirmation"}' }, { type: 'finish', reason: { kind: 'stop' } },
    ]))
    assert.equal(record.review, h.state.reviews.get('A')[0])
    assert.equal(record.review.historyCount, 1)
    assert.equal(record.review.action.mode, mode)
    let sent
    h.ctx.llm.stream = async function* (options) { sent = options; yield { type: 'text-delta', text: 'explanation' } }
    assert.equal((await h.request('/ask', { sessionId: 'A', consultKey: record.key, target: 'reviewer', question: 'why?' })).status, 200)
    await turn()
    assert.deepEqual(sent.messages.slice(0, original.messages.length), original.messages)
    assert.notEqual(sent.system, original.system)
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
  const record = await h.pending(undefined, undefined, false, () => h.capture(original, [
    { type: 'text-delta', text: '{"risk":"medium","decision":"deny"}' }, { type: 'finish', reason: { kind: 'stop' } },
  ]))
  assert.equal(record.review.options, original)
})

for (const ptc of [false, true]) {
  test(`advisory ${ptc ? 'PTC' : 'native'} retains arguments and uses the bundled policy's item format`, async (t) => {
    const h = host(t), args = { command: 'echo pending', text: 'PENDING_ACTION\n\nnot a delimiter' }
    const record = h.pending('call-1', args, ptc)
    assert.equal(h.hooks.get('tools/pre-execute').prepend, true)
    assert.deepEqual(__test.normalizeArguments(record.advisorySnapshot.action.arguments), args)
    let sent
    h.ctx.llm.stream = async function* (options) { sent = options; yield { type: 'text-delta', text: '{"risk":"low","decision":"allow"}' }; yield { type: 'finish', reason: { kind: 'stop' } } }
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

test('uncaptured execution identity cannot inherit an older review of identical arguments', async t => {
  const h = host(t)
  await h.capture(reviewOptions(), [{ type: 'text-delta', text: '{"risk":"low","decision":"allow"}' }, { type: 'finish', reason: { kind: 'stop' } }])
  assert.equal(h.pending().review, null)
})

test('live and recovered denials without an optional reason retain the card as their source', async t => {
  const h = host(t)
  const reason = 'Auto review denied tool "shell"'
  h.append('approval/asked', { id: 'a', callId: 'first', toolName: 'shell', reason })
  await h.hooks.get('approval/request').fn({ agent: h.agent, callId: 'first', toolName: 'shell', reason }, () => 'rejected')
  h.append('approval/decided', { id: 'a', outcome: 'rejected' })
  h.append('approval/asked', { id: 'b', callId: 'second', toolName: 'shell', reason })
  await h.request('/context?sessionId=A&callId=second')
  const rows = [...h.state.pendings.values()]
  assert.equal(rows.length, 2)
  for (const record of rows) {
    assert.equal(record.review.synthetic, true)
    assert.equal(record.review.decision.decision, 'deny')
    assert.equal(record.review.decision.risk, null)
  }
})

test('captured and advisory streams require one final text block and normal termination', async t => {
  const h = host(t)
  const text = { type: 'text-delta', index: 1, text: '{"risk":"low","decision":"allow"}' }
  const stop = { type: 'finish', reason: { kind: 'stop' } }
  const cases = [[text], [text, stop, stop], [text, { ...text, index: 2 }, stop],
    [text, { type: 'tool-call-delta', index: 2 }, stop], [text, { type: 'finish', reason: { kind: 'max-tokens' } }]]
  for (const [i, chunks] of cases.entries()) {
    const captured = await h.pending('captured-' + i, undefined, false, () => h.capture(reviewOptions(), chunks))
    assert.equal(captured.review.decision, null)
    assert.ok(captured.review.error)
    const advisory = h.pending('advisory-' + i)
    h.ctx.llm.stream = async function* () { yield* chunks }
    const result = await h.request('/review', { sessionId: 'A', consultKey: advisory.key })
    assert.equal(result.body.ok, false)
    assert.equal(advisory.advisoryReview.decision, null)
  }
})

test('reconstructing an older approval never borrows a reused call ID or a later header or surface', async t => {
  const h = host(t)
  const first = h.pending('repeat', { step: 'original' })
  const originalApproval = h.events.find(event => event.type === 'approval/asked')
  // Simulate reactivation with only the durable log. Later work reused the same call ID.
  originalApproval.data.id = 'original'
  h.state.pendings.delete(first.key)
  h.state.pendingBySession.clear()
  const position = { turn: 3, step: 2 }
  h.append('step/start', position)
  h.append('tool/call', { ...position, callId: 'repeat', name: 'shell', arguments: '{"step":"later"}' })
  h.append('request/header', { header: { config: { provider: 'new', model: 'new' } } })
  const { body } = await h.request('/context?sessionId=A&callId=repeat&approvalId=original')
  const recovered = h.state.pendings.get(body.consultKey)
  assert.deepEqual(recovered.exec.args, { step: 'original' })
  assert.equal(recovered.advisorySnapshot, null)
})
