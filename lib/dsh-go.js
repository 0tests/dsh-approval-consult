/** Optional DSH Go native panel. No Flutter code or SDK runtime dependency.
 * Selection/drafts belong to the view, never a session-wide server variable:
 * two devices may consult different pending calls in the same session.
 */
import { createHash, randomUUID } from 'node:crypto'

const PANEL = 'consult'
const LIVE = 'consult-live'
const PAGE_SIZE = 8
const bind = (path) => ({ $: `data.${path}` })
const clip = (value, count = 180, budget = 600) => {
  let out = '', bytes = 0, chars = 0
  for (const char of String(value ?? '')) {
    const size = Buffer.byteLength(JSON.stringify(char)) - 2
    if (chars >= count || bytes + size > budget) break
    out += char; bytes += size; chars++
  }
  return out
}
const isZh = (locale) => !locale || /^zh\b/i.test(locale)
const isScoped = (scope) => typeof scope?.callId === 'string' && scope.callId.length > 0
const words = (locale) => isZh(locale) ? {
  notice: '咨询不会批准或拒绝工具。决定请回到 App 审批卡。选择记录后可连续追问；断线时任务继续，重连后重新选择记录查看。',
  pick: '选择审批记录', empty: '本会话暂无审批记录',
  waiting: '待审批', ended: '已结束', executor: '执行 AI', reviewer: '审查 AI',
  target: '提问对象', question: '问题', ask: '发送问题', review: '重新评估', stop: '停止回答',
  history: '记录翻页', previous: '上一页', next: '下一页', latest: '最近回答（实时摘要）',
  reader: '回答全文', conversation: '所选审批的问答', copy: '复制本页', refresh: '刷新本页',
  oldApp: '请升级 DSH Go，以使用原生咨询输入框。', failed: '操作失败',
  choose: '请先选择审批记录。', invalid: '问题或提问对象无效。',
  tooLong: '问题过长，请缩短后发送。', sent: '已提交，可查看实时回答。',
  reviewing: '已读取或开始评估，请查看记录状态。', stopped: '已停止所选审批的咨询任务。',
  missing: '记录已过期或不属于当前会话。', evaluating: '正在评估',
  reload: '重读审批列表', live: '实时回答', uncertain: '回执不明时，先核对问答记录再重试。', receipt: '已提交。',
  scopedNotice: '已定位当前审批。咨询不会批准或拒绝工具，决定请回到审批卡。断线重连后仍查看这条审批。',
  changed: '这条审批有新的问答。请先核对最近的问题，再点发送。', endedRead: '这次审批已结束，只能回看记录。', emptyCopy: '本页还没有可复制的正文。', official: '官方审查', advisory: '咨询重评', card: '审批卡记录', locating: '暂无当前审批记录，请稍后重读审批列表。',
} : {
  notice: 'Consultation does not approve or reject tools. Use the App approval card to decide. Tasks continue offline; select the record again after reconnecting.',
  pick: 'Select an approval', empty: 'No approval records in this session',
  waiting: 'Pending', ended: 'Ended', executor: 'Executor', reviewer: 'Reviewer',
  target: 'Ask', question: 'Question', ask: 'Send question', review: 'Re-evaluate', stop: 'Stop answers',
  history: 'Browse records', previous: 'Previous', next: 'Next', latest: 'Latest answers (live excerpts)',
  reader: 'Full answer', conversation: 'Selected approval history', copy: 'Copy page', refresh: 'Refresh page',
  oldApp: 'Update DSH Go to use native consultation inputs.', failed: 'Action failed',
  choose: 'Select an approval first.', invalid: 'Invalid question or target.',
  tooLong: 'Question is too long. Shorten it before sending.', sent: 'Submitted. Check Live answers.',
  reviewing: 'Review loaded or started.', stopped: 'Consultation tasks stopped.',
  missing: 'This record expired or belongs to another session.', evaluating: 'Evaluating',
  reload: 'Reload approvals', live: 'Live answers', uncertain: 'If a receipt is missing, check the thread before retrying.', receipt: 'Submitted.',
  scopedNotice: 'Consulting this approval. Consultation does not approve or reject tools; return to the approval card to decide. Reconnecting keeps this approval.',
  changed: 'Thread changed. Review it before sending.', endedRead: 'This approval ended. History is read-only.', emptyCopy: 'This page has no text to copy.', official: 'Official review', advisory: 'Consultation assessment', card: 'Approval card', locating: 'Approval unavailable. Reload approvals to check again.',
}

// Pages fit both the text component and the 32 KiB data/effect budget,
// including escaped control characters. Code points are never split.
export function answerPages(text) {
  const pages = []
  let page = '', bytes = 0, chars = 0
  for (const char of String(text ?? '')) {
    const size = Buffer.byteLength(JSON.stringify(char)) - 2
    if (bytes + size > 4000 || chars >= 1600) { pages.push(page); page = ''; bytes = 0; chars = 0 }
    page += char
    bytes += size
    chars++
  }
  pages.push(page)
  return pages
}

function label(record, w) {
  const approval = record.approvalId && record.approvalId !== record.callId ? `${record.approvalId} · ` : ''
  return clip(`${approval}${record.toolName} · ${record.callId ?? record.consultKey} · ${record.resolved ? w.ended : w.waiting}`)
}

function recordItems(records, w, browse = false) {
  return records.map((r) => ({
    title: label(r, w),
    subtitle: clip([clip(r.executor?.argumentsPreview, 90, 300), r.reviewBusy ? w.evaluating : r.reviewError || r.reviewer?.reason || r.reason].filter(Boolean).join(' · ')),
    action: { id: 'select', args: { consultKey: r.consultKey, browse } },
  }))
}

function entries(records) {
  return records.flatMap((r) => ['executor', 'reviewer'].flatMap((target) =>
    (r.threads?.[target] ?? []).map((entry) => ({ record: r, target, entry }))))
    .sort((a, b) => b.entry.at - a.entry.at)
}

function pageIndex(size, value, pageSize = PAGE_SIZE) {
  const page = Number.isSafeInteger(value.page) ? value.page : 0
  const delta = Number.isSafeInteger(value.direction) ? Math.sign(value.direction) : 0
  return Math.max(0, Math.min(Math.ceil(size / pageSize) - 1, page + delta))
}

function threadPage(record, value, w) {
  const all = entries([record])
  const page = pageIndex(all.length, value)
  const items = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(({ target, entry }) => ({
    title: clip(`${w[target]} · ${entry.status} · ${entry.question}`),
    action: { id: 'read', args: { consultKey: record.consultKey, target, threadId: entry.id, page: 0 } },
  }))
  const base = { consultKey: record.consultKey, page }
  return { ...base, controls: pager(w, 'threads', base).items, items }
}

function detail(record, w) {
  const review = record.reviewer
  const source = review?.advisory ? w.advisory : review?.synthetic ? w.card : w.official
  const verdict = [review?.risk, review?.decision].filter(Boolean).join(' · ')
  return [record.reason, record.executor?.argumentsPreview, verdict && `${source} · ${verdict}`,
    record.reviewBusy ? w.evaluating : record.reviewError || review?.reason]
    .filter(Boolean).map((line) => clip(line, 400)).join('\n')
}

function latestAnswers(records, w) {
  return entries(records).slice(0, PAGE_SIZE).map(({ record, target, entry }) => ({
    title: clip(`${w[target]} · ${record.callId ?? record.toolName} · ${entry.status} · ${entry.question}`),
    subtitle: clip(entry.error || Array.from(String(entry.answer ?? '').slice(-640)).slice(-160).join(''), 180),
  }))
}

const action = (label, id, args = {}) => ({ label, action: { id, args } })
const buttonRow = (...items) => ({ type: 'actions', items })

function pager(w, id, base) {
  return buttonRow(action(w.previous, id, { ...base, direction: -1 }),
    action(w.refresh, id, { ...base, direction: 0 }), action(w.next, id, { ...base, direction: 1 }))
}

function headOf(record) {
  return ['executor', 'reviewer'].map((target) => record.threads?.[target]?.at(-1)?.id ?? '').join('|')
}

function digest(...values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
}

// A reconnect keeps an unsent draft only while its approval and observed thread
// head match. If an uncertain send reached the host, the new form has a new bind.
// A form opened on another device has its own operation seed.
function compose(record, w, maxLength, canReview, initial, previous) {
  const key = record.consultKey
  const head = previous?.head ?? headOf(record)
  const slot = 'q' + digest(key, head)
  const seed = randomUUID()
  const args = { consultKey: key, head, slot, seed, initial }
  // The bridge resolves template bindings only in the view, not inside data
  // returned by a patch. A manually selected editor carries literal action args.
  if (previous) {
    args.clear = previous.clear
    args.expected = previous.expected
    if (previous.seed) args.seed = previous.seed
  }
  if (initial) {
    args.next = bind(slot + '.next')
    args.clear = bind(slot + '.clear')
    args.expected = bind(slot + '.expected')
  }
  return { type: 'form', submitLabel: w.ask, submit: { id: 'ask', args }, children: [
    ...(canReview ? [{ type: 'select', label: w.target, placeholder: w.executor, bind: `data.${slot}.target`,
      options: [{ label: w.executor, value: 'executor' }, { label: w.reviewer, value: 'reviewer' }] }] : []),
    { type: 'textField', label: w.question, bind: `data.${slot}.question`, multiline: true, maxLines: 5, required: true, maxLength },
  ] }
}

function editor(record, w, maxLength, canReview, initial = false, previous) {
  const args = { consultKey: record.consultKey }
  return [
    { type: 'text', text: label(record, w) },
    { type: 'text', text: detail(record, w) },
    ...(!record.resolved ? [
      compose(record, w, maxLength, canReview, initial, previous),
      buttonRow(...(canReview ? [action(w.review, 'review', args)] : []), action(w.stop, 'stop', args)),
    ] : []),
    ...(initial ? [
      { type: 'list', title: w.conversation, items: threadPage(record, {}, w).items },
      buttonRow(action(w.history, 'threads', { ...args, page: 0, direction: 0 })),
    ] : []),
  ]
}

export function registerDshGo(ctx, api) {
  if (typeof ctx.inject !== 'function') return () => {}
  const cleanups = new Set()
  let disposed = false
  const fiber = ctx.inject(['dshGo'], (goCtx) => {
    const bridge = goCtx.dshGo
    if (disposed || typeof bridge?.panel !== 'function') return
    const maxLength = Math.min(600, api.maxQuestionChars)
    const canReview = () => api.reviewerAvailable?.() !== false
    const available = (scope) => {
      if (!scope?.sessionId) return { records: [], complete: false }
      const set = api.recordSet?.(scope) ?? { records: api.records(scope), complete: false }
      return { complete: set.complete, records: set.records.filter((r) => !isScoped(scope) || r.callId === scope.callId) }
    }
    const get = (scope, key, w) => {
      if (!scope?.sessionId || typeof key !== 'string' || !key) throw new Error(w.choose)
      const record = available(scope).records.find((r) => r.consultKey === key)
      if (!record) throw new Error(w.missing)
      return record
    }
    const guard = (fn) => async (scope, event) => {
      const w = words(event?.locale)
      try { return await fn(scope, event?.value ?? {}, w) }
      catch (error) { return { toast: clip(`${w.failed}: ${error?.message ?? error}`, 40) } }
    }
    function reader(scope, value, w) {
      const record = get(scope, value.consultKey, w)
      if (!['executor', 'reviewer'].includes(value.target)) throw new Error(w.invalid)
      const entry = record.threads?.[value.target]?.find((e) => e.id === value.threadId)
      if (!entry) throw new Error(w.missing)
      const pages = answerPages(entry.answer || entry.error || '')
      const page = pageIndex(pages.length, value, 1)
      const args = { consultKey: record.consultKey, target: value.target, threadId: entry.id, page }
      return { ...args, controls: [...pager(w, 'read', args).items, action(w.copy, 'copy', args)],
        title: clip(`${w.reader} · ${page + 1}/${pages.length} · ${entry.status} · ${entry.question}`), text: pages[page] }
    }

    // Production Go merges action patches into all matching feeds. Without a
    // data callback it applies our editing/reading patches on the tapping device
    // only. The separate live panel below carries session-wide, read-only data.
    const consult = bridge.panel(PANEL, {
      view(scope, caps) {
        const w = words(caps?.locale)
        if (!['form', 'textField', 'select'].every((type) => caps?.components?.includes(type))) {
          return { type: 'stack', children: [{ type: 'callout', tone: 'info', text: w.oldApp }] }
        }
        const { records, complete } = available(scope)
        const pending = records.filter((r) => !r.resolved)
        const scoped = isScoped(scope)
        const candidates = scoped ? records : pending
        const current = complete && candidates.length === 1 ? candidates[0] : null
        // In a direct editor, browsing another record remains read-only. To
        // switch to a newly pending call, explicitly reload the approval list.
        return { v: 2, type: 'stack', children: [
          { type: 'callout', tone: 'info', text: scoped && current ? w.scopedNotice : w.notice },
          ...(!current ? [{ type: 'text', text: records.length ? w.pick : scoped ? w.locating : w.empty }] : []),
          ...(current ? editor(current, w, maxLength, canReview(), true) : []),
          ...(records.length > (current ? 1 : 0) ? [
            { type: 'list', title: current ? w.history : w.pick, items: recordItems(records.slice(0, PAGE_SIZE), w, Boolean(current)) },
            ...(records.length > PAGE_SIZE ? [
              { type: 'list', title: w.history, items: bind('history.items') },
              pager(w, 'history', { page: bind('history.page'), browse: Boolean(current) }),
            ] : []),
          ] : []),
          { type: 'stack', children: bind('editor') },
          { type: 'text', text: bind('receipt') },
          { type: 'list', title: w.conversation, items: bind('conversation.items') },
          { type: 'actions', items: bind('conversation.controls') },
          { type: 'text', text: bind('reader.title') }, { type: 'text', text: bind('reader.text') },
          { type: 'actions', items: bind('reader.controls') },
          buttonRow(action(w.live, 'live'), action(w.reload, 'reload')),
          { type: 'text', text: w.uncertain },
        ] }
      },
      actions: {
        select: guard((scope, value, w) => {
          const record = get(scope, value.consultKey, w)
          const model = value.browse ? [{ type: 'text', text: label(record, w) }, { type: 'text', text: detail(record, w) }]
            : editor(record, w, maxLength, canReview())
          return { patch: { editor: model, conversation: threadPage(record, {}, w), reader: null, receipt: null } }
        }),
        history: guard((scope, value, w) => {
          const records = available(scope).records
          const page = pageIndex(records.length, value)
          const items = recordItems(records.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), w, value.browse === true)
          return { patch: { history: { page, items } } }
        }),
        threads: guard((scope, value, w) => ({ patch: { conversation: threadPage(get(scope, value.consultKey, w), value, w) } })),
        ask: guard(async (scope, value, w) => {
          const record = get(scope, value.consultKey, w)
          if (record.resolved) throw new Error(w.endedRead)
          const { head, seed, slot } = value
          if (typeof head !== 'string' || slot !== 'q' + digest(record.consultKey, head) || !/^[a-f0-9-]{36}$/.test(seed)) throw new Error(w.invalid)
          const question = value.values?.[`data.${slot}.question`]
          const target = value.values?.[`data.${slot}.target`] || 'executor'
          if (typeof question !== 'string' || !question.trim() || !['executor', 'reviewer'].includes(target)) throw new Error(w.invalid)
          if (Array.from(question).length > maxLength || question.length > api.maxQuestionChars || Buffer.byteLength(JSON.stringify(value)) > 4096) throw new Error(w.tooLong)
          const token = typeof value.next === 'string' && /^[a-f0-9-]{36}$/.test(value.next) ? value.next : seed
          const requestId = 'go:' + digest(token, record.consultKey)
          const observed = headOf(record)
          const alreadySent = ['executor', 'reviewer'].some((side) => record.threads?.[side]?.some((e) => e.requestId === requestId))
          // A re-read has no client identity from the stock protocol. If a
          // previously in-flight send arrived since this form's snapshot, this
          // tap may only reconcile; another explicit tap can commit new work.
          if (!alreadySent && observed !== (typeof value.expected === 'string' ? value.expected : head)) {
            const latest = entries([record])[0]
            const patch = { [slot]: { expected: observed },
              receipt: clip([w.changed, latest?.entry.question].filter(Boolean).join(' ')) }
            if (!value.initial) patch.editor = editor(record, w, maxLength, canReview(), false,
              { head, expected: observed, seed, clear: value.clear === true })
            return [{ patch }, { toast: clip(w.changed, 40) }]
          }
          await api.ask(scope, { consultKey: record.consultKey, target, question, requestId })
          const updated = get(scope, record.consultKey, w)
          const expected = headOf(updated)
          // The draft controller clears only when its remote value changes.
          // Alternate null/empty on this device, preserving edits made in flight.
          const cleared = value.clear !== true
          const patch = { [slot]: { question: cleared ? '' : null, next: randomUUID(), clear: cleared, expected },
            receipt: clip(`${w.receipt} ${question.trim()}`) }
          if (!value.initial) {
            patch.editor = editor(updated, w, maxLength, canReview(), false, { head, clear: cleared, expected })
          }
          return [{ patch }, { toast: w.sent }]
        }),
        review: guard((scope, value, w) => { get(scope, value.consultKey, w); api.review(scope, value.consultKey); return { toast: w.reviewing } }),
        stop: guard((scope, value, w) => { get(scope, value.consultKey, w); api.stop(scope, value.consultKey); return { toast: w.stopped } }),
        read: guard((scope, value, w) => ({ patch: { reader: reader(scope, value, w) } })),
        copy: guard((scope, value, w) => {
          const text = reader(scope, value, w).text
          // Go strips non-printable control characters before accepting copy.
          return /[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? { copy: text } : { toast: w.emptyCopy }
        }),
        live: () => ({ open: 'panel:' + LIVE }),
        reload: () => ({ refresh: true }),
      },
    })
    const live = bridge.panel(LIVE, {
      view: () => ({ type: 'stack', children: [{ type: 'text', text: bind('summary') }, { type: 'list', items: bind('answers') }, { type: 'list', items: bind('recent') }] }),
      data(scope, emit, caps) {
        const w = words(caps?.locale)
        let last = ''
        const update = () => {
          const { records } = available(scope)
          const data = { summary: records.length ? w.latest : w.empty, answers: latestAnswers(records, w),
            recent: recordItems(records.slice(0, PAGE_SIZE), w).map(({ title, subtitle }) => ({ title, subtitle })) }
          const json = JSON.stringify(data)
          if (json !== last) { last = json; emit(data) }
        }
        update()
        const timer = setInterval(update, 500)
        timer.unref?.()
        const stop = () => { clearInterval(timer); cleanups.delete(stop) }
        cleanups.add(stop)
        return stop
      },
    })
    for (const unregister of [consult, live]) if (typeof unregister === 'function') cleanups.add(unregister)
  })
  return () => {
    disposed = true
    for (const cleanup of cleanups) cleanup()
    cleanups.clear()
    if (typeof fiber === 'function') fiber()
    else fiber?.dispose?.()
  }
}
