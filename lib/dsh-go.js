/** Optional DSH Go native panel. No Flutter code or SDK runtime dependency.
 * Selection/drafts belong to the view, never a session-wide server variable:
 * two devices may consult different pending calls in the same session.
 */
const PANEL = 'consult'
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
  pick: '选择审批记录', current: '当前审批', selected: '尚未选择审批', empty: '本会话暂无审批记录',
  waiting: '待审批', ended: '已结束', executor: '执行 AI', reviewer: '审查 AI',
  target: '提问对象', question: '问题', ask: '发送问题', review: '重新评估', stop: '停止回答',
  history: '记录翻页', previous: '上一页', next: '下一页', latest: '最近回答（实时摘要）',
  reader: '回答全文', conversation: '所选审批的问答', copy: '复制本页', read: '选择回答查看全文', refresh: '刷新本页',
  oldApp: '请升级 DSH Go，以使用原生咨询输入框。', failed: '操作失败',
  choose: '请先选择审批记录。', invalid: '问题或提问对象无效。',
  tooLong: '问题过长，请缩短后发送。', sent: '已提交，回答会自动更新。',
  reviewing: '已读取或开始评估，请查看记录状态。', stopped: '已停止所选审批的咨询任务。',
  missing: '记录已过期或不属于当前会话。', evaluating: '正在评估',
  scopedNotice: '已定位当前审批。咨询不会批准或拒绝工具，决定请回到审批卡。断线重连后仍查看这条审批。',
  locating: '正在等待当前审批记录，暂时无法提问。',
} : {
  notice: 'Consultation does not approve or reject tools. Use the App approval card to decide. Tasks continue offline; select the record again after reconnecting.',
  pick: 'Select an approval', current: 'Current approval', selected: 'No approval selected', empty: 'No approval records in this session',
  waiting: 'Pending', ended: 'Ended', executor: 'Executor', reviewer: 'Reviewer',
  target: 'Ask', question: 'Question', ask: 'Send question', review: 'Re-evaluate', stop: 'Stop answers',
  history: 'Browse records', previous: 'Previous', next: 'Next', latest: 'Latest answers (live excerpts)',
  reader: 'Full answer', conversation: 'Selected approval history', copy: 'Copy page', read: 'Select an answer to read it in full', refresh: 'Refresh page',
  oldApp: 'Update DSH Go to use native consultation inputs.', failed: 'Action failed',
  choose: 'Select an approval first.', invalid: 'Invalid question or target.',
  tooLong: 'Question is too long. Shorten it before sending.', sent: 'Submitted. Answers update live.',
  reviewing: 'Review loaded or started.', stopped: 'Consultation tasks stopped.',
  missing: 'This record expired or belongs to another session.', evaluating: 'Evaluating',
  scopedNotice: 'Consulting this approval. Consultation does not approve or reject tools; return to the approval card to decide. Reconnecting keeps this approval.',
  locating: 'Waiting for this approval record. Questions are unavailable.',
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
  return clip(`${record.toolName} · ${record.callId ?? record.consultKey} · ${record.resolved ? w.ended : w.waiting}`)
}

function recordItems(records, w) {
  return records.map((r) => ({
    title: label(r, w),
    subtitle: clip(r.reviewBusy ? w.evaluating : r.reviewError || r.reviewer?.reason || r.reason || ''),
    action: { id: 'select', args: { consultKey: r.consultKey } },
  }))
}

function entries(records) {
  return records.flatMap((r) => ['executor', 'reviewer'].flatMap((target) =>
    (r.threads?.[target] ?? []).map((entry) => ({ record: r, target, entry }))))
    .sort((a, b) => b.entry.at - a.entry.at)
}

function view(locale, maxLength, caps, canReview, scoped) {
  const w = words(locale)
  if (!['form', 'textField', 'select'].every((type) => caps?.components?.includes(type))) {
    return { type: 'stack', children: [
      { type: 'callout', tone: 'info', text: w.oldApp },
      { type: 'text', text: bind('summary') },
    ] }
  }
  const selectedArgs = { consultKey: bind('form.consultKey') }
  const readerArgs = (direction = 0) => ({
    consultKey: bind('reader.consultKey'), target: bind('reader.target'),
    threadId: bind('reader.threadId'), page: bind('reader.page'), direction,
  })
  return { v: 2, type: 'stack', children: [
    { type: 'callout', tone: 'info', text: scoped ? w.scopedNotice : w.notice },
    { type: 'text', text: bind('summary') },
    ...(!scoped ? [{ type: 'list', title: w.pick, items: bind('recent') },
    { type: 'list', title: w.history, items: bind('history.items') },
    { type: 'actions', items: [
      { label: w.previous, action: { id: 'history', args: { page: bind('history.page'), direction: -1 } } },
      { label: w.next, action: { id: 'history', args: { page: bind('history.page'), direction: 1 } } },
    ] }] : []),
    { type: 'text', text: bind('selection') },
    { type: 'text', text: bind('detail') },
    { type: 'form', submit: { id: 'ask', args: selectedArgs }, submitLabel: w.ask, children: [
      { type: 'select', label: w.target, bind: 'data.form.target', readOnly: bind('form.locked'), required: true, options: [
        { label: w.executor, value: 'executor' }, ...(canReview ? [{ label: w.reviewer, value: 'reviewer' }] : []),
      ] },
      { type: 'textField', label: w.question, bind: 'data.form.question', readOnly: bind('form.locked'), multiline: true, maxLines: 5, required: true, maxLength },
    ] },
    { type: 'actions', items: [
      ...(canReview ? [{ label: w.review, action: { id: 'review', args: selectedArgs } }] : []),
      { label: w.stop, action: { id: 'stop', args: selectedArgs } },
    ] },
    { type: 'list', title: w.latest, items: bind('answers') },
    { type: 'list', title: w.conversation, items: bind('conversation.items') },
    { type: 'actions', items: [-1, 0, 1].map((direction) => ({
      label: direction < 0 ? w.previous : direction > 0 ? w.next : w.refresh,
      action: { id: 'threads', args: { consultKey: bind('form.consultKey'), page: bind('conversation.page'), direction } },
    })) },
    { type: 'text', text: bind('reader.title') },
    { type: 'text', text: bind('reader.text') },
    { type: 'actions', items: [
      { label: w.previous, action: { id: 'read', args: readerArgs(-1) } },
      { label: w.next, action: { id: 'read', args: readerArgs(1) } },
      { label: w.refresh, action: { id: 'read', args: readerArgs() } },
      { label: w.copy, action: { id: 'copy', args: readerArgs() } },
    ] },
  ] }
}

export function registerDshGo(ctx, api) {
  if (typeof ctx.inject !== 'function') return () => {}
  const cleanups = new Set()
  let disposed = false
  const fiber = ctx.inject(['dshGo'], (goCtx) => {
    if (disposed || typeof goCtx.dshGo?.panel !== 'function') return
    const maxLength = Math.min(600, api.maxQuestionChars)
    const recordsFor = (scope) => api.records(scope).filter((r) => !isScoped(scope) || r.callId === scope.callId)
    const get = (scope, key, w) => {
      if (typeof scope?.sessionId !== 'string' || !scope.sessionId || typeof key !== 'string' || !key) throw new Error(w.choose)
      const record = recordsFor(scope).find((r) => r.consultKey === key)
      if (!record) throw new Error(w.missing)
      return record
    }
    const guard = (fn) => async (scope, event) => {
      const w = words(event?.locale)
      try { return await fn(scope, event?.value ?? {}, w) }
      catch (error) { return { toast: clip(`${w.failed}: ${error?.message ?? error}`, 40) } }
    }
    const threadPage = (record, value, w) => {
      const all = entries([record])
      const page = Math.max(0, Math.min(Math.max(0, Math.ceil(all.length / PAGE_SIZE) - 1),
        (Number.isSafeInteger(value.page) ? value.page : 0) + (Number.isSafeInteger(value.direction) ? Math.sign(value.direction) : 0)))
      return { page, items: all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(({ target, entry }) => ({
        title: clip(`${w[target]} · ${entry.status} · ${entry.question}`),
        action: { id: 'read', args: { consultKey: record.consultKey, target, threadId: entry.id, page: 0 } },
      })) }
    }
    const read = (scope, value, w) => {
      const record = get(scope, value.consultKey, w)
      if (!['executor', 'reviewer'].includes(value.target)) throw new Error(w.invalid)
      const entry = record.threads?.[value.target]?.find((e) => e.id === value.threadId)
      if (!entry) throw new Error(w.missing)
      const pages = answerPages(entry.answer || entry.error || '')
      const index = Math.max(0, Math.min(pages.length - 1, (Number.isSafeInteger(value.page) ? value.page : 0) + (Number.isSafeInteger(value.direction) ? Math.sign(value.direction) : 0)))
      return {
        consultKey: record.consultKey, target: value.target, threadId: entry.id, page: index,
        title: clip(`${w.reader} · ${index + 1}/${pages.length} · ${entry.status} · ${entry.question}`, 180), text: pages[index],
      }
    }
    const detail = (r, w) => `${clip(r.reason, 400)}\n${clip(r.executor?.argumentsPreview, 1000)}\n${clip(r.reviewBusy ? w.evaluating : r.reviewer?.reason || r.reviewError, 400)}`
    const selection = (r, w) => ({
      form: { consultKey: r.consultKey, locked: r.resolved === true },
      selection: label(r, w),
      detail: detail(r, w),
      conversation: threadPage(r, {}, w),
    })
    const unregister = goCtx.dshGo.panel(PANEL, {
      view: (scope, caps) => view(caps?.locale, maxLength, caps, api.reviewerAvailable?.() !== false, isScoped(scope)),
      data(scope, emit, caps) {
        const w = words(caps?.locale)
        const scoped = isScoped(scope)
        let last = '', stopped = false
        // Latch once per feed: a later approval must never redirect a draft.
        let initialSelection
        const update = () => {
          if (stopped || disposed) return
          const available = recordsFor(scope)
          if (scoped && !initialSelection && available[0]) initialSelection = selection(available[0], w)
          const records = scoped ? available.filter((r) => r.consultKey === initialSelection?.form.consultKey) : available
          const current = scoped ? records[0] : undefined
          const latest = entries(records).slice(0, 8)
          const data = {
            summary: scoped ? w.current : records.length ? `${w.pick} · ${records.filter((r) => !r.resolved).length}/${records.length}` : w.empty,
            recent: recordItems(records.slice(0, PAGE_SIZE), w),
            // Constant defaults: subsequent diffs must not erase local input/selection/reader.
            form: { consultKey: '', target: 'executor', question: '', locked: scoped }, selection: scoped ? w.locating : w.selected, detail: '',
            history: { page: 0, items: [] },
            conversation: { page: 0, items: [] },
            reader: { title: w.read, text: '', consultKey: '', target: '', threadId: '', page: 0 },
            answers: latest.map(({ record, target, entry }) => ({
              title: clip(`${w[target]} · ${record.callId ?? record.toolName} · ${entry.status} · ${entry.question}`),
              subtitle: clip(entry.error || Array.from(String(entry.answer ?? '').slice(-640)).slice(-160).join(''), 180),
              action: { id: 'read', args: { consultKey: record.consultKey, target, threadId: entry.id, page: 0 } },
            })),
          }
          if (initialSelection) {
            Object.assign(data, initialSelection, { form: { ...data.form, ...initialSelection.form, locked: !current || current.resolved === true } })
            data.selection = current ? label(current, w) : w.missing
            data.detail = current ? detail(current, w) : ''
          }
          const json = JSON.stringify(data)
          if (json !== last) { last = json; emit(data) }
        }
        update() // Reconnection starts with a fresh authoritative snapshot; it never starts a job.
        const timer = setInterval(update, 500)
        timer.unref?.()
        const stop = () => { if (stopped) return; stopped = true; clearInterval(timer); cleanups.delete(stop) }
        cleanups.add(stop)
        return stop
      },
      actions: {
        select: guard((scope, value, w) => {
          const r = get(scope, value.consultKey, w)
          return { patch: selection(r, w) }
        }),
        threads: guard((scope, value, w) => ({ patch: { conversation: threadPage(get(scope, value.consultKey, w), value, w) } })),
        history: guard((scope, value, w) => {
          const records = recordsFor(scope)
          const page = Math.max(0, Math.min(Math.max(0, Math.ceil(records.length / PAGE_SIZE) - 1),
            (Number.isSafeInteger(value.page) ? value.page : 0) + (value.direction === -1 ? -1 : 1)))
          return { patch: { history: { page, items: recordItems(records.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), w) } } }
        }),
        ask: guard(async (scope, value, w) => {
          get(scope, value.consultKey, w)
          const question = value.values?.['data.form.question']
          const target = value.values?.['data.form.target']
          if (typeof question !== 'string' || !question.trim() || !['executor', 'reviewer'].includes(target)) throw new Error(w.invalid)
          if (Array.from(question).length > maxLength || question.length > api.maxQuestionChars || Buffer.byteLength(JSON.stringify(value)) > 4096) throw new Error(w.tooLong)
          await api.ask(scope, { consultKey: value.consultKey, target, question })
          return [{ patch: { form: { question: '' } } }, { toast: w.sent }]
        }),
        review: guard((scope, value, w) => { get(scope, value.consultKey, w); api.review(scope, value.consultKey); return { toast: w.reviewing } }),
        stop: guard((scope, value, w) => { get(scope, value.consultKey, w); api.stop(scope, value.consultKey); return { toast: w.stopped } }),
        read: guard((scope, value, w) => ({ patch: { reader: read(scope, value, w) } })),
        copy: guard((scope, value, w) => ({ copy: read(scope, value, w).text })),
      },
    })
    if (typeof unregister === 'function') cleanups.add(unregister)
  })
  return () => {
    disposed = true
    for (const cleanup of cleanups) cleanup()
    cleanups.clear()
    if (typeof fiber === 'function') fiber()
    else fiber?.dispose?.()
  }
}
