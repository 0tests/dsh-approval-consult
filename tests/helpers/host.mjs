import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { apply } from '../../lib/impl.js'
const STATE = '__DSH_APPROVAL_CONSULT_STATE_V1__'
const schema = { name: 'shell', description: 'Run a command', parameters: { type: 'object' } }
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

export function host(t, config = {}, options = {}) {
  delete globalThis[STATE]
  const routes = new Map(), hooks = new Map(), intervals = new Map(), events = [], injections = []
  const session = {
    id: 'A', header: { cwd: '/project' }, surface: { nodes: [] }, isOwnSeq: () => true,
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'mock', model: 'mock' }, tools: [schema] }),
  }
  const agent = { session, status: 'running', ctx: { on: () => () => {} }, inject: (m) => injections.push(m) }
  const ctx = {
    registry: new Map(), agents: { list: () => [agent], get: (id) => id === session.id ? agent : undefined }, sessions: {},
    webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path) } },
    connection: { requestRejection: () => undefined },
    on: (name, fn, prepend) => { hooks.set(name, { fn, prepend }); return () => hooks.delete(name) },
    inject: (_services, fn) => { fn(ctx); return { dispose() {} } },
    llm: { stream: async function* () { yield { type: 'text-delta', text: 'test answer' } } },
    ...options.services,
  }
  const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => { const timer = { unref() {} }; intervals.set(timer, { fn, ms }); return timer }
  let dispose
  try { dispose = apply(ctx, { reviewerMode: 'on', ...config }, { log: { info() {}, warn() {}, error() {} }, native: options.native }) }
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
    pending(id = 'call-1', args = { command: 'echo test' }, ptc = false, review) {
      const exec = { agent, name: schema.name, callId: id, rootCallId: ptc ? 'root' : id, arguments: args,
        ...(ptc ? { parent: { callId: 'root' }, schema } : {}) }
      const position = { turn: 1, step: events.length }
      append('step/start', position)
      const root = { id: exec.rootCallId, type: 'tool-call', name: ptc ? 'run_code' : schema.name, arguments: JSON.stringify(ptc ? { label: 'test' } : args) }
      append('assistant/message', { ...position, message: { content: [root] } }, true)
      append('tool/call', { ...position, callId: root.id, name: root.name, arguments: root.arguments })
      if (ptc) append('tool/ptc-dispatch-start', { subCallId: id, rootCallId: 'root', parentCallId: 'root', name: schema.name, arguments: args })
      const beforeApproval = hooks.get('tools/pre-execute').fn(exec, review ?? (() => null))
      const ask = () => {
        append('approval/asked', { id, callId: id, toolName: schema.name })
        const completion = deferred()
        const result = hooks.get('approval/request').fn({ agent, callId: id, toolName: schema.name }, () => completion.promise)
        t.after(async () => { completion.resolve('rejected'); await result })
        return [...globalThis[STATE].pendings.values()].at(-1)
      }
      return review ? Promise.resolve(beforeApproval).then(ask) : ask()
    },
    sweep() { for (const timer of intervals.values()) if (timer.ms === 60000) timer.fn() },
  }
}
