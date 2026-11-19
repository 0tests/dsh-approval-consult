// Run with Node >=24.9 and a checkout of dsh-v0.2.2-rc.2. No DSH install/API key needed.
// Executes the upstream pure snapshot and message-rendering functions against synthetic logs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { __test } from '../lib/impl.js'
import { host } from './helpers/host.mjs'

const root = process.argv[2]
if (!root) throw new Error('Usage: node tests/upstream-contract.mjs <dsh source checkout>')
const text = readFileSync(resolve(root, 'packages/experimental/auto-review/src/index.ts'), 'utf8')
const start = text.indexOf('/** Return JSON text')
const end = text.indexOf('/** Count members in the raw top-level JSON object.')
assert.ok(start >= 0 && end > start, 'upstream snapshot helpers must be located explicitly')
const js = stripTypeScriptTypes(text.slice(start, end))
const upstream = vm.runInNewContext(`${js}\n;({ snapshotAutoReview, reviewMessages })`, { deepFreeze: (value) => value })
const marker = 'const REVIEW_POLICY = `'
const policyStart = text.indexOf(marker) + marker.length
const policy = text.slice(policyStart, text.indexOf('`', policyStart))
// 仓库在 Windows 上可能以 CRLF 检出 review-policy.txt；与官方 LF 文本比较前统一换行符。
const normalizeEol = (value) => value.replace(/\r\n?/g, '\n')
assert.equal(normalizeEol(readFileSync(new URL('../lib/review-policy.txt', import.meta.url), 'utf8')), normalizeEol(policy))

for (const mode of ['native', 'ptc-inner']) {
  const args = { command: 'echo test' }
  const schema = { name: 'shell', description: 'Test shell', parameters: { type: 'object' } }
  const rootName = mode === 'native' ? 'shell' : 'run_code'
  const events = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Test request' }] } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: 'root', name: rootName, arguments: JSON.stringify(args) }] } } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'root', name: rootName, arguments: JSON.stringify(args) } },
  ]
  if (mode === 'ptc-inner') events.push({ type: 'tool/ptc-dispatch-start', data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'inner', name: 'shell', arguments: args } })
  // Reuse both IDs in an earlier step, with a historical PTC child before a later user message.
  const earlier = { turn: 0, step: 1 }
  const priorRoot = { type: 'tool-call', id: 'root', name: 'run_code', arguments: '{"prior":true}' }
  events.unshift(
    { type: 'step/start', data: earlier },
    { type: 'assistant/message', data: { ...earlier, message: { content: [priorRoot] } } },
    { type: 'tool/call', data: { ...earlier, callId: 'root', name: priorRoot.name, arguments: priorRoot.arguments } },
    { type: 'tool/ptc-dispatch-start', data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'inner', name: 'prior_child', arguments: {} } },
    { type: 'step/end', data: earlier },
  )
  events.forEach((event, seq) => { event.seq = seq })
  const agent = { session: {
    header: { cwd: '/project' }, surface: { nodes: events.filter(e => ['assistant/message', 'user/message'].includes(e.type)).map(e => e.seq) }, snapshotEvents: () => events, isOwnSeq: () => true,
    requestHeader: () => ({ config: { provider: 'mock', model: 'mock' }, tools: [schema] }),
  } }
  const exec = { name: 'shell', arguments: args, rootCallId: 'root', callId: mode === 'native' ? 'root' : 'inner',
    ...(mode === 'ptc-inner' ? { parent: { callId: 'root' }, schema } : {}) }
  const snapshot = upstream.snapshotAutoReview(agent, exec, '/project', new Map())
  const options = { system: policy, messages: upstream.reviewMessages(snapshot) }
  const parsed = __test.parseReviewRequest(options)
  assert.equal(parsed.action.mode, mode)
  assert.equal(parsed.action.name, 'shell')
  assert.deepEqual(__test.normalizeArguments(parsed.action.arguments), args)
  assert.equal(parsed.action.description, schema.description)
  assert.equal(parsed.historyCount, mode === 'native' ? 3 : 4)
  const cleanups = []
  const h = host({ after: fn => cleanups.unshift(fn) })
  try {
    Object.assign(h.session, agent.session)
    h.hooks.get('tools/pre-execute').fn({ ...exec, agent: h.agent }, () => null)
    await h.hooks.get('approval/request').fn({ agent: h.agent, callId: exec.callId, toolName: exec.name }, () => 'rejected')
    const rebuilt = [...h.state.pendings.values()].at(-1).advisorySnapshot
    const items = messages => Array.from(messages.slice(1), msg => {
      const item = JSON.parse(msg.content[0].text)
      if (item.kind === 'tool-call') item.arguments = JSON.parse(item.arguments)
      return item
    })
    assert.deepEqual(items(rebuilt.messages), items(options.messages))
  } finally { for (const cleanup of cleanups) await cleanup() }
  console.log(`upstream rc.2 ${mode}: snapshot -> messages -> plugin parser OK`)
}
console.log('upstream rc.2 policy: byte-for-byte match')
