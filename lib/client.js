/**
 * dsh-approval-consult —— 审批咨询台（客户端 UI）
 *
 * 设计要点（与 docs/CLIENT-CONTRACT.md、Lead 的架构修正保持一致）：
 *  - 只有一个 slot：`shell.overlay`（root 作用域）。审批期间 `conversation.input.dock`
 *    会被官方审批面板的 fallback 整棵子树 display:none，放在那里用户根本看不见，
 *    所以入口改为 root 层悬浮胶囊 + 抽屉/底部弹层。
 *  - 所有 React hooks 一律写在任何 early return 之前：骨架里面板打不开就是因为
 *    `if (!state.open) return null` 之后还有两个 useEffect，打开瞬间 hook 数量变化，
 *    React 抛错后 slot 错误边界把条目静默摘掉（DOM 里 0 个节点、控制台无插件日志）。
 *  - 模块级 store 单例 + useSyncExternalStore：胶囊与面板订阅同一份状态。
 *  - 样式只注入 <style data-plugin="dsh-approval-consult">，只用 --dsw-* / --dsh-* token。
 *  - 所有请求都 try/catch，错误以人能看懂的语言留在面板里；单条回答失败可重试。
 */

window.__ModuleLoader__.load({
  id: 'dsh-approval-consult',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 宿主路由前缀。 */
    const API = '/dsh-approval-consult'
    /** 自动拒绝倒计时插件（dsh-approval-timeout）的同源路由；探测失败就完全静默。 */
    const TIMEOUT_API = '/dsh-approval-timeout'
    /** locale 命名空间。 */
    const NS = 'approval-consult'
    /** 移动端断点（与契约一致）。 */
    const NARROW_QUERY = '(max-width: 700px)'
    /** 面板刷新间隔。 */
    const CONTEXT_REFRESH_MS = 5000
    /** 轮询回答的节奏（契约建议 100–160ms）。 */
    const POLL_INTERVAL_MS = 120
    /** 轻提示停留时间。 */
    const NOTICE_MS = 2600
    /** demo 模式存储键。 */
    const DEMO_STORAGE_KEY = 'dsh-approval-consult.demo'

    /* ------------------------------------------------------------------ */
    /* 文案                                                                */
    /* ------------------------------------------------------------------ */

    const ZH = {
      title: '审批咨询台',
      subtitle: '先问清楚，再决定',
      pillLabel: '审批有疑问？',
      pillAria: '打开审批咨询台',
      pillDismiss: '本次审批不再提示',
      close: '关闭',
      closeHint: '关闭面板（Esc）',
      demoBadge: '演示',
      statusWaiting: '等待审批',
      statusEnded: '审批已结束',
      tabExecutor: '执行 AI',
      tabReviewer: '审查 AI',
      tabCompare: '双问',
      tabCompareOn: '双问开',
      tabCompareOff: '双问关',
      tabCompareHint: '同一条问题同时发给执行 AI 和审查 AI，回答各自留在 tab 里',
      tabCompareUnavailable: '两侧都可用时才能双问',
      badgeUnavailable: '不可用',
      contextTitle: '本次审批',
      riskLow: '低风险',
      riskMedium: '中风险',
      riskHigh: '高风险',
      verdictAllow: '结论：允许',
      verdictDeny: '结论：拒绝',
      decideSyncing: '正在同步审批状态…',
      evidenceCount: '{count} 条审查历史',
      reasonLabel: '审查理由',
      reasonExpand: '展开',
      reasonCollapse: '收起',
      toolArgs: '工具参数',
      argsCopy: '复制',
      argsCopied: '已复制',
      argsEmpty: '没有可用的参数快照',
      executorNote: '执行 AI 的说明',
      executorMeta: '{messages} 条消息 · {tools} 个工具',
      reviewMeta: '{provider} · {model}',
      reviewUnavailable: '本次审批没有可用的自动审查上下文',
      executorUnavailable: '还没有捕获到执行 AI 的对话上下文',
      loadingContext: '正在读取审批上下文…',
      contextErrorTitle: '没能读到审批上下文',
      contextErrorDetail: '宿主返回：{detail}',
      retry: '重试',
      emptyTitle: '还没有提问',
      emptyHint: '点上面的常见问题，或者自己写一句。',
      presetsTitle: '常见问题',
      presetsShow: '展开常见问题',
      presetsHide: '收起常见问题',
      timeoutBanner: '自动拒绝倒计时还剩 {seconds}s：阅读/思考期间可以暂停。',
      timeoutPauseAction: '暂停倒计时',
      timeoutBannerDismiss: '先不暂停',
      presetsEdit: '编辑',
      presetsEditorTitle: '编辑常用问题',
      presetsEditorHint: '保存后立即生效，仅影响这台机器；点「恢复默认」可回到内置问题。',
      presetsEditorExecutor: '执行 AI',
      presetsEditorReviewer: '审查 AI',
      presetsEditorAdd: '添加一条',
      presetsEditorPlaceholder: '写一句你常问的问题…',
      presetsEditorSave: '保存',
      presetsEditorSaving: '保存中…',
      presetsEditorCancel: '取消',
      presetsEditorReset: '恢复默认',
      presetsEditorResetConfirm: '再点一次确认恢复默认',
      presetsEditorLimit: '最多 {count} 条 · 单条不超过 {chars} 字',
      presetsEditorEmpty: '还没有自定义问题，点「添加一条」开始。',
      presetsEditorSaved: '常用问题已保存',
      presetsEditorResetDone: '已恢复默认常用问题',
      presetsEditorLoadFailed: '读取常用问题失败',
      presetsEditorSaveFailed: '保存常用问题失败',
      presetsEditorMoveUp: '上移',
      presetsEditorMoveDown: '下移',
      presetsEditorDelete: '删除这条',
      presetsEditorRow: '第 {index} 条',
      placeholderDesktop: '问点什么…',
      placeholderMobile: '问点什么…',
      send: '发送',
      stop: '停止',
      sendHintEnter: 'Enter 发送 · Shift+Enter 换行',
      sendHintMobile: '点发送按钮提交',
      savedToSession: '已保存到会话',
      truncated: '回答被截断',
      truncatedHint: '回答达到输出长度上限，以上是已生成的部分，结论可能不完整。',
      saveFailed: '保存到会话失败',
      relay: '转达给执行 AI',
      relayed: '已转达',
      relayFailed: '转达失败',
      turnCancelled: '已停止',
      turnRetry: '重试',
      usageCache: '缓存 {cache} · 输入 {input} · 输出 {output}',
      usagePlain: '输入 {input} · 输出 {output}',
      decideHint: '看完可以直接在这里决定：',
      allowOnce: '允许一次',
      reject: '拒绝',
      deciding: '提交中…',
      decided: '已提交决定',
      outcomeAllowed: '已允许一次',
      outcomeRejected: '已拒绝',
      outcomeCancelled: '已取消',
      outcomeUnavailable: '审批已失效',
      outcomeError: '审批出错',
      outcomeUnknown: '审批已结束',
      outcomeTimeout: '已超时（无人应答）',
      historyNoReview: '未咨询审查 AI',
      endedTitle: '这次审批已经结束',
      endedHint: '咨询内容会保留在这里，你可以继续翻阅，手动关闭面板即可。',
      contextSyncing: '审批仍在等待，正在同步咨询上下文…',
      contextSyncingHint: '审批没有结束，只是咨询记录暂时还没对上；稍等片刻，或点重试。',
      contextRetry: '重试同步',
      compareReady: '{target} 也已回答',
      compareReadyAction: '查看',
      jumpLatest: '回到最新',
      toastRelayed: '已转达给执行 AI',
      toastPaused: '已暂停自动拒绝倒计时',
      toastShared: '还有其它待审批项：暂停会一并取消它们的倒计时，请先处理或手动点倒计时确认',
      relayEnded: '审批已结束：咨询记录只支持回看，不能再转达给执行 AI',
      toastDecision: '已提交决定',
      toastCopied: '已复制工具参数',
      toastTooLong: '问题太长，已截断到 {max} 字',
      toastStreaming: '回答中，可以先看看已有内容',
      errNoPending: '这次审批已经不在等待中，可能刚被允许或拒绝。',
      errResolved: '这次审批已经结束，不能再继续提问。',
      errExecutorMissing: '还没有捕获到执行 AI 的上下文，暂时问不了它。',
      errReviewerMissing: '本次审批没有自动审查上下文，问不了审查 AI。',
      errEmptyQuestion: '问题不能为空。',
      errTooLong: '问题太长（上限 {max} 字）。',
      errTooManyJobs: '同时生成回答的数量到上限了，等一个结束后再问。',
      errConflict: '审批状态已经变化，刷新一下再看看。',
      errUnauthorized: '没有权限访问宿主接口，可能登录态过期了。',
      errNotFound: '宿主接口不存在，插件可能没有加载完成。',
      errServer: '宿主出错了，稍后重试。',
      errNetwork: '连不上宿主，检查一下网络或页面连接。',
      errUnknown: '出了点问题：{detail}',
      errAgentOffline: '执行 AI 已经不在线，无法把回答转达给它。',
      errorCode: '（{code}）',
      timeoutChip: '自动拒绝 {seconds}s',
      timeoutPause: '暂停倒计时',
      timeoutPauseHint: '点击暂停自动拒绝倒计时（会同时取消其它待审批项的倒计时）',
      timeoutPaused: '自动拒绝倒计时已暂停',
      ariaPanel: '审批咨询台',
      ariaThread: '问答线程',
      ariaTabs: '选择咨询对象',
      ariaInput: '输入问题',
      ariaSend: '发送问题',
      ariaStop: '停止生成',
      ariaRelay: '把这条回答转达给执行 AI',
      ariaCountdown: '自动拒绝剩余 {seconds} 秒，点击暂停',
      ariaRisk: '风险等级',
      ariaDecide: '审批决定',
      notifyStreaming: '正在回答…',
      notifyDone: '回答完成',
      notifyError: '回答失败',
      notifyOpposite: '另一侧也开始回答了',
      copyFail: '复制失败',
      fatalTitle: '审批咨询台渲染失败',
      fatalHint: '不影响审批本身，可以直接用上方的审批按钮。',
      fatalRetry: '重试渲染',
      reviewNeedsTitle: '审查材料已就绪，但还没有结论',
      reviewNeedsHint: '这次审批不是由自动审查触发的。可以让审查 AI 基于当前材料重新评估一次，之后再向它提问。',
      reviewNeedAction: '让审查 AI 重新评估',
      reviewBusy: '正在评估…',
      reviewRetry: '重新评估',
      reviewDone: '审查 AI 已给出结论',
      reviewFailedTitle: '自动审查没有成功',
      reviewFailedHint: '审查过程出错，但没有结论时仍可以直接提问；出错信息：{detail}',
      reviewOverrideBadge: '重新评估',
      reviewSyntheticBadge: '取自审批理由',
      pendingErrorNote: '审批错误：{error}',
      errReviewNotInitialized: '审查 AI 还没有这次调用的结论，先点「让审查 AI 重新评估」。',
      reviewerNeedsReviewPlaceholder: '先让审查 AI 重新评估，之后就能提问。',
      inputDisabledEnded: '审批已结束，不能再继续提问',
      ariaReviewAction: '让审查 AI 重新评估这次调用',
      savedTooltip: '已写入会话日志，模型下一轮一定能看到；聊天流里不会显示这一行。',
      historyTitle: '咨询记录',
      historyReadonly: '只读 · 审批已结束',
      historyReadonlyHint: '这些审批都已经结束，记录仅用于回看，不能再提问或决策。',
      historyChip: '审批咨询记录 · {count}',
      historyChipAria: '查看这个会话的审批咨询记录',
      historyLoading: '正在读取咨询记录…',
      historyError: '读取咨询记录失败：{detail}',
      historyEmpty: '这个会话还没有审批咨询记录。',
      historyCount: '{count} 次审批',
      historyTurns: '{count} 条问答',
      historyThreadEmpty: '没有问答记录',
      historyAt: '提交于 {time}',
      historyResolvedAt: '结束于 {time}',
      historyRelayCount: '转达 {count} 次',
      historyClose: '关闭记录',
    }

    const EN = {
      title: 'Approval Consult',
      subtitle: 'Ask first, then decide',
      pillLabel: 'Questions?',
      pillAria: 'Open the approval consult panel',
      pillDismiss: 'Hide for this approval',
      close: 'Close',
      closeHint: 'Close panel (Esc)',
      demoBadge: 'Demo',
      statusWaiting: 'Waiting for approval',
      statusEnded: 'Approval finished',
      tabExecutor: 'Executor',
      tabReviewer: 'Reviewer',
      tabCompare: 'Ask both',
      tabCompareOn: 'Both on',
      tabCompareOff: 'Both off',
      tabCompareHint: 'Send one question to both AIs; each answer stays in its own tab',
      tabCompareUnavailable: 'Both sides must be available',
      badgeUnavailable: 'N/A',
      contextTitle: 'This approval',
      riskLow: 'Low risk',
      riskMedium: 'Medium risk',
      riskHigh: 'High risk',
      verdictAllow: 'Verdict: allow',
      verdictDeny: 'Verdict: deny',
      decideSyncing: 'Syncing approval state…',
      evidenceCount: '{count} review history items',
      reasonLabel: 'Review reason',
      reasonExpand: 'More',
      reasonCollapse: 'Less',
      toolArgs: 'Tool arguments',
      argsCopy: 'Copy',
      argsCopied: 'Copied',
      argsEmpty: 'No argument snapshot',
      executorNote: 'Executor note',
      executorMeta: '{messages} messages · {tools} tools',
      reviewMeta: '{provider} · {model}',
      reviewUnavailable: 'No automatic review context for this approval',
      executorUnavailable: 'No executor conversation captured yet',
      loadingContext: 'Reading approval context…',
      contextErrorTitle: 'Could not read the approval context',
      contextErrorDetail: 'Host said: {detail}',
      retry: 'Retry',
      emptyTitle: 'No question yet',
      emptyHint: 'Pick a common question above, or write your own.',
      presetsTitle: 'Common questions',
      presetsShow: 'Show common questions',
      presetsHide: 'Hide common questions',
      timeoutBanner: 'Auto-reject in {seconds}s — pause it while you read or think.',
      timeoutPauseAction: 'Pause countdown',
      timeoutBannerDismiss: 'Not now',
      presetsEdit: 'Edit',
      presetsEditorTitle: 'Edit common questions',
      presetsEditorHint: 'Saved immediately on this machine; use Reset to return to the built-in questions.',
      presetsEditorExecutor: 'Executor AI',
      presetsEditorReviewer: 'Reviewer AI',
      presetsEditorAdd: 'Add question',
      presetsEditorPlaceholder: 'Write a question you often ask…',
      presetsEditorSave: 'Save',
      presetsEditorSaving: 'Saving…',
      presetsEditorCancel: 'Cancel',
      presetsEditorReset: 'Reset',
      presetsEditorResetConfirm: 'Click again to reset',
      presetsEditorLimit: 'Up to {count} items · {chars} chars each',
      presetsEditorEmpty: 'No custom questions yet — click “Add question”.',
      presetsEditorSaved: 'Common questions saved',
      presetsEditorResetDone: 'Common questions reset',
      presetsEditorLoadFailed: 'Could not load common questions',
      presetsEditorSaveFailed: 'Could not save common questions',
      presetsEditorMoveUp: 'Move up',
      presetsEditorMoveDown: 'Move down',
      presetsEditorDelete: 'Delete this question',
      presetsEditorRow: 'Item {index}',
      placeholderDesktop: 'Ask anything…',
      placeholderMobile: 'Ask anything…',
      send: 'Send',
      stop: 'Stop',
      sendHintEnter: 'Enter sends · Shift+Enter adds a line',
      sendHintMobile: 'Tap Send to submit',
      savedToSession: 'Saved to session',
      truncated: 'Answer truncated',
      truncatedHint: 'The answer hit the output limit; this is the generated part and may be incomplete.',
      saveFailed: 'Could not save to session',
      relay: 'Relay to executor',
      relayed: 'Relayed',
      relayFailed: 'Relay failed',
      turnCancelled: 'Stopped',
      turnRetry: 'Retry',
      usageCache: 'cache {cache} · in {input} · out {output}',
      usagePlain: 'in {input} · out {output}',
      decideHint: 'Decide right here when ready:',
      allowOnce: 'Allow once',
      reject: 'Reject',
      deciding: 'Submitting…',
      decided: 'Decision submitted',
      outcomeAllowed: 'Allowed once',
      outcomeRejected: 'Rejected',
      outcomeCancelled: 'Cancelled',
      outcomeUnavailable: 'Approval no longer available',
      outcomeError: 'Approval errored',
      outcomeUnknown: 'Approval finished',
      outcomeTimeout: 'Timed out (no one answered)',
      historyNoReview: 'Reviewer AI not consulted',
      endedTitle: 'This approval has finished',
      endedHint: 'The consultation stays here. Read on, then close the panel yourself.',
      contextSyncing: 'The approval is still waiting — syncing its consultation context…',
      contextSyncingHint: 'The approval has not ended; the consultation record is just out of sync for a moment. Wait briefly or retry.',
      contextRetry: 'Retry sync',
      compareReady: '{target} answered too',
      compareReadyAction: 'View',
      jumpLatest: 'Jump to latest',
      toastRelayed: 'Relayed to the executor',
      toastPaused: 'Auto-reject countdown paused',
      toastShared: 'Other approvals are waiting: pausing would cancel their countdown too. Resolve them first, or click the countdown to confirm.',
      relayEnded: 'This approval has ended: the consultation is read-only and can no longer be relayed to the executor.',
      toastDecision: 'Decision submitted',
      toastCopied: 'Tool arguments copied',
      toastTooLong: 'Question too long, trimmed to {max} chars',
      toastStreaming: 'Answering… you can read what is there',
      errNoPending: 'This approval is no longer waiting — it may just have been allowed or rejected.',
      errResolved: 'This approval already finished; no more questions.',
      errExecutorMissing: 'Executor context was not captured, so it cannot answer.',
      errReviewerMissing: 'No automatic review context, so the reviewer cannot answer.',
      errEmptyQuestion: 'The question cannot be empty.',
      errTooLong: 'Question too long (limit {max} chars).',
      errTooManyJobs: 'Too many answers generating at once; wait for one to finish.',
      errConflict: 'The approval state changed; refresh and try again.',
      errUnauthorized: 'Not allowed to reach the host API; the session may have expired.',
      errNotFound: 'Host API not found; the plugin may still be loading.',
      errServer: 'Host error, try again shortly.',
      errNetwork: 'Cannot reach the host; check the connection.',
      errUnknown: 'Something went wrong: {detail}',
      errAgentOffline: 'The executor is offline; the answer cannot be relayed.',
      errorCode: '({code})',
      timeoutChip: 'auto-reject {seconds}s',
      timeoutPause: 'Pause countdown',
      timeoutPauseHint: 'Pause the auto-reject countdown (this also cancels the countdown of any other pending approval)',
      timeoutPaused: 'Auto-reject countdown paused',
      ariaPanel: 'Approval consult',
      ariaThread: 'Question and answer thread',
      ariaTabs: 'Choose who to ask',
      ariaInput: 'Type a question',
      ariaSend: 'Send question',
      ariaStop: 'Stop generating',
      ariaRelay: 'Relay this answer to the executor',
      ariaCountdown: 'Auto reject in {seconds} seconds, click to pause',
      ariaRisk: 'Risk level',
      ariaDecide: 'Approval decision',
      notifyStreaming: 'Answering…',
      notifyDone: 'Answer finished',
      notifyError: 'Answer failed',
      notifyOpposite: 'The other side started answering too',
      copyFail: 'Copy failed',
      fatalTitle: 'Approval Consult failed to render',
      fatalHint: 'The approval itself is unaffected; use the approval buttons above.',
      fatalRetry: 'Retry rendering',
      reviewNeedsTitle: 'Review material is ready, but there is no verdict yet',
      reviewNeedsHint: 'This approval was not triggered by auto-review. Ask the reviewer AI to evaluate the captured material once, then you can question it.',
      reviewNeedAction: 'Re-evaluate with the reviewer AI',
      reviewBusy: 'Evaluating…',
      reviewRetry: 'Re-evaluate',
      reviewDone: 'The reviewer AI has a verdict now',
      reviewFailedTitle: 'Auto-review did not succeed',
      reviewFailedHint: 'The review failed, but you can still ask questions when there is no verdict; error: {detail}',
      reviewOverrideBadge: 'Re-evaluated',
      reviewSyntheticBadge: 'From approval reason',
      pendingErrorNote: 'Approval error: {error}',
      errReviewNotInitialized: 'The reviewer AI has no verdict for this call yet — run the re-evaluation first.',
      reviewerNeedsReviewPlaceholder: 'Re-evaluate with the reviewer AI first, then you can ask.',
      inputDisabledEnded: 'Approval finished — no more questions',
      ariaReviewAction: 'Re-evaluate this call with the reviewer AI',
      savedTooltip: 'Written to the session log — the model sees it next turn; it is not displayed as a chat row.',
      historyTitle: 'Consult history',
      historyReadonly: 'Read-only · approval finished',
      historyReadonlyHint: 'These approvals are finished; records are for review only — no questions or decisions here.',
      historyChip: 'Approval consults · {count}',
      historyChipAria: 'View approval consult history for this session',
      historyLoading: 'Reading consult history…',
      historyError: 'Could not read consult history: {detail}',
      historyEmpty: 'No approval consults in this session yet.',
      historyCount: '{count} approvals',
      historyTurns: '{count} Q&A',
      historyThreadEmpty: 'No questions',
      historyAt: 'requested {time}',
      historyResolvedAt: 'finished {time}',
      historyRelayCount: 'relayed {count}×',
      historyClose: 'Close history',
    }

    /** 错误码 → 文案 key（宿主/HTTP 契约）。 */
    const ERROR_KEYS = {
      'no-pending': 'errNoPending',
      'approval-resolved': 'errResolved',
      'executor-context-missing': 'errExecutorMissing',
      'reviewer-context-missing': 'errReviewerMissing',
      'empty-question': 'errEmptyQuestion',
      'question-too-long': 'errTooLong',
      'too-many-jobs': 'errTooManyJobs',
      'job-not-found': 'errNoPending',
      'agent-offline': 'errAgentOffline',
      'empty-text': 'errEmptyQuestion',
      'text-too-long': 'errTooLong',
      'review-not-initialized': 'errReviewNotInitialized',
      'http-401': 'errUnauthorized',
      'http-403': 'errUnauthorized',
      'http-404': 'errNotFound',
      'http-409': 'errConflict',
      'http-429': 'errTooManyJobs',
      'http-500': 'errServer',
      'http-502': 'errServer',
      'http-503': 'errServer',
      network: 'errNetwork',
      unknown: 'errUnknown',
    }

    /** 结局 → 文案 key。 */
    const OUTCOME_KEYS = {
      'allowed-once': 'outcomeAllowed',
      rejected: 'outcomeRejected',
      cancelled: 'outcomeCancelled',
      unavailable: 'outcomeUnavailable',
      error: 'outcomeError',
    }

    /** 宿主旧版本可能把 null 序列化成字符串 "null"：统一按“没有结论”处理。 */
    function normalizeOutcome(value) {
      if (value === null || value === undefined) return null
      const text = String(value)
      return text === 'null' || text === 'undefined' || text === '' ? null : text
    }

    /* ------------------------------------------------------------------ */
    /* 工具                                                                */
    /* ------------------------------------------------------------------ */

    /** 模板格式化：只替换 {name}。 */
    function fmt(template, values) {
      const source = String(template ?? '')
      if (values === undefined || values === null) return source
      return source.replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined || values[key] === null ? match : String(values[key])))
    }

    /** 安全读取 localStorage（隐私模式下会抛）。 */
    function storageGet(key) {
      try {
        return window.localStorage?.getItem(key) ?? null
      } catch {
        return null
      }
    }

    /** demo 模式：URL 参数优先，其次 localStorage。 */
    function readDemoVariant() {
      try {
        const fromUrl = new URLSearchParams(window.location.search).get('consult-demo')
        if (fromUrl !== null && fromUrl !== '') {
          if (fromUrl === '0' || fromUrl === 'off') return null
          if (fromUrl === 'no-reviewer') return 'no-reviewer'
          if (fromUrl === 'no-executor') return 'no-executor'
          if (fromUrl === 'advisory') return 'advisory'
          if (fromUrl === 'error') return 'error'
          return 'full'
        }
        if (storageGet(DEMO_STORAGE_KEY) === '1') return 'full'
      } catch {
        /* ignore */
      }
      return null
    }

    /** 安全 fetch JSON：统一超时之外的网络/HTTP/业务错误语义。 */
    async function requestJson(url, options) {
      let response
      try {
        response = await fetch(url, {
          credentials: 'same-origin',
          cache: 'no-store',
          ...options,
          headers: {
            accept: 'application/json',
            ...(options?.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(options?.headers ?? {}),
          },
        })
      } catch (cause) {
        const error = new Error('network')
        error.code = 'network'
        error.cause = cause
        throw error
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok === false) {
        const error = new Error(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
        error.code = typeof payload?.code === 'string' ? payload.code : `http-${response.status}`
        error.status = response.status
        throw error
      }
      return payload
    }

    /** 常用问题：读取/保存/恢复默认（宿主负责持久化与校验）。 */
    function fetchPresets() {
      return requestJson(`${API}/presets`)
    }

    function savePresetsRequest(lists) {
      return requestJson(`${API}/presets`, { method: 'POST', body: JSON.stringify(lists) })
    }

    function resetPresetsRequest() {
      return requestJson(`${API}/presets/reset`, { method: 'POST' })
    }

    /** 把任意异常翻译成 { key, code, detail }，供组件用字典渲染。 */
    function describeError(error) {
      const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'unknown'
      const key = ERROR_KEYS[code] ?? (String(code).startsWith('http-') ? 'errServer' : 'errUnknown')
      return { key, code, detail: typeof error?.message === 'string' ? error.message : String(error) }
    }

    /** token 数字缩写：32000 → 32k。 */
    function formatTokens(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number < 0) return '—'
      if (number < 1000) return String(Math.round(number))
      if (number < 100000) {
        const k = number / 1000
        return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`
      }
      return `${(number / 1000).toFixed(0)}k`
    }

    /** 时钟：HH:MM。 */
    function formatClock(at) {
      try {
        const date = new Date(Number(at) || Date.now())
        const hours = String(date.getHours()).padStart(2, '0')
        const minutes = String(date.getMinutes()).padStart(2, '0')
        return `${hours}:${minutes}`
      } catch {
        return ''
      }
    }

    /** 日期+时钟：MM-DD HH:MM（历史记录用）。 */
    function formatDateTime(at) {
      try {
        const date = new Date(Number(at) || Date.now())
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        return `${month}-${day} ${formatClock(at)}`
      } catch {
        return ''
      }
    }

    /** 生成稳定本地 id。 */
    let localSeq = 0
    function nextLocalId(prefix) {
      localSeq += 1
      return `${prefix}:${Date.now()}:${localSeq}`
    }

    /** 截断到上限（保护宿主 maxQuestionChars）。 */
    function clampText(text, max) {
      const value = String(text ?? '')
      if (!Number.isFinite(max) || max <= 0) return value
      return value.length > max ? value.slice(0, max) : value
    }

    /* ------------------------------------------------------------------ */
    /* 运行期资源：HMR/卸载时统一清理，避免定时器泄漏                       */
    /* ------------------------------------------------------------------ */

    const runtime = {
      disposed: false,
      timers: new Set(),
      /** 当前客户端仍在等待的 PendingApproval（由 ConsultOverlay 每次渲染同步）。
       *  它是“审批是否还活着”的权威来源：宿主咨询记录可能因热重载/重建暂时缺失，
       *  但官方审批卡片还在等用户决定，此时绝不能把面板切到“已结束”。 */
      livePending: null,
      /** contextMissing 期间的自动重试是否已排队。 */
      contextRetryQueued: false,
    }

    /** setTimeout 的可清理版本。 */
    function after(ms, fn) {
      if (runtime.disposed) return () => {}
      const id = window.setTimeout(() => {
        runtime.timers.delete(id)
        if (runtime.disposed) return
        try {
          fn()
        } catch (error) {
          try {
            console.error('[approval-consult] timer task failed', error)
          } catch {
            /* ignore */
          }
        }
      }, ms)
      runtime.timers.add(id)
      return () => {
        runtime.timers.delete(id)
        try {
          window.clearTimeout(id)
        } catch {
          /* ignore */
        }
      }
    }

    /** 可清理的 interval。 */
    function every(ms, fn) {
      if (runtime.disposed) return () => {}
      const id = window.setInterval(() => {
        if (runtime.disposed) return
        try {
          fn()
        } catch (error) {
          try {
            console.error('[approval-consult] interval task failed', error)
          } catch {
            /* ignore */
          }
        }
      }, ms)
      runtime.timers.add(id)
      return () => {
        runtime.timers.delete(id)
        try {
          window.clearInterval(id)
        } catch {
          /* ignore */
        }
      }
    }

    /** 释放本模块创建的所有定时器（HMR 换 fiber 时调用）。 */
    function disposeRuntime() {
      runtime.disposed = true
      for (const id of runtime.timers) {
        try {
          window.clearTimeout(id)
          window.clearInterval(id)
        } catch {
          /* ignore */
        }
      }
      runtime.timers.clear()
      activePolls.clear()
    }

    /* ------------------------------------------------------------------ */
    /* 共享状态                                                            */
    /* ------------------------------------------------------------------ */

    const listeners = new Set()
    /**
     * @type {any} 模块级单例：胶囊与面板必须订阅同一个对象。
     * 注意必须「每次 emit 换一个新快照」：useSyncExternalStore 用 Object.is 比较
     * getSnapshot 的返回值，原地 mutate 的 store 永远不会触发 React 重渲染
     * （这正是第一版面板点了没反应的原因）。
     */
    let store = {
      /** 面板是否打开。 */
      open: false,
      /** 面板形态：'pending' 咨询中 / 'history' 只读回看。 */
      mode: 'pending',
      /** 只读历史：{ loading, error, items, total, sessionId }。 */
      history: { loading: false, error: null, items: [], total: 0, sessionId: null },
      /** demo 变体：null | 'full' | 'no-reviewer' | 'no-executor'。 */
      demo: readDemoVariant(),
      /** 打开面板时锁定的会话（root 作用域拿不到 props.sessionId）。 */
      sessionId: null,
      toolName: null,
      callId: null,
      consultKey: null,
      /** 'executor' | 'reviewer' */
      tab: 'executor',
      /** 双问开关。 */
      compare: false,
      draft: '',
      context: null,
      contextError: null,
      loadingContext: false,
      /** /context 里最近一次的 pending（序列化对象）。 */
      pending: null,
      resolved: false,
      /** 客户端仍有待审批、但宿主咨询记录暂时缺失/未对齐：保持等待态并自动重试。 */
      contextMissing: false,
      outcome: null,
      /** 是否已向宿主提交过决定（与 pending 消失区分）。 */
      decided: false,
      deciding: false,
      /** 兜底重新评估（reviewer.advisory + needsClassification）的流程状态。 */
      reviewBusy: false,
      reviewError: null,
      /** /review 返回的结论：立即覆盖上下文卡片，不等 /context 刷新。 */
      reviewerOverride: null,
      /** 宿主检测到官方自动审查插件可用（false = 只问执行 AI）。 */
      reviewerAvailable: true,
      /** 宿主检测到自动拒绝倒计时插件可用（false = 完全不探测/展示倒计时）。 */
      timeoutAvailable: true,
      /** 宿主拒绝了提问（409 review-not-initialized）时强制显示评估入口。 */
      reviewNeedsClassification: false,
      threads: { executor: [], reviewer: [] },
      presets: { executor: [], reviewer: [] },
      limits: { maxQuestionChars: 2000, maxConcurrentJobs: 3 },
      /** { timeoutMs, elapsedMs, probedAt, cancelled } | null */
      timeout: null,
      timeoutPaused: false,
      /** 本次面板打开期间，用户是否已经关掉了倒计时提示条。 */
      timeoutBannerDismissed: false,
      /** 另一侧（双问）已回答、当前 tab 还没看过的提示。 */
      compareReady: null,
      /** 轻提示：{ id, key, vars, tone } | null。 */
      notice: null,
      /** 用户对本次审批点了「不再提示」。 */
      dismissedKey: null,
      /** 面板内滚动/流式状态由组件本地管理，这里只留 aria 通知。 */
      live: '',
    }

    /** 已结束的审批是否已经处理过（避免 refresh 反复触发状态切换）。 */
    let resolvedHandled = false
    /** 当前轮询代际：HMR/卸载后让旧轮询自然退出。 */
    let pollGeneration = 0
    /** 正在跑的任务：threadId -> jobId。 */
    const activePolls = new Map()

    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    function getSnapshot() {
      return store
    }

    function emit(patch) {
      // 不可变快照：不改变上一份快照，订阅方靠 identity 变化感知更新。
      store = { ...store, ...patch }
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          try {
            console.error('[approval-consult] store listener failed', error)
          } catch {
            /* ignore */
          }
        }
      }
    }

    /** 轻提示；key 走字典，渲染时再翻译。 */
    function toast(key, vars, tone) {
      emit({ notice: { id: nextLocalId('notice'), key, vars: vars ?? null, tone: tone ?? 'info' } })
    }

    function clearToast() {
      if (store.notice !== null) emit({ notice: null })
    }

    const EMPTY_THREADS = Object.freeze({ executor: [], reviewer: [] })

    /* ------------------------------------------------------------------ */
    /* 宿主通信                                                            */
    /* ------------------------------------------------------------------ */

    function contextQuery(sessionId, pending) {
      const params = new URLSearchParams()
      if (sessionId !== null && sessionId !== undefined) params.set('sessionId', String(sessionId))
      if (pending?.callId !== undefined && pending?.callId !== null) params.set('callId', String(pending.callId))
      else if (pending?.toolName) params.set('toolName', String(pending.toolName))
      if (store.consultKey) params.set('consultKey', String(store.consultKey))
      return `${API}/context?${params.toString()}`
    }

    /** 归一化 /context 响应，缺字段时补默认值（宿主契约演进时也不白屏）。 */
    function normalizeThreads(value) {
      const list = (input) =>
        Array.isArray(input)
          ? input
              .filter((turn) => turn !== null && typeof turn === 'object')
              .map((turn) => ({
                id: String(turn.id ?? nextLocalId('q')),
                question: String(turn.question ?? ''),
                answer: String(turn.answer ?? ''),
                status: typeof turn.status === 'string' ? turn.status : 'done',
                at: Number(turn.at) || Date.now(),
                usage: turn.usage ?? null,
                error: turn.error ?? null,
                injectedAt: turn.injectedAt ?? null,
                relayedAt: turn.relayedAt ?? null,
                injectError: turn.injectError ?? null,
                truncated: turn.truncated === true,
              }))
          : []
      return {
        executor: list(value?.executor),
        reviewer: list(value?.reviewer),
      }
    }

    function normalizeContext(payload) {
      return {
        serverTime: Number(payload?.serverTime) || Date.now(),
        consultKey: typeof payload?.consultKey === 'string' ? payload.consultKey : null,
        pending: payload?.pending ?? null,
        executor: payload?.executor ?? null,
        reviewer: payload?.reviewer ?? null,
        features: payload?.features ?? { ask: true, followUp: true, relay: true, decision: true, compare: true },
        timeoutAutoPause: normalizeTimeoutAutoPause(payload?.features?.timeoutAutoPause),
        // 宿主没检测到官方自动审查插件时（features.reviewerAvailable === false），
        // 客户端只保留执行 AI 通道；缺省 true 以兼容旧宿主。
        reviewerAvailable: payload?.features?.reviewerAvailable !== false,
        // 宿主没检测到自动拒绝倒计时插件时（timeoutAvailable === false），
        // 不探测、不渲染任何倒计时相关内容。
        timeoutAvailable: payload?.features?.timeoutAvailable !== false,
        limits: {
          maxQuestionChars: Number(payload?.limits?.maxQuestionChars) || 2000,
          maxConcurrentJobs: Number(payload?.limits?.maxConcurrentJobs) || 3,
        },
        presets: {
          executor: Array.isArray(payload?.presets?.executor) ? payload.presets.executor.slice(0, 12) : [],
          reviewer: Array.isArray(payload?.presets?.reviewer) ? payload.presets.reviewer.slice(0, 12) : [],
        },
      }
    }

    /**
     * 拉取上下文。
     * 注意：宿主在「审批记录彻底不存在」时只返回 pending:null（没有 threads），
     * 这时绝不能拿空数组覆盖已有问答 —— 保留本地线程，只标记结束。
     */
    async function loadContext(options) {
      const silent = options?.silent === true
      if (store.demo !== null) return
      if (runtime.disposed) return
      if (!store.open) return
      if (!silent) emit({ loadingContext: true, contextError: null })
      try {
        const payload = await requestJson(contextQuery(store.sessionId, store.pending))
        if (runtime.disposed || !store.open) return
        applyContext(payload, silent)
        emit({ loadingContext: false, contextError: null })
      } catch (error) {
        if (runtime.disposed || !store.open) return
        // 静默刷新失败不打断用户：保留上一次的数据，只在没有数据时给错误块。
        if (silent && store.context !== null) return
        emit({ loadingContext: false, contextError: describeError(error) })
      }
    }

    /** 上下文错误块里的“重试”。 */
    function retryContext() {
      if (store.demo !== null) {
        // demo 的 error 变体重试后恢复成正常 mock，方便验收“失败→重试→恢复”。
        if (store.demo === 'error') applyDemoContext('full')
        return
      }
      void loadContext()
    }

      /** 把 /context 结果写进 store（流式期间不覆盖线程，避免增量与全量互相踩踏）。 */
    function applyContext(payload, silent) {
      const live = runtime.livePending
      const liveApproval =
        live !== null && live !== undefined && (live.answerable === undefined || live.answerable !== false) && store.decided !== true
      if (payload?.pending === null || payload?.pending === undefined) {
        // 先看客户端自己：官方审批还在等待时，宿主记录缺失只是“没对上”，不是审批结束。
        if (liveApproval) {
          if (!silent) emit({ contextMissing: true, loadingContext: false, contextError: null })
          else emit({ contextMissing: true })
          scheduleContextRetry()
          return
        }
        // 记录已不存在：保留线程，标记结束。
        if (!resolvedHandled) {
          resolvedHandled = true
          emit({ resolved: true, outcome: store.outcome ?? store.pending?.outcome ?? null, contextMissing: false, pending: null })
        }
        return
      }
      const context = normalizeContext(payload)
      // 宿主说已结束、但客户端仍在等：以客户端为准（可能是旧记录/重建窗口），
      // 保持等待态并提示同步，等真正的审批结束后 PendingApproval 会消失并触发结束 watcher。
      if (context.pending?.resolved === true && liveApproval) {
        emit({ contextMissing: true, contextError: null })
        scheduleContextRetry()
      }
      const streaming = isStreaming(store.threads)
      const patch = {
        context,
        consultKey: context.consultKey ?? store.consultKey,
        pending: context.pending,
        contextMissing: context.pending?.resolved === true && liveApproval ? true : false,
        reviewerAvailable: context.reviewerAvailable !== false,
        timeoutAvailable: context.timeoutAvailable !== false,
        limits: context.limits,
        presets: context.presets,
        toolName: context.pending?.toolName ?? store.toolName,
        callId: context.pending?.callId ?? store.callId,
        resolved: liveApproval ? false : Boolean(context.pending?.resolved) || store.resolved,
        outcome: normalizeOutcome(context.pending?.outcome) ?? store.outcome,
      }
      // 用户已经决定/审批结束时，保留已有问答；否则以宿主线程为准（多设备一致）。
      if (!silent || !streaming) {
        patch.threads = mergeThreads(normalizeThreads(context.pending === null ? null : payload.threads), store.threads)
      }
      if (context.pending?.resolved === true && !liveApproval && !resolvedHandled) resolvedHandled = true
      emit(patch)
    }

    /** 上下文暂时对不上时，1.5s 后自动重试一次（避免和 5s 常规刷新重复排队）。 */
    function scheduleContextRetry() {
      if (runtime.contextRetryQueued || runtime.disposed) return
      runtime.contextRetryQueued = true
      after(1500, () => {
        runtime.contextRetryQueued = false
        if (!store.open || store.demo !== null) return
        if (store.resolved) return
        void loadContext({ silent: true })
      })
    }

    function isStreaming(threads) {
      return Boolean(threads?.executor?.some((turn) => turn.status === 'streaming') || threads?.reviewer?.some((turn) => turn.status === 'streaming'))
    }

    /** 宿主线程 + 本地错误/双问标记合并。 */
    function mergeThreads(hostThreads, localThreads) {
      const localById = new Map()
      for (const turn of localThreads.executor) localById.set(turn.id, turn)
      const merged = {
        executor: hostThreads.executor.map((turn) => {
          const local = localById.get(turn.id)
          return local?.compare ? { ...turn, compare: true } : turn
        }),
        reviewer: hostThreads.reviewer.map((turn) => {
          const local = localById.get(turn.id)
          return local?.compare ? { ...turn, compare: true } : turn
        }),
      }
      // 本地失败/已取消、宿主还没建档的条目要留着（否则错误行会“凭空消失”）。
      const appendLocalOnly = (target) => {
        const hostIds = new Set(merged[target].map((turn) => turn.id))
        for (const turn of localThreads[target] ?? []) {
          if (hostIds.has(turn.id)) continue
          if (turn.status === 'error' || turn.status === 'streaming') merged[target].push(turn)
        }
      }
      appendLocalOnly('executor')
      appendLocalOnly('reviewer')
      return merged
    }

    function updateThread(target, threadId, updater) {
      const current = store.threads[target] ?? []
      let touched = false
      const next = current.map((turn) => {
        if (turn.id !== threadId) return turn
        touched = true
        return updater(turn)
      })
      if (!touched) return
      emit({ threads: { ...store.threads, [target]: next } })
    }

    function findThread(target, threadId) {
      return (store.threads[target] ?? []).find((turn) => turn.id === threadId) ?? null
    }

    /** usage 文案（缓存/输入/输出）。 */
    function formatUsage(t, usage) {
      if (!usage || typeof usage !== 'object') return null
      if (usage.cacheReadTokens) {
        return fmt(t('usageCache'), {
          cache: formatTokens(usage.cacheReadTokens),
          input: formatTokens(usage.inputTokens),
          output: formatTokens(usage.outputTokens),
        })
      }
      return fmt(t('usagePlain'), { input: formatTokens(usage.inputTokens), output: formatTokens(usage.outputTokens) })
    }

    /** 轮询一个回答任务。返回停止函数。 */
    function pollJob(target, threadId, jobId, generation) {
      let cursor = 0
      let stopped = false
      const handler = { stopped: false }
      activePolls.set(threadId, handler)
      const stop = () => {
        stopped = true
        handler.stopped = true
        if (activePolls.get(threadId) === handler) activePolls.delete(threadId)
      }
      const tick = async () => {
        if (stopped || runtime.disposed || generation !== pollGeneration) return
        try {
          const payload = await requestJson(`${API}/poll?jobId=${encodeURIComponent(jobId)}&cursor=${cursor}`)
          if (stopped || runtime.disposed || generation !== pollGeneration) return
          cursor = Number(payload?.cursor) >= 0 ? Number(payload.cursor) : cursor
          const delta = typeof payload?.delta === 'string' ? payload.delta : ''
          const status = typeof payload?.status === 'string' ? payload.status : 'streaming'
          const turn = findThread(target, threadId)
          // 用户已经停止/重试替换掉这条时，别再写回去。
          if (turn === null) {
            stop()
            return
          }
          updateThread(target, threadId, (item) => ({
            ...item,
            answer: (item.answer ?? '') + delta,
            status,
            usage: payload?.usage ?? item.usage,
            error: payload?.error ?? (status === 'error' ? item.error ?? 'error' : null),
            finishedAt: payload?.finishedAt ?? item.finishedAt ?? null,
          }))
          if (status === 'streaming') {
            after(POLL_INTERVAL_MS, tick)
          } else {
            stop()
            emit({ live: status === 'done' ? 'done' : status === 'error' ? 'error' : 'done' })
            // 完成后补一次上下文：拿 injectedAt / usage / 会话保存状态。
            after(600, () => {
              if (store.open) void loadContext({ silent: true })
            })
            if (status === 'done' && target !== store.tab) {
              emit({ compareReady: { target, threadId } })
            }
          }
        } catch (error) {
          stop()
          const info = describeError(error)
          updateThread(target, threadId, (item) => ({ ...item, status: 'error', error: info }))
          emit({ live: 'error' })
        }
      }
      after(70, tick)
      return stop
    }

    /** 发送问题（target 为执行/审查）。 */
    async function sendQuestion(target, questionOverride, options) {
      const raw = typeof questionOverride === 'string' ? questionOverride : store.draft
      const max = store.limits?.maxQuestionChars ?? 2000
      let question = String(raw ?? '').trim()
      if (question.length === 0) return false
      if (question.length > max) {
        question = clampText(question, max)
        toast('toastTooLong', { max })
      }
      const sessionId = store.sessionId
      if (!sessionId) {
        toast('errNoPending')
        return false
      }
      const compare = options?.compare === true
      emit({ draft: '', compareReady: null, live: 'streaming' })
      // 用户在咨询 = 人在现场：第一次发问时自动暂停一次自动拒绝倒计时。
      void ensureTimeoutPaused()
      if (store.demo !== null) {
        sendDemo(target, question, compare)
        return true
      }
      const localId = nextLocalId('local')
      emit({
        threads: {
          ...store.threads,
          [target]: [
            ...(store.threads[target] ?? []),
            {
              id: localId,
              question,
              answer: '',
              status: 'streaming',
              at: Date.now(),
              usage: null,
              error: null,
              compare,
              jobId: null,
            },
          ],
        },
      })
      try {
        const payload = await requestJson(`${API}/ask`, {
          method: 'POST',
          body: JSON.stringify({
            sessionId,
            callId: store.callId ?? undefined,
            toolName: store.toolName ?? undefined,
            consultKey: store.consultKey ?? undefined,
            target,
            question,
          }),
        })
        if (runtime.disposed) return true
        const threadId = String(payload?.threadId ?? localId)
        const jobId = String(payload?.jobId ?? '')
        // 用宿主 id 替换本地占位（宿主线程 id 是本面板线程的唯一身份）。
        emit({
          threads: {
            ...store.threads,
            [target]: (store.threads[target] ?? []).map((turn) =>
              turn.id === localId ? { ...turn, id: threadId, jobId, compare } : turn,
            ),
          },
          consultKey: typeof payload?.consultKey === 'string' ? payload.consultKey : store.consultKey,
        })
        if (jobId.length === 0) {
          updateThread(target, threadId, (turn) => ({ ...turn, status: 'error', error: { key: 'errServer', code: 'no-job', detail: 'no jobId' } }))
          return true
        }
        const generation = pollGeneration
        const stop = pollJob(target, threadId, jobId, generation)
        void stop
        return true
      } catch (error) {
        const info = describeError(error)
        // 审查侧还没评估：把问题卡换成“让审查 AI 重新评估”，并回到审查 tab。
        if (info.code === 'review-not-initialized') {
          emit({
            reviewNeedsClassification: true,
            tab: 'reviewer',
            threads: { ...store.threads, [target]: (store.threads[target] ?? []).filter((turn) => turn.id !== localId) },
            live: '',
          })
          return false
        }
        // 审批已经结束：不要留一个死面板 + 错误 toast，直接切到结束态并刷新上下文。
        // 但如果客户端仍在等待审批（宿主咨询记录还没对上），保持等待态并稍后重试。
        if (info.code === 'no-pending' || info.code === 'approval-resolved') {
          const live = runtime.livePending
          const liveApproval =
            live !== null && live !== undefined && (live.answerable === undefined || live.answerable !== false) && store.decided !== true
          if (liveApproval) {
            emit({
              contextMissing: true,
              threads: { ...store.threads, [target]: (store.threads[target] ?? []).filter((turn) => turn.id !== localId) },
              live: '',
            })
            toast('contextSyncing')
            scheduleContextRetry()
            return false
          }
          resolvedHandled = true
          emit({
            resolved: true,
            outcome: store.outcome ?? store.pending?.outcome ?? null,
            contextMissing: false,
            threads: { ...store.threads, [target]: (store.threads[target] ?? []).filter((turn) => turn.id !== localId) },
            live: '',
          })
          void loadContext({ silent: true })
          return false
        }
        updateThread(target, localId, (turn) => ({ ...turn, status: 'error', error: info }))
        emit({ live: 'error' })
        return false
      }
    }

    /** 双问：同一条问题发给两边（各自独立任务）。 */
    async function sendCompare() {
      const question = store.draft.trim()
      if (question.length === 0) return
      const other = store.tab === 'executor' ? 'reviewer' : 'executor'
      if (!isSideAvailable(store.tab) || !isSideAvailable(other)) {
        toast('tabCompareUnavailable')
        return
      }
      const primary = store.tab
      await Promise.all([sendQuestion(primary, question, { compare: true }), sendQuestion(other, question, { compare: true })])
    }

    /**
     * 审查侧是否「材料就绪但还没有结论」：这是 advisory（非自动审查触发）的路径。
     * 这种状态下不能直接提问，必须先跑 /review 兜底评估。
     */
    function reviewerNeedsReview(reviewer) {
      if (reviewer === null || reviewer === undefined) return false
      if (store.reviewNeedsClassification) return true
      if (store.reviewerOverride !== null) return false
      if (reviewer.available === false) return false
      if (reviewer.advisory === true && reviewer.needsClassification === true) return true
      // 兜底：advisory 且没有任何结论字段时同样视为未评估。
      if (reviewer.advisory === true && (reviewer.risk === undefined || reviewer.risk === null) && (reviewer.decision === undefined || reviewer.decision === null)) return true
      return false
    }

    /** 有效审查上下文：/review 的结论优先于 /context，保证“立即更新”。 */
    function effectiveReviewer(context) {
      const reviewer = context?.reviewer ?? null
      if (reviewer === null || reviewer === undefined) return reviewer
      if (store.reviewerOverride === null) return reviewer
      return { ...reviewer, ...store.reviewerOverride, available: true, advisory: true, needsClassification: false, classified: true }
    }

    /** 某一侧是否可以提问（审查侧还要求已有结论）。 */
    function isSideAvailable(target) {
      if (target === 'reviewer' && store.reviewerAvailable === false) return false
      if (store.demo !== null) {
        if (store.demo === 'no-reviewer' && target === 'reviewer') return false
        if (store.demo === 'no-executor' && target === 'executor') return false
        if (target === 'reviewer' && reviewerNeedsReview(effectiveReviewer(store.context))) return false
        return true
      }
      const context = store.context
      if (context === null) return true
      const side = target === 'executor' ? context.executor : effectiveReviewer(context)
      if (side === null || side === undefined) return true
      if (side.available === false) return false
      if (target === 'reviewer' && reviewerNeedsReview(side)) return false
      return true
    }

    /**
     * 让审查 AI 兜底重新评估（非 auto-review 触发的审批）。
     * 成功后立即覆盖上下文卡片，并解除“不可提问”的限制。
     */
    async function requestAdvisoryReview() {
      if (store.reviewBusy) return
      if (store.demo === null && !store.sessionId) {
        toast('errNoPending')
        return
      }
      emit({ reviewBusy: true, reviewError: null })
      if (store.demo !== null) {
        // demo：模拟 1.4s 的评估，给视觉与状态机用。
        after(1400, () => {
          emit({
            reviewBusy: false,
            reviewError: null,
            reviewNeedsClassification: false,
            reviewerOverride: {
              risk: 'medium',
              decision: 'deny',
              reason: '（演示）重新评估后仍判为中风险：删除的是工作区之外的既有文件，且没有备份；建议先确认文件可丢弃，或改为移动到备份目录。',
              decisionText: '{"risk":"medium","decision":"deny"}',
              usage: { inputTokens: 2260, outputTokens: 128, cacheReadTokens: 64000 },
              reviewedAt: Date.now(),
            },
          })
          toast('reviewDone')
        })
        return
      }
      try {
        const payload = await requestJson(`${API}/review`, {
          method: 'POST',
          body: JSON.stringify({
            sessionId: store.sessionId,
            consultKey: store.consultKey ?? undefined,
            callId: store.callId ?? undefined,
            toolName: store.toolName ?? undefined,
          }),
        })
        const override = {
          risk: payload?.risk ?? null,
          decision: payload?.decision ?? null,
          reason: payload?.reason ?? null,
          decisionText: payload?.decisionText ?? null,
          usage: payload?.usage ?? null,
          reviewedAt: Date.now(),
        }
        emit({
          reviewBusy: false,
          reviewError: payload?.error ? { key: 'errServer', code: 'review-error', detail: String(payload.error) } : null,
          reviewNeedsClassification: false,
          reviewerOverride: override,
        })
        if (payload?.error) {
          emit({ reviewNeedsClassification: false })
        } else {
          toast('reviewDone')
        }
        void loadContext({ silent: true })
      } catch (error) {
        emit({ reviewBusy: false, reviewError: describeError(error) })
      }
    }

    /** 停止某条回答。 */
    async function stopThread(target, threadId) {
      const turn = findThread(target, threadId)
      if (turn === null) return
      const handler = activePolls.get(threadId)
      if (handler) handler.stopped = true
      activePolls.delete(threadId)
      if (store.demo !== null) {
        demoStopTimers.get(threadId)?.()
        demoStopTimers.delete(threadId)
        updateThread(target, threadId, (item) => ({ ...item, status: 'cancelled' }))
        return
      }
      updateThread(target, threadId, (item) => ({ ...item, status: 'cancelled' }))
      if (!turn.jobId) return
      try {
        await requestJson(`${API}/cancel`, { method: 'POST', body: JSON.stringify({ jobId: turn.jobId }) })
      } catch {
        /* 停止失败不打扰用户：宿主侧审批结束会自行中止 */
      }
    }

    /** 重试：删掉失败条目后重新发送同一个问题。 */
    function retryThread(target, threadId) {
      const turn = findThread(target, threadId)
      if (turn === null) return
      const list = (store.threads[target] ?? []).filter((item) => item.id !== threadId)
      emit({ threads: { ...store.threads, [target]: list } })
      void sendQuestion(target, turn.question, { compare: turn.compare === true })
    }

    /** 转达审查 AI 的回答给执行 AI。 */
    async function relayThread(threadId) {
      // 审批结束后只允许回看：转达会写进执行 AI 的下一轮上下文，不能作为事后授权通道。
      if (store.resolved || store.decided) {
        toast('relayEnded')
        return
      }
      const turn = findThread('reviewer', threadId)
      if (turn === null || turn.status !== 'done' || typeof turn.answer !== 'string' || turn.answer.trim().length === 0) return
      if (store.demo !== null) {
        after(420, () => {
          updateThread('reviewer', threadId, (item) => ({ ...item, relayedAt: Date.now() }))
          toast('toastRelayed')
        })
        return
      }
      updateThread('reviewer', threadId, (item) => ({ ...item, relayBusy: true, relayError: null }))
      try {
        await requestJson(`${API}/relay`, {
          method: 'POST',
          body: JSON.stringify({
            sessionId: store.sessionId,
            consultKey: store.consultKey ?? undefined,
            callId: store.callId ?? undefined,
            toolName: store.toolName ?? undefined,
            kind: 'reviewer',
            threadId,
            text: turn.answer,
          }),
        })
        updateThread('reviewer', threadId, (item) => ({ ...item, relayBusy: false, relayedAt: Date.now() }))
        toast('toastRelayed')
      } catch (error) {
        const info = describeError(error)
        updateThread('reviewer', threadId, (item) => ({ ...item, relayBusy: false, relayError: info }))
        emit({ notice: { id: nextLocalId('notice'), key: 'relayFailed', vars: null, tone: 'error' } })
      }
    }

    /** 提交审批决定（与官方卡片同一动作）；demo 模式走本地模拟。 */
    async function decide(pending, outcome) {
      if (store.deciding) return
      if (store.demo !== null) {
        emit({ deciding: true })
        after(420, () => {
          emit({
            deciding: false,
            decided: true,
            resolved: true,
            outcome,
            pending: store.pending === null ? null : { ...store.pending, resolved: true, outcome },
            context: store.context === null ? null : { ...store.context, pending: { ...store.context.pending, resolved: true, outcome } },
          })
          toast('toastDecision')
        })
        return
      }
      if (!pending || typeof pending.answer !== 'function') return
      if (pending.answerable === false) {
        emit({ resolved: true })
        return
      }
      emit({ deciding: true })
      try {
        await pending.answer(outcome)
        emit({ deciding: false, decided: true })
        toast('toastDecision')
        // 宿主会在一小段时间内把 pending 摘掉；状态由 pending 订阅兜底。
      } catch (error) {
        // 一次性语义：官方卡片可能已经答过，这里只提示并同步为结束。
        emit({ deciding: false, resolved: true, outcome: outcome === 'allowed-once' ? 'allowed-once' : 'rejected' })
        toast('errResolved', null, 'error')
        void loadContext({ silent: true })
      }
    }

    /* ---------------- 自动拒绝倒计时（可选集成，失败静默） ---------------- */

    /** 探测 dsh-approval-timeout 的当前倒计时（只读；失败完全静默）。 */
    async function probeTimeout() {
      if (store.demo !== null) return
      if (store.timeoutAvailable === false) {
        if (store.timeout !== null) emit({ timeout: null })
        return
      }
      try {
        const payload = await requestJson(`${TIMEOUT_API}/status`)
        const pendingList = Array.isArray(payload?.pending) ? payload.pending : []
        const match =
          pendingList.find((item) => store.callId && item.callId === store.callId) ??
          pendingList.find((item) => store.toolName && item.toolName === store.toolName) ??
          null
        if (match === null) {
          if (store.timeout !== null) emit({ timeout: null })
          return
        }
        emit({
          timeout: {
            timeoutMs: Number(payload?.timeoutMs) || null,
            elapsedMs: Number(match.elapsedMs) || 0,
            probedAt: Date.now(),
            cancelled: match.cancelled === true,
          },
        })
      } catch {
        if (store.timeout !== null) emit({ timeout: null })
      }
    }

    /** 宿主配置的倒计时暂停策略：on-send（默认）/ on-open / off。 */
    function normalizeTimeoutAutoPause(value) {
      if (value === 'on-open' || value === 'off' || value === 'on-send') return value
      if (value === false) return 'off'
      return 'on-send'
    }
    function timeoutAutoPauseMode() {
      if (store.demo !== null) return 'off'
      return normalizeTimeoutAutoPause(store.context?.timeoutAutoPause ?? store.context?.features?.timeoutAutoPause)
    }

    /** 是否是另一个待审批项（不是当前面板对应的这一条）。 */
    function isOtherApproval(item) {
      if (item === null || item === undefined) return false
      if (store.callId && item.callId) return String(item.callId) !== String(store.callId)
      if (store.toolName && item.toolName) return String(item.toolName) !== String(store.toolName)
      return true
    }

    /**
     * 暂停倒计时。
     * 注意：dsh-approval-timeout 的 /cancel 是全局的，会同时取消**所有**待审批项的倒计时。
     * 所以自动路径（force=false）先探测是否还有其它未取消的待审批项，有就不动，
     * 避免“我在一个会话里点开咨询台，把别的会话的 60s 保护也关了”。
     * 用户显式点「暂停倒计时」时（force=true）才允许全局取消。
     */
    async function pauseTimeout(notify, options) {
      const force = options?.force === true
      if (store.demo !== null) {
        emit({ timeoutPaused: true, timeout: store.timeout === null ? null : { ...store.timeout, cancelled: true } })
        if (notify !== false) toast('toastPaused')
        return true
      }
      if (store.timeoutAvailable === false) return false
      try {
        const status = await requestJson(`${TIMEOUT_API}/status`).catch(() => null)
        const pendingList = Array.isArray(status?.pending) ? status.pending : []
        const otherLive = pendingList.filter((item) => item && item.cancelled !== true && isOtherApproval(item))
        if (!force && otherLive.length > 0) {
          // 自动路径不越权：保留它们，提示用户可以手动暂停（手动会一并取消）。
          toast('timeoutShared')
          return false
        }
        await fetch(`${TIMEOUT_API}/cancel`, { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
        emit({ timeoutPaused: true, timeout: store.timeout === null ? null : { ...store.timeout, cancelled: true } })
        if (notify !== false) toast('toastPaused')
        void probeTimeout()
        return true
      } catch {
        /* 探测不到就完全静默 */
        return false
      }
    }

    let timeoutAutoPaused = false
    /** 用户开始提问：按配置暂停倒计时（默认 on-send 才会走到这里）。 */
    async function ensureTimeoutPaused() {
      if (timeoutAutoPaused || store.demo !== null) return
      if (store.timeoutAvailable === false) return
      if (timeoutAutoPauseMode() === 'off') return
      if (store.timeout === null || store.timeout.cancelled || store.timeoutPaused) return
      timeoutAutoPaused = true
      const paused = await pauseTimeout(false)
      if (paused) toast('toastPaused')
      timeoutAutoPaused = paused
    }

    /**
     * 打开面板时的行为由宿主配置决定（默认 on-send：打开不动倒计时）。
     * 仍然探测一次，只为了让面板显示剩余秒数；是否暂停交给配置。
     */
    async function autoPauseOnOpen() {
      if (store.demo !== null) return
      if (store.timeoutAvailable === false) return
      await probeTimeout()
      if (timeoutAutoPauseMode() !== 'on-open') return
      if (timeoutAutoPaused) return
      if (store.timeout === null || store.timeout.cancelled || store.timeoutPaused) return
      timeoutAutoPaused = true
      const paused = await pauseTimeout(false)
      if (paused) toast('toastPaused')
    }

    /* ---------------- 打开 / 关闭 ---------------- */

    function openPanel(sessionId, pending, tab) {
      const demoVariant = readDemoVariant()
      const reviewerDisabled = demoVariant === 'no-reviewer' || store.reviewerAvailable === false
      const preferred = tab === 'reviewer' || tab === 'executor' ? tab : null
      const resolvedTab = preferred === 'reviewer' && reviewerDisabled ? 'executor' : preferred ?? (reviewerDisabled ? 'executor' : 'reviewer')
      pollGeneration += 1
      activePolls.clear()
      timeoutAutoPaused = false
      resolvedHandled = false
      emit({
        open: true,
        mode: 'pending',
        demo: demoVariant,
        sessionId: sessionId ?? null,
        toolName: pending?.toolName ?? null,
        callId: pending?.callId ?? null,
        consultKey: null,
        tab: resolvedTab,
        compare: false,
        draft: '',
        context: null,
        contextError: null,
        contextMissing: false,
        reviewerAvailable: demoVariant === 'no-reviewer' ? false : true,
        timeoutAvailable: true,
        loadingContext: demoVariant === null,
        pending: pending
          ? {
              key: pending.key ?? null,
              toolName: pending.toolName ?? null,
              callId: pending.callId ?? null,
              reason: pending.reason ?? null,
              displayReason: pending.displayReason ?? null,
              resolved: false,
              outcome: null,
            }
          : null,
        resolved: false,
        outcome: null,
        decided: false,
        deciding: false,
        reviewBusy: false,
        reviewError: null,
        reviewerOverride: null,
        reviewNeedsClassification: false,
        threads: { executor: [], reviewer: [] },
        presets: { executor: [], reviewer: [] },
        limits: { maxQuestionChars: 2000, maxConcurrentJobs: 3 },
        timeout: null,
        timeoutPaused: false,
        timeoutBannerDismissed: false,
        compareReady: null,
        notice: null,
        live: '',
      })
      if (demoVariant !== null) {
        applyDemoContext(demoVariant)
        return
      }
      // 倒计时探测推迟到 /context 返回之后：宿主若报告 timeoutAvailable=false，
      // 就完全不请求那个插件的路由（不产生 404 噪音，也不显示任何相关内容）。
      void loadContext()
    }

    function closePanel() {
      if (!store.open) return
      pollGeneration += 1
      activePolls.clear()
      runtime.contextRetryQueued = false
      emit({ open: false, mode: 'pending', draft: '', notice: null, compareReady: null, deciding: false, loadingContext: false, contextMissing: false })
    }

    /** 关闭当前会话后，若审批仍在等待，胶囊重新出现。 */
    function reopenCurrent() {
      const current = currentSession.get()
      const pending = current === null ? null : pendingOf(current)
      openPanel(current, pending, store.tab)
    }

    /* ---------------- 只读咨询记录（/history） ---------------- */

    const HISTORY_TTL_MS = 30000
    /** sessionId -> { at, promise, items }：30s 缓存 + 并发去重，避免每个 Turn 都打宿主。 */
    const historyCache = new Map()

    /** turnTail 每轮都会挂载：用 session 内的最大 seq 判断“最后一轮”。 */
    const tailState = { version: 0, maxBySession: new Map(), listeners: new Set() }

    function subscribeTail(listener) {
      tailState.listeners.add(listener)
      return () => {
        tailState.listeners.delete(listener)
      }
    }

    function noteTurnTail(sessionId, seq) {
      if (!sessionId || typeof seq !== 'number') return
      const current = tailState.maxBySession.get(sessionId)
      if (current !== undefined && seq <= current) return
      tailState.maxBySession.set(sessionId, seq)
      tailState.version += 1
      for (const listener of [...tailState.listeners]) {
        try {
          listener()
        } catch {
          /* ignore */
        }
      }
    }

    function normalizeHistoryItem(item) {
      const threads = normalizeThreads(item?.threads)
      return {
        consultKey: String(item?.consultKey ?? ''),
        toolName: String(item?.toolName ?? ''),
        callId: item?.callId ?? null,
        startedAt: Number(item?.startedAt) || 0,
        resolved: item?.resolved === true,
        resolvedAt: item?.resolvedAt ?? null,
        outcome: normalizeOutcome(item?.outcome),
        reviewSource: typeof item?.reviewSource === 'string' ? item.reviewSource : 'none',
        risk: typeof item?.risk === 'string' ? item.risk : null,
        decision: typeof item?.decision === 'string' ? item.decision : null,
        reason: typeof item?.reason === 'string' ? item.reason : null,
        threads,
        relays: Number(item?.relays) || 0,
        counts: {
          executor: Number(item?.counts?.executor) || threads.executor.length,
          reviewer: Number(item?.counts?.reviewer) || threads.reviewer.length,
        },
      }
    }

    /** 拉取会话的咨询历史（30s 缓存 + in-flight 去重）。 */
    function loadHistory(sessionId) {
      if (!sessionId) return Promise.resolve([])
      const cached = historyCache.get(sessionId)
      if (cached) {
        if (cached.promise) return cached.promise
        if (Date.now() - cached.at < HISTORY_TTL_MS) return Promise.resolve(cached.items)
      }
      const promise = requestJson(`${API}/history?sessionId=${encodeURIComponent(sessionId)}&limit=8`)
        .then((payload) => {
          const items = Array.isArray(payload?.items) ? payload.items.map(normalizeHistoryItem) : []
          historyCache.set(sessionId, { at: Date.now(), promise: null, items })
          return items
        })
        .catch((error) => {
          historyCache.delete(sessionId)
          throw error
        })
      historyCache.set(sessionId, { at: cached?.at ?? 0, promise, items: cached?.items ?? [] })
      return promise
    }

    /** 历史面板里的“重试”。 */
    async function reloadHistory() {
      const sessionId = store.sessionId
      if (!sessionId) return
      historyCache.delete(sessionId)
      emit({ history: { ...store.history, loading: true, error: null } })
      try {
        const items = await loadHistory(sessionId)
        if (!store.open || store.mode !== 'history') return
        emit({ history: { loading: false, error: null, items, total: items.length, sessionId } })
      } catch (error) {
        if (!store.open || store.mode !== 'history') return
        emit({ history: { ...store.history, loading: false, error: describeError(error) } })
      }
    }

    /** 打开只读历史面板（复用同一个抽屉/底部弹层）。 */
    function openHistoryPanel(sessionId, items) {
      pollGeneration += 1
      activePolls.clear()
      const list = Array.isArray(items) ? items : []
      emit({
        open: true,
        mode: 'history',
        demo: readDemoVariant(),
        sessionId: sessionId ?? null,
        history: { loading: false, error: null, items: list, total: list.length, sessionId: sessionId ?? null },
        pending: null,
        resolved: true,
        context: null,
        contextError: null,
        loadingContext: false,
        threads: { executor: [], reviewer: [] },
        draft: '',
        notice: null,
        compareReady: null,
        deciding: false,
        decided: false,
        timeout: null,
      })
    }

    /* ------------------------------------------------------------------ */
    /* demo 数据与伪造流                                                    */
    /* ------------------------------------------------------------------ */

    const demoStopTimers = new Map()

    function applyDemoContext(variant) {
      const noReviewer = variant === 'no-reviewer'
      const noExecutor = variant === 'no-executor'
      const advisory = variant === 'advisory'
      // demo 的 error 分支：只为在无审批环境里验收错误块与重试，不碰真实宿主。
      const failure = variant === 'error'
      const context = {
        serverTime: Date.now(),
        consultKey: 'demo:1',
        pending: {
          consultKey: 'demo:1',
          toolName: 'pwsh',
          callId: 'call_demo',
          reason: 'Auto review denied tool "pwsh": 该命令会删除工作区之外的既有文件，需要你确认。',
          displayReason: {
            en: 'Auto review denied this call: it deletes an existing file outside the workspace.',
            zh: 'Auto review 拒绝了此调用：该命令会删除工作区之外的既有文件，需要你确认。',
          },
          startedAt: Date.now() - 62000,
          resolved: false,
          resolvedAt: null,
          outcome: null,
          error: null,
        },
        executor: noExecutor
          ? { available: false }
          : {
              available: true,
              provider: 'opencode-go',
              model: 'deepseek-v4.1-flash',
              messageCount: 42,
              toolCount: 18,
              capturedAt: Date.now() - 30000,
              argumentsPreview: '{\n  "command": "Remove-Item -Force D:\\\\tmp\\\\old-build.zip",\n  "description": "清理上次构建留下的压缩包"\n}',
              toolDescription: 'Run a PowerShell command on the host.',
              assistantNote: '我先清理上次构建留下的压缩包，再继续打包。这个文件是上次失败构建的产物，重新打包时会重新生成。',
            },
        reviewer: noReviewer
          ? {
              available: false,
              reason: 'no-review-captured',
              hint: '演示：本次审批没有自动审查记录（切换 `?consult-demo=1` 可恢复）。',
            }
          : advisory
            ? {
                // 非 auto-review 触发的审批：材料就绪，但没有结论，需要 /review 兜底。
                available: true,
                advisory: true,
                classified: false,
                needsClassification: true,
                failed: false,
                error: null,
                action: { mode: 'native', name: 'pwsh', description: 'Run a PowerShell command on the host.', parameters: {} },
                historyCount: 11,
                hint: '没有捕获到官方审查请求，但有足够的材料让审查 AI 重新评估这次调用。',
              }
            : {
              available: true,
              failed: false,
              error: null,
              provider: 'opencode-go',
              model: 'deepseek-v4.1-flash',
              capturedAt: Date.now() - 45000,
              risk: 'medium',
              decision: 'deny',
              reason: '该操作会不可逆地删除一个已存在的文件，且当前指令没有明确授权这个路径；目标位于工作区之外，误删会造成不可恢复的数据丢失。',
              decisionText: '{"risk":"medium","decision":"deny"}',
              finishKind: 'stop',
              usage: { inputTokens: 1820, outputTokens: 96, cacheReadTokens: 32768 },
              action: { mode: 'native', name: 'pwsh', description: 'Run a PowerShell command on the host.' },
              historyCount: 12,
            },
        threads: { executor: [], reviewer: [] },
        presets: {
          executor: ['这个操作为什么必须执行？', '它会改动哪些文件？', '有没有更安全的替代做法？'],
          reviewer: ['这次审查结论是什么意思？', '具体风险点在哪？', '什么条件下可以放心允许？'],
        },
        limits: { maxQuestionChars: 2000, maxConcurrentJobs: 3 },
        features: { ask: true, followUp: true, relay: true, decision: true, compare: true },
      }
      emit({
        loadingContext: false,
        context: failure ? null : context,
        contextError: failure ? { key: 'errNetwork', code: 'network', detail: '演示：模拟无法读取审批上下文' } : null,
        consultKey: context.consultKey,
        pending: context.pending,
        toolName: context.pending.toolName,
        callId: context.pending.callId,
        presets: failure ? { executor: [], reviewer: [] } : context.presets,
        limits: context.limits,
        // demo 倒计时：让 chip 在无审批环境也能看到（3 分钟 / 已过 62 秒）。
        timeout: { timeoutMs: 180000, elapsedMs: 62000, probedAt: Date.now(), cancelled: false },
      })
    }

    /** demo 回答（刻意带 Markdown，用来验证渲染器）。 */
    function demoAnswer(target, question) {
      if (target === 'reviewer') {
        return [
          `关于「${question}」，我的判断是 **中风险 / 建议拒绝**：`,
          '',
          '### 具体风险点',
          '1. **删除不可逆**：文件一旦删掉，没有回收站可以恢复；',
          '2. **路径越界**：`D:\\tmp` 不在当前工作目录内，超出你这次任务的授权范围；',
          '3. **必要性不明**：这条命令只是为了清理旧构建产物，重新打包并不依赖它。',
          '',
          '被删的文件与命令：',
          '```powershell',
          'Remove-Item -Force D:\\tmp\\old-build.zip',
          '```',
          '',
          '> 如果你确认这个文件可以丢弃，允许一次是合理的；',
          '> 否则更稳的做法是让执行 AI 先把它移到备份目录。',
          '',
          '需要我进一步解释哪一条风险？',
        ].join('\n')
      }
      return [
        `关于「${question}」，我准备执行的是：`,
        '',
        '```powershell',
        'Remove-Item -Force D:\\tmp\\old-build.zip',
        '```',
        '',
        '目的只有一个：删掉上次 *失败构建* 留下的压缩包，避免它一直占着磁盘。',
        '',
        '- 不会碰工作区里的任何源文件',
        '- 不会改动正在使用的构建输出',
        '- 失败时任务可以继续，我会换一种只读方式收集信息',
        '',
        '如果这个文件其实还要用，我可以改成先重命名为 `old-build.zip.bak`，等你确认后再删。',
      ].join('\n')
    }

    /** demo：历史回看用的 mock（让无真实审批时也能验收历史面板）。 */
    function demoHistoryItems() {
      const now = Date.now()
      return [
        normalizeHistoryItem({
          consultKey: 'demo:2',
          toolName: 'pwsh',
          callId: 'call_demo_2',
          startedAt: now - 3600_000,
          resolved: true,
          resolvedAt: now - 3540_000,
          outcome: 'rejected',
          reviewSource: 'advisory',
          risk: 'high',
          decision: 'deny',
          reason: '该命令会**递归删除**工作区之外的目录，且没有备份；建议改为先移动再确认。',
          relays: 1,
          counts: { executor: 1, reviewer: 1 },
          threads: {
            executor: [
              {
                id: 'q:demo1',
                question: '这个操作会改动哪些文件？',
                answer: '不会改动工作区内的文件；它只删除 `D:\\tmp\\build-cache`，这是构建缓存目录，重跑构建会重新生成。',
                status: 'done',
                at: now - 3580_000,
                usage: { cacheReadTokens: 18432, inputTokens: 1680, outputTokens: 214 },
                injectedAt: now - 3579_000,
              },
            ],
            reviewer: [
              {
                id: 'q:demo2',
                question: '具体风险点在哪？',
                answer: '1. **不可逆**：递归删除没有回收站；\n2. **范围过大**：`D:\\tmp` 不在授权范围内。\n\n```powershell\nRemove-Item -Recurse -Force D:\\tmp\\build-cache\n```',
                status: 'done',
                at: now - 3560_000,
                usage: { cacheReadTokens: 32768, inputTokens: 2140, outputTokens: 286 },
                relayedAt: now - 3550_000,
              },
            ],
          },
        }),
        normalizeHistoryItem({
          consultKey: 'demo:1',
          toolName: 'write',
          callId: 'call_demo_1',
          startedAt: now - 7200_000,
          resolved: true,
          resolvedAt: now - 7180_000,
          outcome: 'allowed-once',
          reviewSource: 'captured',
          risk: 'medium',
          decision: 'allow',
          reason: '只写入了工作区内一个新建的文本文件，风险可控。',
          relays: 0,
          counts: { executor: 0, reviewer: 1 },
          threads: {
            executor: [],
            reviewer: [
              {
                id: 'q:demo3',
                question: '为什么这次审查放行了？',
                answer: '因为目标文件在工作区内、且是**新建**的，不存在覆盖风险；内容只是纯文本。',
                status: 'done',
                at: now - 7190_000,
                usage: { cacheReadTokens: 8192, inputTokens: 940, outputTokens: 120 },
              },
            ],
          },
        }),
      ]
    }

    function sendDemo(target, question, compare) {
      if ((store.demo === 'no-reviewer' && target === 'reviewer') || (store.demo === 'no-executor' && target === 'executor')) {
        const key = target === 'reviewer' ? 'errReviewerMissing' : 'errExecutorMissing'
        toast(key, null, 'error')
        return
      }
      const id = nextLocalId('demo')
      emit({
        threads: {
          ...store.threads,
          [target]: [...(store.threads[target] ?? []), { id, question, answer: '', status: 'streaming', at: Date.now(), usage: null, error: null, compare }],
        },
      })
      const full = demoAnswer(target, question)
      let index = 0
      const timer = every(46, () => {
        index = Math.min(full.length, index + 3 + Math.floor(Math.random() * 4))
        const done = index >= full.length
        updateThread(target, id, (turn) => ({
          ...turn,
          answer: full.slice(0, index),
          status: done ? 'done' : 'streaming',
          usage: done
            ? target === 'reviewer'
              ? { cacheReadTokens: 32768, inputTokens: 2140, outputTokens: 286 }
              : { cacheReadTokens: 18432, inputTokens: 1680, outputTokens: 214 }
            : null,
          // 执行侧宿主会自动注入会话：demo 里也模拟一下“已保存到会话”。
          injectedAt: done && target === 'executor' ? Date.now() : turn.injectedAt ?? null,
        }))
        if (!done) return
        demoStopTimers.get(id)?.()
        demoStopTimers.delete(id)
        emit({ live: 'done' })
        if (target !== store.tab) emit({ compareReady: { target, threadId: id } })
      })
      demoStopTimers.set(id, timer)
    }

    /* ------------------------------------------------------------------ */
    /* Root 作用域数据源（会话 + 审批状态）                                 */
    /* ------------------------------------------------------------------ */

    let sessionSource = null
    let statusSource = null

    function safeGet(source, fallback) {
      try {
        return typeof source?.getSnapshot === 'function' ? source.getSnapshot() : fallback
      } catch {
        return fallback
      }
    }

    function safeSubscribe(source, listener) {
      try {
        if (source && typeof source.subscribe === 'function') {
          const dispose = source.subscribe(listener)
          return typeof dispose === 'function' ? dispose : () => {}
        }
      } catch {
        /* ignore */
      }
      return () => {}
    }

    /** adapter.current 的 snapshot 是 StandardSourceBinding，sessionId 在 props 里。 */
    function sessionIdOfBinding(binding) {
      if (binding === null || binding === undefined || typeof binding !== 'object') return null
      const fromProps = binding.props?.sessionId ?? binding.props?.key
      if (typeof fromProps === 'string' && fromProps.length > 0) return fromProps
      if (typeof binding.key === 'string' && binding.key.length > 0) return binding.key
      return null
    }

    function currentSessionId() {
      return sessionIdOfBinding(safeGet(sessionSource, null))
    }

    const currentSession = {
      get: currentSessionId,
      subscribe: (listener) => safeSubscribe(sessionSource, listener),
    }

    /** sessionStatus 快照是 Map<sessionId, { running, pendingInteraction, completionUnread }>。 */
    function pendingOf(sessionId) {
      if (!sessionId) return null
      const snapshot = safeGet(statusSource, null)
      if (!snapshot || typeof snapshot.get !== 'function') return null
      const status = snapshot.get(sessionId)
      const pending = status?.pendingInteraction
      if (pending && pending.kind === 'approval') return pending
      return null
    }

    function subscribeStatus(listener) {
      return safeSubscribe(statusSource, listener)
    }

    function readStatusPending(sessionId) {
      return pendingOf(sessionId)
    }

    /* ------------------------------------------------------------------ */
    /* React hooks                                                         */
    /* ------------------------------------------------------------------ */

    function useStore() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      }
      const [value, setValue] = React.useState(getSnapshot)
      React.useEffect(() => subscribe(() => setValue(getSnapshot())), [])
      return value
    }

    /** 订阅 root 作用域的当前会话 id。 */
    function useCurrentSessionId() {
      const getSnapshot = React.useCallback(() => currentSession.get(), [])
      return React.useSyncExternalStore(currentSession.subscribe, getSnapshot, getSnapshot)
    }

    /** 订阅某会话的审批 pendingInteraction。 */
    function useSessionPending(sessionId) {
      const getSnapshot = React.useCallback(() => (sessionId ? readStatusPending(sessionId) : null), [sessionId])
      return React.useSyncExternalStore(subscribeStatus, getSnapshot, getSnapshot)
    }

    function useMediaQuery(query) {
      const [matches, setMatches] = React.useState(() => {
        try {
          return window.matchMedia(query).matches
        } catch {
          return false
        }
      })
      React.useEffect(() => {
        let media = null
        try {
          media = window.matchMedia(query)
        } catch {
          return undefined
        }
        const onChange = () => setMatches(media.matches)
        onChange()
        try {
          if (typeof media.addEventListener === 'function') {
            media.addEventListener('change', onChange)
            return () => media.removeEventListener('change', onChange)
          }
          media.addListener(onChange)
          return () => media.removeListener(onChange)
        } catch {
          return undefined
        }
      }, [query])
      return matches
    }

    /** 视觉视口：处理手机键盘弹出时底部弹层被顶出屏幕的问题。 */
    function useVisualViewport() {
      const read = () => {
        try {
          const vv = window.visualViewport
          const layoutHeight = window.innerHeight
          const height = vv ? vv.height : layoutHeight
          const offsetTop = vv ? vv.offsetTop : 0
          return { height, keyboard: Math.max(0, Math.round(layoutHeight - height - offsetTop)) }
        } catch {
          return { height: 0, keyboard: 0 }
        }
      }
      const [viewport, setViewport] = React.useState(read)
      React.useEffect(() => {
        const vv = window.visualViewport
        if (!vv) return undefined
        const onChange = () => setViewport(read())
        try {
          vv.addEventListener('resize', onChange)
          vv.addEventListener('scroll', onChange)
        } catch {
          return undefined
        }
        onChange()
        return () => {
          try {
            vv.removeEventListener('resize', onChange)
            vv.removeEventListener('scroll', onChange)
          } catch {
            /* ignore */
          }
        }
      }, [])
      return viewport
    }

    /* ------------------------------------------------------------------ */
    /* 组件：错误边界与入口                                                */
    /* ------------------------------------------------------------------ */

    /** 渲染兜底：单个条目崩溃不能把整块 slot 变空白。 */
    class OverlayBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false, error: null }
        this.retry = this.retry.bind(this)
      }

      static getDerivedStateFromError(error) {
        return { failed: true, error }
      }

      componentDidCatch(error) {
        try {
          console.error('[approval-consult] render failed', error)
        } catch {
          /* ignore */
        }
      }

      retry() {
        this.setState({ failed: false, error: null })
      }

      render() {
        if (!this.state.failed) return this.props.children
        const t = this.props.t ?? ((key) => key)
        return h(
          'div',
          { className: 'ac-fatal', 'data-approval-consult-error': '', role: 'alert' },
          h('div', { className: 'ac-fatal-title' }, t('fatalTitle')),
          h('div', { className: 'ac-fatal-hint' }, t('fatalHint')),
          h(
            'button',
            { type: 'button', className: 'ac-btn ac-btn-ghost', onClick: this.retry },
            t('fatalRetry'),
          ),
        )
      }
    }

    /**
     * 唯一入口组件：pill 与面板都在这里。
     * hooks 全部在 return 之前 —— 这是骨架 bug 的根因。
     */
    function ConsultOverlay(props) {
      const t = props.t ?? ((key) => key)
      const state = useStore()
      const narrow = useMediaQuery(NARROW_QUERY)
      const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
      const currentId = useCurrentSessionId()
      const livePending = useSessionPending(currentId)
      const pendingApproval = livePending && livePending.kind === 'approval' ? livePending : null
      // 客户端可见的 PendingApproval 是“审批是否还活着”的权威来源（见 runtime.livePending 注释）。
      runtime.livePending = pendingApproval
      const demo = state.demo !== null
      const dismissed = demo ? false : pendingApproval !== null && state.dismissedKey === pendingApproval.key

      // 会话切换：root 作用域的面板不能跨会话继续显示。
      React.useEffect(() => {
        if (!state.open) return
        if (state.demo !== null) return
        if (!currentId) {
          closePanel()
          return
        }
        if (state.sessionId && currentId !== state.sessionId) closePanel()
      }, [state.open, state.demo, state.sessionId, currentId])

      // 审批结束（pending 从状态里消失）→ 结束 banner，但面板不自动关闭。
      React.useEffect(() => {
        if (!state.open || state.demo !== null) return
        if (pendingApproval !== null) return
        if (resolvedHandled) return
        if (store.pending === null && store.context === null) return
        resolvedHandled = true
        emit({ resolved: true, outcome: store.outcome ?? store.pending?.outcome ?? null })
        after(400, () => {
          if (store.open) void loadContext({ silent: true })
        })
      }, [state.open, state.demo, pendingApproval, state.pending, state.context])

      // 轻提示自动消失。
      React.useEffect(() => {
        if (!state.notice) return undefined
        const timer = window.setTimeout(() => {
          if (store.notice?.id === state.notice.id) clearToast()
        }, NOTICE_MS)
        return () => window.clearTimeout(timer)
      }, [state.notice])

      const openNow = React.useCallback(
        (tab) => {
          openPanel(currentSession.get(), pendingApproval, tab)
        },
        [pendingApproval],
      )

      if (!state.open) {
        const visible = pendingApproval !== null || demo
        if (!visible || dismissed) return null
        return h(Pill, {
          t,
          demo,
          pending: pendingApproval,
          narrow,
          onOpen: () => openNow(store.tab === 'executor' ? 'executor' : 'reviewer'),
          onDismiss: () => {
            if (demo) {
              emit({ dismissedKey: null })
              return
            }
            emit({ dismissedKey: pendingApproval?.key ?? null })
          },
        })
      }

      return h(PanelRoot, {
        t,
        state,
        narrow,
        reduced,
        pendingApproval,
        resolveReason: props.resolveReason,
      })
    }

    /** 悬浮胶囊：root 层唯一入口（审批期间 composer 被官方卡片接管）。 */
    function Pill(props) {
      const { t, demo, pending, narrow, onOpen, onDismiss } = props
      const toolName = pending?.toolName ?? (demo ? 'pwsh' : '')
      return h(
        'div',
        {
          className: 'ac-pill-wrap',
          'data-approval-consult-dock': '',
          'data-approval-consult-pill': '',
          'data-narrow': narrow ? '' : undefined,
        },
        h(
          'button',
          {
            type: 'button',
            className: 'ac-pill',
            onClick: onOpen,
            'aria-label': t('pillAria'),
            title: t('pillAria'),
          },
          h('span', { className: 'ac-pill-pulse', 'aria-hidden': 'true' }),
          h('span', { className: 'ac-pill-icon', 'aria-hidden': 'true' }, '?'),
          h('span', { className: 'ac-pill-text' }, t('pillLabel')),
          toolName ? h('span', { className: 'ac-pill-tool' }, toolName) : null,
        ),
        demo ? h('span', { className: 'ac-pill-demo' }, t('demoBadge')) : null,
        h(
          'button',
          {
            type: 'button',
            className: 'ac-pill-dismiss',
            onClick: onDismiss,
            'aria-label': t('pillDismiss'),
            title: t('pillDismiss'),
          },
          '×',
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 组件：Turn 尾部的咨询记录入口（conversation.chat.turnTail）          */
    /* ------------------------------------------------------------------ */

    /**
     * 官方 Chat 隐藏了普通 context 行，用户自己也需要回看入口：
     * 在每轮对话尾部放一个低调 chip，点击打开只读历史面板。
     * 每个 Turn 都会挂载，所以只让「本会话最后一轮」显示，避免刷屏。
     */
    function HistoryChip(props) {
      const { t, sessionId, seq } = props
      const demoVariant = readDemoVariant()
      // 订阅 tail 版本，让“最新一轮”切换时旧 chip 自动隐藏。
      React.useSyncExternalStore(subscribeTail, () => tailState.version, () => 0)
      const [state, setState] = React.useState({ loading: true, error: null, items: [] })

      React.useEffect(() => {
        noteTurnTail(sessionId, seq)
      }, [sessionId, seq])

      React.useEffect(() => {
        let alive = true
        if (demoVariant !== null) {
          setState({ loading: false, error: null, items: demoHistoryItems() })
          return () => {
            alive = false
          }
        }
        if (!sessionId) {
          setState({ loading: false, error: null, items: [] })
          return () => {
            alive = false
          }
        }
        setState({ loading: true, error: null, items: [] })
        loadHistory(sessionId)
          .then((items) => {
            if (alive) setState({ loading: false, error: null, items })
          })
          .catch((error) => {
            if (alive) setState({ loading: false, error: describeError(error), items: [] })
          })
        return () => {
          alive = false
        }
      }, [sessionId, demoVariant])

      const latest = (() => {
        if (!sessionId || typeof seq !== 'number') return true
        const max = tailState.maxBySession.get(sessionId)
        return max === undefined || seq === max
      })()

      if (state.items.length === 0 || !latest) return null
      return h(
        'div',
        { className: 'ac-history-tail' },
        h(
          'button',
          {
            type: 'button',
            className: 'ac-history-chip',
            'data-approval-consult-history': '',
            'aria-label': t('historyChipAria'),
            title: t('historyChipAria'),
            onClick: () => openHistoryPanel(sessionId, state.items),
          },
          h('span', { className: 'ac-history-chip-icon', 'aria-hidden': 'true' }, '💬'),
          h('span', null, fmt(t('historyChip'), { count: state.items.length })),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 组件：面板骨架                                                      */
    /* ------------------------------------------------------------------ */

    function PanelRoot(props) {
      const { t, state, narrow, reduced, pendingApproval, resolveReason } = props
      const rootRef = React.useRef(null)
      const sheetRef = React.useRef(null)
      const inputRef = React.useRef(null)
      const returnFocusRef = React.useRef(null)
      const [now, setNow] = React.useState(() => Date.now())
      const viewport = useVisualViewport()
      const keyboardInset = narrow ? viewport.keyboard : 0
      const activeThreads = state.threads[state.tab] ?? []
      const streaming = activeThreads.some((turn) => turn.status === 'streaming')
      // 宿主未检测到官方自动审查插件：整个咨询台只保留执行 AI 通道。
      const reviewerEnabled = state.reviewerAvailable !== false
      React.useEffect(() => {
        if (reviewerEnabled) return
        if (store.tab === 'reviewer' || store.compare) emit({ tab: 'executor', compare: false })
      }, [reviewerEnabled, state.tab, state.compare])

      /* /context 回来后才决定要不要碰 approval-timeout：
         宿主报告 timeoutAvailable=false 时一次请求都不发（完全没有倒计时 UI）。 */
      const timeoutProbedRef = React.useRef(false)
      React.useEffect(() => {
        if (timeoutProbedRef.current) return
        if (state.demo !== null) return
        if (state.context === null && state.contextMissing !== true) return
        timeoutProbedRef.current = true
        if (store.timeoutAvailable === false) return
        void probeTimeout()
        void autoPauseOnOpen()
      }, [state.context, state.contextMissing, state.demo])
      /*
       * 面板升到浏览器 top layer（Popover API）。
       * 原因：shell.overlay 是 z-index:20 的普通层，环境里存在 z-index:2147483000
       * 的常驻装饰（余额桌宠），任何普通层级的右抽屉都会被它盖住底部按钮。
       * popover=manual 不进普通层叠上下文，且不会被 Esc/点击自动关闭，正好当模态用；
       * 不支持时自动退回普通 fixed 层。
       */
      React.useEffect(() => {
        const element = rootRef.current
        if (!element || typeof element.showPopover !== 'function') return undefined
        let shown = false
        try {
          element.showPopover()
          shown = true
        } catch {
          shown = false
        }
        return () => {
          if (!shown) return
          try {
            element.hidePopover()
          } catch {
            /* ignore */
          }
        }
      }, [])

      /* 打开时：记住触发元素、聚焦输入框（桌面）/面板（手机）。 */
      React.useEffect(() => {
        returnFocusRef.current = document.activeElement
        const historyView = store.mode === 'history'
        const timer = window.setTimeout(() => {
          if (narrow || historyView) {
            try {
              sheetRef.current?.focus({ preventScroll: true })
            } catch {
              /* ignore */
            }
            return
          }
          try {
            inputRef.current?.focus({ preventScroll: true })
          } catch {
            /* ignore */
          }
        }, 60)
        return () => window.clearTimeout(timer)
        // 只在打开时跑一次：后续 tab/宽度变化不抢焦点。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      /* 关闭时把焦点还给触发元素。 */
      React.useEffect(() => {
        return () => {
          const target = returnFocusRef.current
          if (target && typeof target.focus === 'function' && document.contains(target)) {
            try {
              target.focus({ preventScroll: true })
            } catch {
              /* ignore */
            }
          }
        }
      }, [])

      /* 上下文静默刷新。 */
      React.useEffect(() => {
        if (state.demo !== null) return undefined
        const timer = window.setInterval(() => {
          if (store.open) void loadContext({ silent: true })
        }, CONTEXT_REFRESH_MS)
        return () => window.clearInterval(timer)
      }, [state.demo])

      /* 倒计时：只在存在未取消的倒计时时跑。 */
      const countdownActive = state.timeout !== null && state.timeout.cancelled !== true
      React.useEffect(() => {
        if (!countdownActive) return undefined
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        const probe = window.setInterval(() => {
          if (store.open) void probeTimeout()
        }, 2500)
        return () => {
          window.clearInterval(timer)
          window.clearInterval(probe)
        }
      }, [countdownActive])

      /* 焦圈：Tab 在面板内循环（轻量焦点陷阱，避免焦点跑到被遮住的页面里）。 */
      const onKeyDown = (event) => {
        if (event.defaultPrevented) return
        const target = event.target
        const native = event.nativeEvent
        const composing = event.isComposing || native?.isComposing || event.keyCode === 229
        if (event.key === 'Escape' && !composing) {
          // 输入框内的 Esc 不清空、不关面板：契约要求不抢官方审批的 Esc 语义。
          const inInput = target instanceof Element && target.closest('textarea, input, [contenteditable="true"], [contenteditable=""]')
          if (inInput) {
            event.stopPropagation()
            return
          }
          event.preventDefault()
          event.stopPropagation()
          closePanel()
          return
        }
        if (event.key === 'Tab') {
          const sheet = sheetRef.current
          if (!sheet) return
          const focusables = [...sheet.querySelectorAll('button:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter(
            (element) => element.offsetParent !== null || element === document.activeElement,
          )
          if (focusables.length === 0) return
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          }
        }
      }

      const remainingSeconds = (() => {
        const timeout = state.timeout
        if (!timeout || timeout.cancelled || !timeout.timeoutMs) return null
        const elapsed = (timeout.elapsedMs ?? 0) + Math.max(0, now - (timeout.probedAt ?? now))
        return Math.max(0, Math.round((timeout.timeoutMs - elapsed) / 1000))
      })()

      const sideAvailable = {
        executor: isSideAvailable('executor'),
        reviewer: isSideAvailable('reviewer'),
      }
      // 审查上下文用 /review 的结论覆盖（advisory 路径），并判断是否还需要兜底评估。
      const viewContext = state.context === null ? null : { ...state.context, reviewer: effectiveReviewer(state.context) }
      const viewReviewer = viewContext?.reviewer ?? null
      const needsReview = reviewerNeedsReview(viewReviewer)
      const compareAvailable = sideAvailable.executor && sideAvailable.reviewer
      const activeAvailable = sideAvailable[state.tab] !== false
      const ended = state.resolved || (state.pending === null && state.contextMissing !== true)
      const showEnded = state.resolved
      const historyMode = state.mode === 'history'
      const presetsMode = state.mode === 'presets'
      // demo 模式完全用 mock 数据，避免和页面上真实到达的审批串味。
      const reasonText =
        state.demo !== null ? readDisplayReason(state.pending) : resolveTextOf(resolveReason, pendingApproval) ?? readDisplayReason(state.pending)
      const countdownChip =
        remainingSeconds !== null && remainingSeconds > 0 && !showEnded
          ? h(
              'button',
              {
                type: 'button',
                className: `ac-chip ac-chip-countdown${remainingSeconds <= 15 ? ' ac-chip-danger' : ''}`,
                onClick: () => void pauseTimeout(undefined, { force: true }),
                'aria-label': fmt(t('ariaCountdown'), { seconds: remainingSeconds }),
                title: t('timeoutPauseHint'),
              },
              h('span', { className: 'ac-chip-dot', 'aria-hidden': 'true' }),
              fmt(t('timeoutChip'), { seconds: remainingSeconds }),
            )
          : null

      const showTimeoutBanner =
        !presetsMode &&
        !showEnded &&
        state.timeoutBannerDismissed !== true &&
        state.timeout !== null &&
        state.timeout.cancelled !== true &&
        remainingSeconds !== null &&
        remainingSeconds > 0
      const countdownChipForHeader = showTimeoutBanner ? null : countdownChip

      const otherName = state.tab === 'executor' ? t('tabReviewer') : t('tabExecutor')
      // 手机键盘弹起：把弹层高度压到可见区域并整体上移，保证输入框不被遮住。
      /* 手机底部弹层：拖动顶部把手下滑关闭（没有它，把手只是个装饰）。 */
      const dragRef = React.useRef({ active: false, startY: 0, dy: 0 })
      const [dragDy, setDragDy] = React.useState(0)
      const onGrabStart = (event) => {
        if (!narrow) return
        dragRef.current = { active: true, startY: event.clientY, dy: 0 }
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* ignore */
        }
      }
      const onGrabMove = (event) => {
        const drag = dragRef.current
        if (!drag.active) return
        // 只允许下滑；上滑不移动，避免和滚动冲突。
        const dy = Math.max(0, event.clientY - drag.startY)
        drag.dy = dy
        setDragDy(dy)
      }
      const onGrabEnd = () => {
        const drag = dragRef.current
        if (!drag.active) return
        drag.active = false
        setDragDy(0)
        if (drag.dy > 96) closePanel()
      }

      const sheetStyle =
        keyboardInset > 0
          ? {
              height: `${Math.min(Math.round(window.innerHeight * 0.88), Math.max(220, Math.round(viewport.height)))}px`,
              marginBottom: `${keyboardInset}px`,
            }
          : undefined

      return h(
        'div',
        {
          className: `ac-root${narrow ? ' ac-root-narrow' : ''}${reduced ? ' ac-reduced' : ''}`,
          'data-approval-consult-panel': '',
          ref: rootRef,
          popover: 'manual',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': presetsMode ? t('presetsEditorTitle') : historyMode ? t('historyTitle') : t('ariaPanel'),
          'aria-busy': streaming ? 'true' : 'false',
        },
        h('div', {
          className: 'ac-backdrop',
          'aria-hidden': 'true',
          onClick: () => closePanel(),
        }),
        h(
          'div',
          {
            className: 'ac-sheet',
            ref: sheetRef,
            tabIndex: -1,
            style:
              dragDy > 0
                ? { ...(sheetStyle ?? {}), transform: `translateY(${dragDy}px)`, transition: 'none' }
                : sheetStyle,
            onKeyDown,
          },
          narrow
            ? h(
                'div',
                {
                  className: 'ac-grabber',
                  'aria-hidden': 'true',
                  onPointerDown: onGrabStart,
                  onPointerMove: onGrabMove,
                  onPointerUp: onGrabEnd,
                  onPointerCancel: onGrabEnd,
                },
                h('span'),
              )
            : null,
          h(Header, {
            t,
            state,
            narrow,
            countdownChip: countdownChipForHeader,
            showEnded,
            history: historyMode,
            presets: presetsMode,
            onClose: () => closePanel(),
          }),
          showTimeoutBanner
            ? h(
                'div',
                { className: 'ac-timeout-banner', role: 'status', 'data-approval-consult-timeout-banner': '' },
                h('span', { className: 'ac-timeout-banner-text' }, fmt(t('timeoutBanner'), { seconds: remainingSeconds })),
                h(
                  'button',
                  { type: 'button', className: 'ac-timeout-banner-pause', onClick: () => void pauseTimeout(undefined, { force: true }) },
                  t('timeoutPauseAction'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ac-icon-btn ac-timeout-banner-close',
                    'aria-label': t('timeoutBannerDismiss'),
                    title: t('timeoutBannerDismiss'),
                    onClick: () => emit({ timeoutBannerDismissed: true }),
                  },
                  h('span', { 'aria-hidden': 'true' }, '×'),
                ),
              )
            : null,
          presetsMode
            ? h(PresetsEditor, { t, state, narrow, reviewerEnabled })
            : historyMode
              ? h(HistoryBody, { t, state, narrow })
              : h(
                React.Fragment,
                null,
                showEnded ? h(EndedBanner, { t, state, pendingApproval }) : null,
                !showEnded && historyMode === false && state.contextMissing === true
                  ? h(
                      'div',
                      { className: 'ac-banner ac-syncing', 'data-approval-consult-syncing': '', role: 'status' },
                      h('div', { className: 'ac-banner-title' }, t('contextSyncing')),
                      h('div', { className: 'ac-banner-hint' }, t('contextSyncingHint')),
                      h(
                        'button',
                        { type: 'button', className: 'ac-link-btn', onClick: () => retryContext() },
                        t('contextRetry'),
                      ),
                    )
                  : null,
                h(Tabs, {
                  t,
                  state,
                  sideAvailable,
                  compareAvailable,
                  reviewerEnabled,
                }),
                state.compareReady && state.compareReady.target !== state.tab
                  ? h(CompareReady, {
                      t,
                      state,
                      otherName,
                      onJump: () => emit({ tab: state.compareReady.target, compareReady: null }),
                    })
                  : null,
                h(ContextCard, {
                  t,
                  state,
                  narrow,
                  sideAvailable,
                  reasonText,
                  context: viewContext,
                  reviewer: viewReviewer,
                }),
                h(Thread, {
                  t,
                  state,
                  narrow,
                  activeThreads,
                  activeAvailable,
                  keyboard: keyboardInset,
                  context: viewContext,
                  needsReview,
                  reviewBusy: state.reviewBusy === true,
                  reviewError: state.reviewError,
                  onReview: () => void requestAdvisoryReview(),
                  onRetry: retryThread,
                  onStop: stopThread,
                  onRelay: relayThread,
                }),
                h(
                  'div',
                  { className: 'ac-bottom' },
                  ended
                    ? null
                    : h(Presets, {
                        t,
                        state,
                        disabled: !activeAvailable || ended,
                        compact: activeThreads.length > 0,
                        onEdit: state.demo === null ? () => emit({ mode: 'presets' }) : undefined,
                      }),
                  h(Composer, {
                    t,
                    state,
                    narrow,
                    inputRef,
                    streaming,
                    disabled: !activeAvailable || ended,
                    disabledHint: ended
                      ? t('inputDisabledEnded')
                      : state.tab === 'reviewer' && needsReview
                        ? t('reviewerNeedsReviewPlaceholder')
                        : null,
                    onSend: () => (state.compare && compareAvailable ? void sendCompare() : void sendQuestion(state.tab)),
                    onStop: () => {
                      const running = (store.threads[store.tab] ?? []).find((turn) => turn.status === 'streaming')
                      if (running) void stopThread(store.tab, running.id)
                    },
                  }),
                  h(DecisionBar, { t, state, pendingApproval }),
                ),
              ),
          !historyMode && state.notice ? h(Toast, { t, notice: state.notice }) : null,
          h(
            'div',
            { className: 'ac-sr-only', role: 'status', 'aria-live': 'polite' },
            streaming ? t('notifyStreaming') : state.live === 'error' ? t('notifyError') : state.live === 'done' ? t('notifyDone') : '',
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 组件：只读历史面板                                                  */
    /* ------------------------------------------------------------------ */

    function HistoryBody(props) {
      const { t, state } = props
      const history = state.history ?? { items: [], loading: false, error: null }
      const items = Array.isArray(history.items) ? history.items : []
      return h(
        'div',
        { className: 'ac-thread ac-history', 'data-approval-consult-history-panel': '', role: 'region', 'aria-label': t('historyTitle') },
        history.loading ? h(ThreadSkeleton, { t }) : null,
        history.error ? h(ContextError, { t, error: history.error, onRetry: () => void reloadHistory() }) : null,
        items.length === 0 && !history.loading && !history.error
          ? h(
              'div',
              { className: 'ac-state' },
              h('div', { className: 'ac-state-icon ac-state-icon-quiet', 'aria-hidden': 'true' }, '…'),
              h('div', { className: 'ac-state-title' }, t('historyEmpty')),
            )
          : null,
        ...items.map((item) => h(HistoryItem, { key: item.consultKey || String(item.startedAt), t, item })),
      )
    }

    /** 一条已结束审批的回看卡片。 */
    function HistoryItem(props) {
      const { t, item } = props
      const outcomeKey = OUTCOME_KEYS[item.outcome] ?? (item.resolved ? 'outcomeUnknown' : 'outcomeCancelled')
      const tone = item.outcome === 'rejected' ? 'error' : item.outcome === 'allowed-once' ? 'success' : 'neutral'
      const riskKey = item.risk ? `risk${item.risk[0].toUpperCase()}${item.risk.slice(1)}` : null
      const sections = []
      for (const target of ['executor', 'reviewer']) {
        const list = item.threads?.[target] ?? []
        if (list.length === 0) continue
        sections.push(
          h(
            'section',
            { key: target, className: 'ac-history-thread' },
            h(
              'div',
              { className: 'ac-history-thread-head' },
              h('span', { className: 'ac-history-thread-title' }, target === 'executor' ? t('tabExecutor') : t('tabReviewer')),
              h('span', { className: 'ac-meta' }, fmt(t('historyTurns'), { count: list.length })),
            ),
            ...list.map((turn) => h(HistoryTurn, { key: turn.id, t, turn })),
          ),
        )
      }
      return h(
        'article',
        { className: 'ac-history-card' },
        h(
          'div',
          { className: 'ac-history-card-head' },
          h('code', { className: 'ac-tool' }, item.toolName || '—'),
          h('span', { className: `ac-outcome-badge ac-outcome-${tone}` }, t(outcomeKey)),
          item.risk && riskKey ? h('span', { className: `ac-risk ac-risk-${item.risk}` }, t(riskKey)) : null,
          h('span', { className: 'ac-meta ac-history-time' }, formatDateTime(item.startedAt)),
        ),
        item.reason ? h('div', { className: 'ac-history-reason' }, h(Markdown, { text: item.reason, t })) : null,
        h(
          'div',
          { className: 'ac-history-counts' },
          h('span', { className: 'ac-meta' }, fmt(t('historyCount'), { count: (item.counts?.executor ?? 0) + (item.counts?.reviewer ?? 0) })),
          item.relays > 0 ? h('span', { className: 'ac-meta' }, fmt(t('historyRelayCount'), { count: item.relays })) : null,
          item.reviewSource === 'advisory' ? h('span', { className: 'ac-tag ac-tag-info' }, t('reviewOverrideBadge')) : null,
          item.reviewSource === 'approval-reason' ? h('span', { className: 'ac-tag ac-tag-info' }, t('reviewSyntheticBadge')) : null,
          item.resolved && item.reviewSource === 'none' ? h('span', { className: 'ac-meta' }, t('historyNoReview')) : null,
        ),
        ...sections,
      )
    }

    /** 历史里的一条问答（只读）。 */
    function HistoryTurn(props) {
      const { t, turn } = props
      const answer = String(turn.answer ?? '')
      return h(
        'div',
        { className: 'ac-history-turn' },
        h(
          'div',
          { className: 'ac-turn-q' },
          h('div', { className: 'ac-bubble-q' }, turn.question),
          h('div', { className: 'ac-turn-time' }, formatClock(turn.at)),
        ),
        h(
          'div',
          { className: 'ac-turn-a' },
          answer.length > 0
            ? h('div', { className: 'ac-bubble-a' }, h(Markdown, { text: answer, t }))
            : h('div', { className: 'ac-bubble-a ac-bubble-cancelled' }, t('historyThreadEmpty')),
          h(
            'div',
            { className: 'ac-turn-meta' },
            turn.usage ? h('span', { className: 'ac-meta' }, formatUsage(t, turn.usage)) : null,
            turn.injectedAt ? h('span', { className: 'ac-tag ac-tag-ok', title: t('savedTooltip') }, t('savedToSession')) : null,
            turn.truncated ? h('span', { className: 'ac-tag ac-tag-warn', title: t('truncatedHint') }, t('truncated')) : null,
            turn.relayedAt ? h('span', { className: 'ac-tag ac-tag-ok' }, t('relayed')) : null,
            turn.status === 'error' ? h('span', { className: 'ac-tag ac-tag-warn' }, t('notifyError')) : null,
            turn.status === 'cancelled' ? h('span', { className: 'ac-chip-static' }, t('turnCancelled')) : null,
          ),
        ),
      )
    }

    /** 解析 displayReason：优先宿主 locale 服务，其次按当前语言兜底。 */
    function resolveTextOf(resolveReason, pending) {
      const display = pending?.displayReason
      if (display === null || display === undefined) return null
      try {
        if (typeof resolveReason === 'function') {
          const text = resolveReason(display)
          if (typeof text === 'string' && text.trim().length > 0) return text.trim()
        }
      } catch {
        /* ignore */
      }
      if (typeof display === 'string') return display
      const lang = (() => {
        try {
          return document.documentElement.lang || navigator.language || 'zh'
        } catch {
          return 'zh'
        }
      })()
      const preferZh = String(lang).toLowerCase().startsWith('zh')
      return display.zh ?? display.en ?? null
    }

    function readDisplayReason(pending) {
      if (!pending) return null
      const display = pending.displayReason
      if (typeof display === 'string') return display
      if (display && typeof display === 'object') return display.zh ?? display.en ?? pending.reason ?? null
      return pending.reason ?? null
    }

    /* ------------------------------------------------------------------ */
    /* 轻量 Markdown（模型输出不可信：全部 React 元素，绝不 innerHTML）      */
    /* ------------------------------------------------------------------ */

    /** 行内标记：反引号代码、**粗体**、*斜体*、[文字](链接) 降级为文字。 */
    const INLINE_PATTERN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]*\]\([^)\n]*\))/g

    function renderInline(text, keyPrefix) {
      const nodes = []
      const source = String(text ?? '')
      let last = 0
      let index = 0
      INLINE_PATTERN.lastIndex = 0
      let match = INLINE_PATTERN.exec(source)
      while (match !== null) {
        if (match.index > last) nodes.push(source.slice(last, match.index))
        const token = match[0]
        const key = `${keyPrefix}-i${index}`
        index += 1
        if (token.startsWith('`')) {
          nodes.push(h('code', { key }, token.slice(1, -1)))
        } else if (token.startsWith('**')) {
          nodes.push(h('strong', { key }, token.slice(2, -2)))
        } else if (token.startsWith('[')) {
          const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(token)
          // 外链不自动打开：只保留链接文字，避免把不可信 URL 变成可点击目标。
          nodes.push(link ? link[1] : token)
        } else {
          nodes.push(h('em', { key }, token.slice(1, -1)))
        }
        last = match.index + token.length
        match = INLINE_PATTERN.exec(source)
      }
      if (last < source.length) nodes.push(source.slice(last))
      return nodes
    }

    /** 围栏代码块：等宽、横向滚动、可复制。 */
    function CodeBlock(props) {
      const { code, lang, t } = props
      const [copied, setCopied] = React.useState(false)
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(code)
          setCopied(true)
          after(1400, () => setCopied(false))
        } catch {
          /* 剪贴板不可用时保持静默 */
        }
      }
      return h(
        'div',
        { className: 'ac-md-code' },
        h(
          'div',
          { className: 'ac-md-code-bar' },
          h('span', null, lang || 'code'),
          h('button', { type: 'button', className: 'ac-md-code-copy', onClick: () => void copy() }, copied ? t('argsCopied') : t('argsCopy')),
        ),
        h('pre', null, h('code', null, code)),
      )
    }

    /** 把纯文本切成块级元素（标题降级为粗体段落）。 */
    function parseMarkdown(text, t) {
      const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let index = 0
      let key = 0

      const push = (node) => {
        blocks.push(node)
      }

      while (index < lines.length) {
        const line = lines[index]
        // 围栏代码块（未闭合时把剩余内容都当代码，流式输出中途也不会崩）。
        if (/^\s*```/.test(line)) {
          const lang = (line.match(/^\s*```([\w+-]*)/) ?? [])[1] ?? ''
          index += 1
          const code = []
          while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
            code.push(lines[index])
            index += 1
          }
          if (index < lines.length) index += 1
          push(h(CodeBlock, { key: `b${key}`, code: code.join('\n'), lang, t }))
          key += 1
          continue
        }
        if (line.trim() === '') {
          index += 1
          continue
        }
        // 标题：降级为粗体段落（回答里最多到 ####）。
        const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
        if (heading) {
          push(h('p', { key: `b${key}`, className: 'ac-md-h' }, h('strong', null, ...renderInline(heading[1], `h${key}`))))
          key += 1
          index += 1
          continue
        }
        // 引用
        if (/^\s*>\s?/.test(line)) {
          const quoted = []
          while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
            quoted.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          push(h('blockquote', { key: `b${key}` }, h('p', null, ...renderInline(quoted.join('\n'), `q${key}`))))
          key += 1
          continue
        }
        // 列表（有序/无序），支持简单的续行。
        const bulletMatch = /^\s*[-*+]\s+(.*)$/.exec(line)
        const orderedMatch = /^\s*\d+[.)]\s+(.*)$/.exec(line)
        if (bulletMatch || orderedMatch) {
          const ordered = Boolean(orderedMatch)
          const matcher = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/
          const items = []
          while (index < lines.length) {
            const current = lines[index]
            const item = matcher.exec(current)
            if (item) {
              items.push(h('li', { key: `li${key}` }, ...renderInline(item[1], `li${key}`)))
              key += 1
              index += 1
              continue
            }
            // 缩进续行并入上一条。
            if (items.length > 0 && /^\s{2,}\S/.test(current)) {
              const extra = renderInline(current.trim(), `li${key}`)
              items[items.length - 1] = h('li', { key: items[items.length - 1].key }, items[items.length - 1].props.children, h('br'), ...extra)
              index += 1
              continue
            }
            break
          }
          push(h(ordered ? 'ol' : 'ul', { key: `b${key}` }, ...items))
          key += 1
          continue
        }
        // 段落：连续普通行合并为一段（换行交给 white-space:pre-wrap）。
        const paragraph = [line]
        index += 1
        while (index < lines.length) {
          const next = lines[index]
          if (next.trim() === '') break
          if (/^\s*```/.test(next) || /^\s{0,3}#{1,6}\s/.test(next) || /^\s*[-*+]\s+/.test(next) || /^\s*\d+[.)]\s+/.test(next) || /^\s*>\s?/.test(next)) break
          paragraph.push(next)
          index += 1
        }
        push(h('p', { key: `b${key}` }, ...renderInline(paragraph.join('\n'), `p${key}`)))
        key += 1
      }
      return blocks
    }

    /** 回答正文渲染器（执行/审查/重新评估共用）。 */
    function Markdown(props) {
      const { text, t } = props
      const blocks = React.useMemo(() => parseMarkdown(String(text ?? ''), t), [text, t])
      return h('div', { className: 'ac-md' }, ...blocks)
    }

    /* ------------------------------------------------------------------ */
    /* 组件：头部 / banner / tabs                                          */
    /* ------------------------------------------------------------------ */

    function Header(props) {
      const { t, state, narrow, countdownChip, showEnded, history, presets, onClose } = props
      const toolName = history || presets ? '' : state.toolName ?? ''
      const endedLook = showEnded || history || presets
      return h(
        'header',
        { className: 'ac-head' },
        h(
          'div',
          { className: 'ac-head-main' },
          h(
            'div',
            { className: 'ac-head-line' },
            h(
              'span',
              { className: `ac-status${endedLook ? ' ac-status-ended' : ''}` },
              h('span', { className: 'ac-status-dot', 'aria-hidden': 'true' }),
              presets ? t('presetsEditorTitle') : history ? t('historyReadonly') : showEnded ? t('statusEnded') : t('statusWaiting'),
            ),
            toolName ? h('code', { className: 'ac-tool' }, toolName) : null,
            state.demo !== null ? h('span', { className: 'ac-badge' }, t('demoBadge')) : null,
          ),
          h('h2', { className: 'ac-title' }, presets ? t('presetsEditorTitle') : history ? t('historyTitle') : t('title')),
          h('div', { className: 'ac-sub' }, presets ? t('presetsEditorHint') : history ? t('historyReadonlyHint') : t('subtitle')),
        ),
        h(
          'div',
          { className: 'ac-head-actions' },
          narrow ? null : countdownChip,
          h(
            'button',
            {
              type: 'button',
              className: 'ac-icon-btn',
              onClick: onClose,
              'aria-label': t('close'),
              title: t('closeHint'),
            },
            h('span', { 'aria-hidden': 'true' }, '✕'),
          ),
        ),
        narrow && countdownChip ? h('div', { className: 'ac-head-countdown' }, countdownChip) : null,
      )
    }

    function EndedBanner(props) {
      const { t, state } = props
      const outcome = normalizeOutcome(state.outcome ?? state.pending?.outcome ?? null)
      const endedError = state.pending?.error ?? null
      // 超时自动拒绝时 outcome 是空的：从错误信息里识别，避免用户误以为是自己拒绝了。
      const timedOut = outcome === null && typeof endedError === 'string' && /timed out|超时/i.test(endedError)
      const outcomeKey = OUTCOME_KEYS[outcome] ?? (timedOut ? 'outcomeTimeout' : null)
      const tone = outcome === 'rejected' ? 'error' : outcome === 'allowed-once' ? 'success' : 'info'
      return h(
        'div',
        { className: `ac-banner ac-banner-${tone}`, role: 'status' },
        h(
          'div',
          { className: 'ac-banner-main' },
          h('span', { className: 'ac-banner-title' }, t('endedTitle')),
          outcomeKey ? h('span', { className: `ac-banner-outcome ac-banner-outcome-${tone}` }, t(outcomeKey)) : null,
        ),
        h('div', { className: 'ac-banner-hint' }, t('endedHint')),
      )
    }

    function Tabs(props) {
      const { t, state, sideAvailable, compareAvailable, reviewerEnabled } = props
      const reviewEnabled = reviewerEnabled !== false
      // 审批结束后整块只读，不要再把“不可用”当作操作提示。
      const ended = state.resolved || (state.pending === null && state.contextMissing !== true)
      const tabs = [
        { id: 'executor', label: t('tabExecutor'), available: sideAvailable.executor },
        ...(reviewEnabled ? [{ id: 'reviewer', label: t('tabReviewer'), available: sideAvailable.reviewer }] : []),
      ]
      return h(
        'div',
        { className: 'ac-tabs', role: 'tablist', 'aria-label': t('ariaTabs') },
        ...tabs.map((tab) => {
          const warn = tab.available === false && !ended
          return h(
            'button',
            {
              key: tab.id,
              type: 'button',
              role: 'tab',
              id: `ac-tab-${tab.id}`,
              'aria-selected': state.tab === tab.id ? 'true' : 'false',
              'aria-controls': `ac-tabpanel-${tab.id}`,
              tabIndex: state.tab === tab.id ? 0 : -1,
              className: `ac-tab${state.tab === tab.id ? ' ac-tab-active' : ''}${warn ? ' ac-tab-warn' : ''}`,
              onClick: () => emit({ tab: tab.id, compareReady: null }),
            },
            h('span', { className: 'ac-tab-label' }, tab.label),
            warn ? h('span', { className: 'ac-tab-note', 'aria-label': t('badgeUnavailable') }, '!') : null,
          )
        }),
        reviewEnabled
          ? h(
              'button',
              {
                type: 'button',
                className: `ac-compare${state.compare ? ' ac-compare-on' : ''}`,
                onClick: () => (compareAvailable ? emit({ compare: !state.compare }) : toast('tabCompareUnavailable')),
                'aria-pressed': state.compare ? 'true' : 'false',
                'aria-disabled': compareAvailable ? 'false' : 'true',
                title: compareAvailable ? t('tabCompareHint') : t('tabCompareUnavailable'),
              },
              h('span', { className: 'ac-compare-icon', 'aria-hidden': 'true' }, state.compare ? '◉' : '◎'),
              h('span', null, t('tabCompare')),
            )
          : null,
      )
    }

    function CompareReady(props) {
      const { t, otherName, onJump } = props
      return h(
        'div',
        { className: 'ac-compare-ready' },
        h('span', { className: 'ac-compare-ready-text' }, fmt(t('compareReady'), { target: otherName })),
        h('button', { type: 'button', className: 'ac-link-btn', onClick: onJump }, t('compareReadyAction')),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 组件：上下文卡片                                                    */
    /* ------------------------------------------------------------------ */

    function ContextCard(props) {
      const { t, state, narrow, sideAvailable, reasonText, context, reviewer: reviewerProp } = props
      // 手机 / 矮窗口默认收起上下文卡片，把高度让给问答线程；高窗口默认展开。
      const [open, setOpen] = React.useState(!narrow && typeof window !== 'undefined' && window.innerHeight >= 1100)
      const [expandedReason, setExpandedReason] = React.useState(false)
      const [openNote, setOpenNote] = React.useState(false)
      const [showArgs, setShowArgs] = React.useState(false)
      const [copied, setCopied] = React.useState(false)

      if (!context && state.demo === null) {
        return state.loadingContext
          ? h('div', { className: 'ac-context ac-context-skeleton', 'data-approval-consult-context': '', 'aria-hidden': 'true' },
              h('span', { className: 'ac-skeleton ac-skeleton-line' }),
              h('span', { className: 'ac-skeleton ac-skeleton-line ac-skeleton-short' }),
            )
          : null
      }

      const reviewer = reviewerProp ?? context?.reviewer ?? null
      const executor = context?.executor ?? null
      const risk = reviewer?.risk ?? null
      const verdict = reviewer?.decision ?? null
      const historyCount = Number(reviewer?.historyCount) || 0
      const args = typeof executor?.argumentsPreview === 'string' ? executor.argumentsPreview : ''
      const reviewerMissing = reviewer !== null && reviewer !== undefined && reviewer.available === false
      const reviewerNeeds = reviewerNeedsReview(reviewer)
      const executorMissing = executor !== null && executor !== undefined && executor.available === false
      const reviewerTab = state.tab === 'reviewer'
      const ended = state.resolved || (state.pending === null && state.contextMissing !== true)
      // 兜底评估只属于「审查 tab + 审批还没结束」：结束后只留只读信息。
      const advisoryActive = reviewerTab && reviewerNeeds && !ended
      // 优先展示「审查结论的理由」（含 /review 兜底评估结果），没有再退回审批请求自带的说明。
      const reason = reviewerNeeds ? null : (reviewer?.reason ?? reasonText ?? null)
      const pendingError = state.pending?.error ?? null

      const copyArgs = async () => {
        try {
          await navigator.clipboard.writeText(args)
          setCopied(true)
          toast('toastCopied')
          after(1400, () => setCopied(false))
        } catch {
          toast('copyFail', null, 'error')
        }
      }

      return h(
        'section',
        {
          className: `ac-context${open ? ' ac-context-open' : ''}`,
          'data-approval-consult-context': '',
          'aria-label': t('contextTitle'),
        },
        h(
          'div',
          { className: 'ac-context-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'ac-context-toggle',
              onClick: () => setOpen((value) => !value),
              'aria-expanded': open ? 'true' : 'false',
            },
            h('span', { className: 'ac-chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
            h('span', { className: 'ac-context-title' }, t('contextTitle')),
          ),
          h(
            'div',
            { className: 'ac-context-badges' },
            risk ? h('span', { className: `ac-risk ac-risk-${risk}`, 'aria-label': t('ariaRisk') }, t(`risk${risk[0].toUpperCase()}${risk.slice(1)}`)) : null,
            verdict ? h('span', { className: `ac-verdict ac-verdict-${verdict}` }, t(verdict === 'allow' ? 'verdictAllow' : 'verdictDeny')) : null,
            store.reviewerOverride !== null ? h('span', { className: 'ac-tag ac-tag-info' }, t('reviewOverrideBadge')) : null,
            reviewer?.synthetic === true ? h('span', { className: 'ac-tag ac-tag-info' }, t('reviewSyntheticBadge')) : null,
            historyCount > 0 ? h('span', { className: 'ac-meta' }, fmt(t('evidenceCount'), { count: historyCount })) : null,
          ),
        ),
        open
          ? h(
              'div',
              { className: 'ac-context-body' },
              // 审查相关说明只在审查 tab 出现；执行 tab 不显示审查不可用/待评估文案。
              reviewerTab && reviewerMissing
                ? h('p', { className: 'ac-note ac-note-warn' }, reviewer?.hint ?? t('reviewUnavailable'))
                : null,
              reviewerTab && !reviewerMissing && !reviewerNeeds && reviewer?.failed === true
                ? h('p', { className: 'ac-note ac-note-warn' }, fmt(t('reviewFailedHint'), { detail: reviewer?.error ?? '—' }))
                : null,
              pendingError ? h('p', { className: 'ac-note ac-note-warn' }, fmt(t('pendingErrorNote'), { error: pendingError })) : null,
              !reviewerMissing && !reviewerNeeds && reason
                ? h(
                    'div',
                    { className: 'ac-reason-block' },
                    h('span', { className: 'ac-note-label' }, t('reasonLabel')),
                    h(
                      'div',
                      { className: `ac-reason${expandedReason ? ' ac-reason-open' : ''}` },
                      h(Markdown, { text: reason, t }),
                    ),
                    reason.length > 90
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'ac-link-btn ac-reason-toggle',
                            onClick: () => setExpandedReason((value) => !value),
                          },
                          expandedReason ? t('reasonCollapse') : t('reasonExpand'),
                        )
                      : null,
                  )
                : null,
              state.tab === 'executor' && executorMissing ? h('p', { className: 'ac-note ac-note-warn' }, t('executorUnavailable')) : null,
              executorMissing ? null : executor?.assistantNote
                ? h(
                    'div',
                    { className: 'ac-note-block' },
                    h('span', { className: 'ac-note-label' }, t('executorNote')),
                    h(
                      'span',
                      { className: `ac-note-text${openNote ? ' ac-note-text-open' : ''}` },
                      executor.assistantNote,
                    ),
                    executor.assistantNote.length > 120
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'ac-link-btn ac-note-toggle',
                            onClick: () => setOpenNote((value) => !value),
                            'aria-expanded': openNote ? 'true' : 'false',
                          },
                          openNote ? t('reasonCollapse') : t('reasonExpand'),
                        )
                      : null,
                  )
                : null,
              h(
                'div',
                { className: 'ac-args-head' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ac-args-toggle',
                    onClick: () => setShowArgs((value) => !value),
                    'aria-expanded': showArgs ? 'true' : 'false',
                  },
                  h('span', { className: 'ac-chevron', 'aria-hidden': 'true' }, showArgs ? '▾' : '▸'),
                  t('toolArgs'),
                ),
                args
                  ? h('button', { type: 'button', className: 'ac-link-btn', onClick: () => void copyArgs() }, copied ? t('argsCopied') : t('argsCopy'))
                  : null,
              ),
              showArgs
                ? args
                  ? h('pre', { className: 'ac-args' }, args)
                  : h('p', { className: 'ac-meta' }, t('argsEmpty'))
                : null,
              h(
                'div',
                { className: 'ac-context-foot' },
                reviewer?.provider || reviewer?.model
                  ? h('span', { className: 'ac-meta' }, fmt(t('reviewMeta'), { provider: reviewer.provider ?? '—', model: reviewer.model ?? '—' }))
                  : null,
                executor?.available && (executor.messageCount || executor.toolCount)
                  ? h('span', { className: 'ac-meta' }, fmt(t('executorMeta'), { messages: executor.messageCount ?? 0, tools: executor.toolCount ?? 0 }))
                  : null,
                state.consultKey ? h('span', { className: 'ac-meta ac-meta-code' }, state.consultKey) : null,
              ),
              reviewerTab && sideAvailable.reviewer === false && !reviewerMissing
                ? h('p', { className: 'ac-note' }, t('reviewUnavailable'))
                : null,
            )
          : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* 组件：线程                                                          */
    /* ------------------------------------------------------------------ */

    function Thread(props) {
      const { t, state, narrow, activeThreads, activeAvailable, keyboard, context, needsReview, reviewBusy, reviewError, onReview, onRetry, onStop, onRelay } = props
      const scrollerRef = React.useRef(null)
      const stickRef = React.useRef(true)
      const [awayFromBottom, setAwayFromBottom] = React.useState(false)
      const lastLength = activeThreads.reduce((total, turn) => total + (turn.answer?.length ?? 0), 0)
      const streaming = activeThreads.some((turn) => turn.status === 'streaming')

      const distanceToBottom = (element) => element.scrollHeight - element.scrollTop - element.clientHeight

      const onScroll = () => {
        const element = scrollerRef.current
        if (!element) return
        const away = distanceToBottom(element) > 48
        stickRef.current = !away
        setAwayFromBottom(away)
      }

      // 流式输出时：用户在底部就自动跟随，向上滚动过就不打扰。
      React.useLayoutEffect(() => {
        const element = scrollerRef.current
        if (!element) return
        if (state.loadingContext && activeThreads.length === 0) return
        if (stickRef.current) {
          element.scrollTop = element.scrollHeight
        }
      }, [activeThreads, lastLength, state.tab, state.loadingContext, keyboard])

      // 切换 tab 时回到“跟随最新”。
      React.useEffect(() => {
        stickRef.current = true
        setAwayFromBottom(false)
        const element = scrollerRef.current
        if (element) element.scrollTop = element.scrollHeight
      }, [state.tab])

      const jumpToLatest = () => {
        const element = scrollerRef.current
        if (!element) return
        stickRef.current = true
        setAwayFromBottom(false)
        element.scrollTo({ top: element.scrollHeight, behavior: narrow ? 'auto' : 'smooth' })
      }

      const unavailable = activeAvailable === false
      const unavailableHint =
        state.tab === 'reviewer'
          ? context?.reviewer?.hint ?? t('reviewUnavailable')
          : context?.executor?.hint ?? t('executorUnavailable')
      // 兜底评估卡只出现在审查 tab，且审批结束后不再显示。
      const ended = state.resolved || (state.pending === null && state.contextMissing !== true)
      const showAdvisory = state.tab === 'reviewer' && needsReview && !ended

      return h(
        'div',
        { className: 'ac-thread-wrap' },
        h(
          'div',
          {
            className: 'ac-thread',
            ref: scrollerRef,
            onScroll,
            'data-approval-consult-thread': '',
            role: 'tabpanel',
            id: `ac-tabpanel-${state.tab}`,
            'aria-labelledby': `ac-tab-${state.tab}`,
            'aria-label': t('ariaThread'),
            tabIndex: 0,
          },
          state.loadingContext && activeThreads.length === 0 ? h(ThreadSkeleton, { t }) : null,
          state.contextError
            ? h(ContextError, { t, error: state.contextError, onRetry: retryContext })
            : null,
          unavailable && showAdvisory
            ? h(AdvisoryReviewCard, {
                t,
                busy: reviewBusy,
                error: reviewError,
                onReview,
              })
            : unavailable
              ? h(
                  'div',
                  { className: 'ac-state' },
                  h('div', { className: 'ac-state-icon', 'aria-hidden': 'true' }, '!'),
                  h('div', { className: 'ac-state-title' }, state.tab === 'reviewer' ? t('reviewUnavailable') : t('executorUnavailable')),
                  h('div', { className: 'ac-state-hint' }, unavailableHint),
                )
              : null,
          showAdvisory && !unavailable && activeThreads.length === 0
            ? h(AdvisoryReviewCard, {
                t,
                busy: reviewBusy,
                error: reviewError,
                onReview,
              })
            : null,
          !unavailable && activeThreads.length === 0 && !state.loadingContext && !state.contextError && !showAdvisory
            ? h(
                'div',
                { className: 'ac-state' },
                h('div', { className: 'ac-state-icon ac-state-icon-quiet', 'aria-hidden': 'true' }, '…'),
                h('div', { className: 'ac-state-title' }, t('emptyTitle')),
                h('div', { className: 'ac-state-hint' }, t('emptyHint')),
              )
            : null,
          ...activeThreads.map((turn) =>
            h(Turn, {
              key: turn.id,
              t,
              turn,
              tab: state.tab,
              ended: state.resolved,
              onRetry,
              onStop,
              onRelay,
            }),
          ),
        ),
        awayFromBottom && streaming
          ? h(
              'button',
              { type: 'button', className: 'ac-jump', onClick: jumpToLatest },
              h('span', { 'aria-hidden': 'true' }, '↓'),
              t('jumpLatest'),
            )
          : null,
      )
    }

    /**
     * advisory 路径的兜底评估卡片：非 auto-review 触发的审批没有结论，
     * 必须先 POST /review 让审查 AI 重新评估，之后才能提问。
     */
    function AdvisoryReviewCard(props) {
      const { t, busy, error, onReview } = props
      return h(
        'div',
        { className: 'ac-advisory', role: 'group', 'aria-label': t('reviewNeedsTitle') },
        h(
          'div',
          { className: 'ac-advisory-head' },
          // 用文本图标，避免 ⚖ 在部分字体下回退成方块。
          h('span', { className: 'ac-advisory-icon', 'aria-hidden': 'true' }, '!'),
          h('span', { className: 'ac-advisory-title' }, t('reviewNeedsTitle')),
        ),
        error
          ? h(
              'div',
              { className: 'ac-error-block ac-error-inline', role: 'alert' },
              h('div', { className: 'ac-error-detail' }, t(error.key ?? 'errUnknown', { detail: error.detail ?? '—', max: 2000 })),
              error.code ? h('div', { className: 'ac-error-code' }, fmt(t('errorCode'), { code: error.code })) : null,
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            className: 'ac-btn ac-btn-primary ac-advisory-action',
            onClick: onReview,
            disabled: busy,
            'aria-label': t('ariaReviewAction'),
            'aria-busy': busy ? 'true' : 'false',
          },
          busy ? h('span', { className: 'ac-spinner', 'aria-hidden': 'true' }) : null,
          busy ? t('reviewBusy') : error ? t('reviewRetry') : t('reviewNeedAction'),
        ),
      )
    }

    function ThreadSkeleton(props) {
      const { t } = props
      return h(
        'div',
        { className: 'ac-skeleton-wrap', 'aria-busy': 'true' },
        h('span', { className: 'ac-skeleton ac-skeleton-bubble' }),
        h('span', { className: 'ac-skeleton ac-skeleton-card' }),
        h('div', { className: 'ac-skeleton-note' }, t('loadingContext')),
      )
    }

    function ContextError(props) {
      const { t, error, onRetry } = props
      return h(
        'div',
        { className: 'ac-error-block', role: 'alert' },
        h('div', { className: 'ac-error-title' }, t('contextErrorTitle')),
        h('div', { className: 'ac-error-detail' }, fmt(t('contextErrorDetail'), { detail: error?.detail ?? '—' })),
        h('div', { className: 'ac-error-hint' }, t(error?.key ?? 'errUnknown', { max: 2000 })),
        h('button', { type: 'button', className: 'ac-btn ac-btn-ghost', onClick: onRetry }, t('retry')),
      )
    }

    function Turn(props) {
      const { t, turn, tab, ended, onRetry, onStop, onRelay } = props
      const question = String(turn.question ?? '')
      const answer = String(turn.answer ?? '')
      const status = turn.status ?? 'done'
      const usage = turn.usage
      const streaming = status === 'streaming'
      const failed = status === 'error'
      const cancelled = status === 'cancelled'
      const usageText = formatUsage(t, usage)

      return h(
        'article',
        { className: `ac-turn${failed ? ' ac-turn-error' : ''}`, 'data-status': status },
        h(
          'div',
          { className: 'ac-turn-q' },
          h('div', { className: 'ac-bubble-q' }, question),
          h('div', { className: 'ac-turn-time' }, formatClock(turn.at)),
        ),
        h(
          'div',
          { className: 'ac-turn-a' },
          streaming || answer.length > 0
            ? h(
                'div',
                { className: `ac-bubble-a${streaming ? ' ac-bubble-streaming' : ''}${cancelled ? ' ac-bubble-cancelled' : ''}` },
                answer.length > 0
                  ? h(Markdown, { text: answer, t })
                  : h('span', { className: 'ac-typing', 'aria-hidden': 'true' },
                      h('i'), h('i'), h('i'),
                    ),
                streaming ? h('span', { className: 'ac-caret', 'aria-hidden': 'true' }) : null,
              )
            : null,
          failed
            ? h(
                'div',
                { className: 'ac-error-block ac-error-inline', role: 'alert' },
                h('div', { className: 'ac-error-detail' }, t(turn.error?.key ?? 'errUnknown', { detail: turn.error?.detail ?? '—', max: 2000 })),
                turn.error?.code ? h('div', { className: 'ac-error-code' }, fmt(t('errorCode'), { code: turn.error.code })) : null,
                h(
                  'div',
                  { className: 'ac-error-actions' },
                  h('button', { type: 'button', className: 'ac-btn ac-btn-ghost ac-btn-sm', onClick: () => onRetry(tab, turn.id) }, t('turnRetry')),
                ),
              )
            : null,
          streaming
            ? h(
                'div',
                { className: 'ac-turn-actions' },
                h('button', { type: 'button', className: 'ac-btn ac-btn-ghost ac-btn-sm', onClick: () => onStop(tab, turn.id), 'aria-label': t('ariaStop') }, t('stop')),
              )
            : null,
          h(
            'div',
            { className: 'ac-turn-meta' },
            usageText ? h('span', { className: 'ac-meta' }, usageText) : null,
            cancelled ? h('span', { className: 'ac-chip-static' }, t('turnCancelled')) : null,
            turn.injectedAt ? h('span', { className: 'ac-tag ac-tag-ok', title: t('savedTooltip') }, t('savedToSession')) : null,
            turn.truncated ? h('span', { className: 'ac-tag ac-tag-warn', title: t('truncatedHint') }, t('truncated')) : null,
            turn.injectError ? h('span', { className: 'ac-tag ac-tag-warn', title: String(turn.injectError) }, t('saveFailed')) : null,
            tab === 'reviewer' && status === 'done' && !ended
              ? turn.relayedAt
                ? h('span', { className: 'ac-tag ac-tag-ok' }, t('relayed'))
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'ac-link-btn ac-relay',
                      onClick: () => onRelay(turn.id),
                      disabled: turn.relayBusy === true,
                      'aria-label': t('ariaRelay'),
                    },
                    turn.relayBusy ? t('deciding') : t('relay'),
                  )
              : null,
            turn.relayError
              ? h('span', { className: 'ac-tag ac-tag-warn', title: turn.relayError.detail ?? '' }, t('relayFailed'))
              : null,
            ended && status === 'streaming' ? null : null,
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 组件：预设问题 / 输入区 / 决策条                                    */
    /* ------------------------------------------------------------------ */

    function Presets(props) {
      const { t, state, disabled, compact, onEdit } = props
      // 手机上已经聊起来时默认收起预设，把高度让给线程；桌面保持展开。
      const [collapsed, setCollapsed] = React.useState(compact === true)
      // 手机上一旦开始对话就自动收起预设，给线程让出高度（用户仍可手动展开）。
      React.useEffect(() => {
        if (compact) setCollapsed(true)
      }, [compact])
      const presets = state.presets?.[state.tab] ?? []
      const head = h(
        'div',
        { className: 'ac-presets-headrow' },
        h(
          'button',
          {
            type: 'button',
            className: 'ac-presets-head',
            onClick: () => setCollapsed((value) => !value),
            'aria-expanded': collapsed ? 'false' : 'true',
            title: collapsed ? t('presetsShow') : t('presetsHide'),
          },
          h('span', { className: 'ac-chevron', 'aria-hidden': 'true' }, collapsed ? '▸' : '▾'),
          h('span', null, t('presetsTitle')),
        ),
        onEdit
          ? h('button', { type: 'button', className: 'ac-link-btn ac-presets-edit', onClick: onEdit }, t('presetsEdit'))
          : null,
      )
      if (presets.length === 0) {
        return onEdit
          ? h('div', { className: 'ac-presets ac-presets-empty-edit' }, head, h('div', { className: 'ac-presets-empty-hint' }, t('presetsEditorEmpty')))
          : h('div', { className: 'ac-presets ac-presets-empty' })
      }
      return h(
        'div',
        { className: `ac-presets${collapsed ? ' ac-presets-collapsed' : ''}` },
        head,
        collapsed
          ? null
          : h(
              'div',
              { className: 'ac-chips' },
              ...presets.map((text) =>
                h(
                  'button',
                  {
                    key: text,
                    type: 'button',
                    className: 'ac-chip ac-chip-preset',
                    disabled,
                    onClick: () => {
                      if (disabled) return
                      emit({ draft: '' })
                      void sendQuestion(store.tab, text)
                      if (store.compare && isSideAvailable(store.tab === 'executor' ? 'reviewer' : 'executor')) {
                        void sendQuestion(store.tab === 'executor' ? 'reviewer' : 'executor', text, { compare: true })
                      }
                    },
                  },
                  text,
                ),
              ),
            ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 组件：常用问题编辑器                                                 */
    /* ------------------------------------------------------------------ */

    function PresetsEditor(props) {
      const { t, state, narrow, reviewerEnabled } = props
      const [loading, setLoading] = React.useState(true)
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [source, setSource] = React.useState(null)
      const [executor, setExecutor] = React.useState([...(state.presets?.executor ?? [])])
      const [reviewer, setReviewer] = React.useState([...(state.presets?.reviewer ?? [])])
      const [limits, setLimits] = React.useState({ maxCount: 10, maxChars: 300 })
      const [resetArmed, setResetArmed] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const payload = await fetchPresets()
            if (!alive) return
            setExecutor(Array.isArray(payload.executor) ? payload.executor : [])
            setReviewer(Array.isArray(payload.reviewer) ? payload.reviewer : [])
            setSource(typeof payload.source === 'string' ? payload.source : null)
            if (payload.limits) {
              setLimits({
                maxCount: Number(payload.limits.maxCount) || 10,
                maxChars: Number(payload.limits.maxChars) || 300,
              })
            }
            setLoading(false)
          } catch (loadError) {
            if (!alive) return
            setError({ key: 'presetsEditorLoadFailed', detail: describeError(loadError).detail })
            setLoading(false)
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      const listOf = (side) => (side === 'executor' ? executor : reviewer)
      const setList = (side, next) => (side === 'executor' ? setExecutor(next) : setReviewer(next))
      const patchAt = (side, index, text) => {
        const next = [...listOf(side)]
        next[index] = text
        setList(side, next)
      }
      const moveAt = (side, index, delta) => {
        const next = [...listOf(side)]
        const target = index + delta
        if (target < 0 || target >= next.length) return
        const [item] = next.splice(index, 1)
        next.splice(target, 0, item)
        setList(side, next)
      }
      const removeAt = (side, index) => setList(side, listOf(side).filter((_, i) => i !== index))
      const addRow = (side) => {
        const list = listOf(side)
        if (list.length >= limits.maxCount) return
        setList(side, [...list, ''])
      }

      const save = async () => {
        if (saving) return
        setSaving(true)
        setError(null)
        try {
          const payload = await savePresetsRequest({ executor, reviewer })
          const nextExecutor = Array.isArray(payload.executor) ? payload.executor : []
          const nextReviewer = Array.isArray(payload.reviewer) ? payload.reviewer : []
          setExecutor(nextExecutor)
          setReviewer(nextReviewer)
          setSource(typeof payload.source === 'string' ? payload.source : 'user')
          setSaving(false)
          emit({ presets: { executor: nextExecutor, reviewer: nextReviewer }, mode: 'pending' })
          toast('presetsEditorSaved')
        } catch (saveError) {
          setError({ key: 'presetsEditorSaveFailed', detail: describeError(saveError).detail })
          setSaving(false)
        }
      }

      const reset = async () => {
        if (saving) return
        if (!resetArmed) {
          setResetArmed(true)
          after(2600, () => setResetArmed(false))
          return
        }
        setResetArmed(false)
        setSaving(true)
        setError(null)
        try {
          const payload = await resetPresetsRequest()
          setExecutor(Array.isArray(payload.executor) ? payload.executor : [])
          setReviewer(Array.isArray(payload.reviewer) ? payload.reviewer : [])
          setSource(typeof payload.source === 'string' ? payload.source : null)
          setSaving(false)
          toast('presetsEditorResetDone')
        } catch (resetError) {
          setError({ key: 'presetsEditorSaveFailed', detail: describeError(resetError).detail })
          setSaving(false)
        }
      }

      const renderSection = (side, titleKey, enabled) => {
        if (!enabled) return null
        const list = listOf(side)
        return h(
          'section',
          { className: 'ac-edit-section', key: side },
          h(
            'div',
            { className: 'ac-edit-section-head' },
            h('span', { className: 'ac-edit-section-title' }, t(titleKey)),
            h('span', { className: 'ac-meta' }, `${list.length}/${limits.maxCount}`),
          ),
          list.length === 0
            ? h('div', { className: 'ac-edit-empty' }, t('presetsEditorEmpty'))
            : h(
                'div',
                { className: 'ac-edit-rows' },
                ...list.map((text, index) =>
                  h(
                    'div',
                    { className: 'ac-edit-row', key: `${side}:${index}` },
                    h('textarea', {
                      className: 'ac-edit-input',
                      rows: 2,
                      value: text,
                      maxLength: limits.maxChars,
                      placeholder: t('presetsEditorPlaceholder'),
                      'aria-label': fmt(t('presetsEditorRow'), { index: index + 1 }),
                      onChange: (event) => patchAt(side, index, event.target.value),
                    }),
                    h(
                      'div',
                      { className: 'ac-edit-row-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'ac-icon-btn',
                          disabled: index === 0,
                          'aria-label': t('presetsEditorMoveUp'),
                          title: t('presetsEditorMoveUp'),
                          onClick: () => moveAt(side, index, -1),
                        },
                        '↑',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'ac-icon-btn',
                          disabled: index === list.length - 1,
                          'aria-label': t('presetsEditorMoveDown'),
                          title: t('presetsEditorMoveDown'),
                          onClick: () => moveAt(side, index, 1),
                        },
                        '↓',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'ac-icon-btn ac-icon-danger',
                          'aria-label': t('presetsEditorDelete'),
                          title: t('presetsEditorDelete'),
                          onClick: () => removeAt(side, index),
                        },
                        '×',
                      ),
                    ),
                  ),
                ),
              ),
          h(
            'button',
            {
              type: 'button',
              className: 'ac-link-btn ac-edit-add',
              disabled: list.length >= limits.maxCount || saving,
              onClick: () => addRow(side),
            },
            `+ ${t('presetsEditorAdd')}`,
          ),
        )
      }

      return h(
        'div',
        { className: `ac-presets-editor${narrow ? ' ac-presets-editor-narrow' : ''}`, 'data-approval-consult-presets-editor': '' },
        h(
          'div',
          { className: 'ac-edit-scroll' },
          loading
            ? h('div', { className: 'ac-edit-loading' }, t('presetsEditorSaving'))
            : h(
                React.Fragment,
                null,
                h('div', { className: 'ac-edit-limits' }, fmt(t('presetsEditorLimit'), { count: limits.maxCount, chars: limits.maxChars })),
                error
                  ? h(
                      'div',
                      { className: 'ac-error-block ac-error-inline', role: 'alert' },
                      h('div', { className: 'ac-error-detail' }, `${t(error.key)}${error.detail ? `：${error.detail}` : ''}`),
                    )
                  : null,
                renderSection('executor', 'presetsEditorExecutor', true),
                renderSection('reviewer', 'presetsEditorReviewer', reviewerEnabled !== false),
              ),
        ),
        h(
          'div',
          { className: 'ac-edit-actions' },
          h(
            'button',
            { type: 'button', className: 'ac-btn ac-btn-ghost', onClick: () => emit({ mode: 'pending' }), disabled: saving },
            t('presetsEditorCancel'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: `ac-btn ac-btn-ghost ac-edit-reset${resetArmed ? ' ac-edit-reset-armed' : ''}`,
              onClick: () => void reset(),
              disabled: saving || loading,
            },
            resetArmed ? t('presetsEditorResetConfirm') : t('presetsEditorReset'),
          ),
          h(
            'button',
            { type: 'button', className: 'ac-btn ac-btn-primary', onClick: () => void save(), disabled: saving || loading },
            saving ? t('presetsEditorSaving') : t('presetsEditorSave'),
          ),
        ),
        source === 'builtin' ? null : h('div', { className: 'ac-edit-source' }, source === 'config' ? 'config' : 'saved'),
      )
    }

    function Composer(props) {
      const { t, state, narrow, inputRef, streaming, disabled, disabledHint, onSend, onStop } = props
      const textareaRef = React.useRef(null)
      const setRef = (element) => {
        textareaRef.current = element
        if (inputRef) inputRef.current = element
      }

      // 自适应高度 2–4 行。
      React.useLayoutEffect(() => {
        const element = textareaRef.current
        if (!element) return
        try {
          element.style.height = 'auto'
          const line = 20
          const max = line * 4 + 16
          const min = line * 2 + 16
          element.style.height = `${Math.min(max, Math.max(min, element.scrollHeight))}px`
        } catch {
          /* ignore */
        }
      }, [state.draft, narrow])

      const canSend = !disabled && state.draft.trim().length > 0
      return h(
        'div',
        { className: 'ac-composer' },
        h(
          'div',
          { className: `ac-input-wrap${disabled ? ' ac-input-disabled' : ''}` },
          h('textarea', {
            className: 'ac-input',
            ref: setRef,
            rows: 2,
            value: state.draft,
            disabled,
            placeholder: disabled ? disabledHint || t('reviewerUnavailable') : narrow ? t('placeholderMobile') : t('placeholderDesktop'),
            'aria-label': t('ariaInput'),
            onChange: (event) => emit({ draft: event.target.value }),
            onFocus: () => {
              // 手机键盘弹起后把输入区滚进可见区域（block:'nearest' 不会乱跳页面）。
              if (!narrow) return
              after(300, () => {
                try {
                  textareaRef.current?.scrollIntoView({ block: 'nearest' })
                } catch {
                  /* ignore */
                }
              })
            },
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return
              // 手机：Enter 换行，显式点发送按钮；桌面：Enter 发送、Shift+Enter 换行。
              if (narrow || event.shiftKey) return
              event.preventDefault()
              if (!canSend) return
              onSend()
            },
          }),
          h(
            'div',
            { className: 'ac-input-tools' },
            disabled ? null : h('span', { className: 'ac-hint' }, narrow ? t('sendHintMobile') : t('sendHintEnter')),
          ),
        ),
        h(
          'div',
          { className: 'ac-composer-actions' },
          streaming
            ? h('button', { type: 'button', className: 'ac-btn ac-btn-ghost', onClick: onStop }, t('stop'))
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'ac-btn ac-btn-primary ac-send',
              disabled: !canSend,
              onClick: onSend,
              'aria-label': t('ariaSend'),
            },
            t('send'),
          ),
        ),
      )
    }

    function DecisionBar(props) {
      const { t, state, pendingApproval } = props
      const ended = state.resolved || (state.pending === null && state.contextMissing !== true)
      const demo = state.demo !== null
      const answerable = demo ? !ended : pendingApproval !== null && pendingApproval?.answerable !== false
      const busy = state.deciding === true
      const syncing = !demo && !ended && pendingApproval === null

      if (ended) {
        const outcome = normalizeOutcome(state.outcome ?? state.pending?.outcome ?? null)
        const endedError = state.pending?.error ?? null
        const timedOut = outcome === null && typeof endedError === 'string' && /timed out|超时/i.test(endedError)
        const outcomeKey = OUTCOME_KEYS[outcome] ?? (timedOut ? 'outcomeTimeout' : 'outcomeUnknown')
        const tone = outcome === 'rejected' ? 'error' : outcome === 'allowed-once' ? 'success' : 'neutral'
        return h(
          'div',
          { className: 'ac-decide ac-decide-ended', 'aria-label': t('ariaDecide') },
          h(
            'div',
            { className: 'ac-decide-outcome' },
            h('span', { className: `ac-outcome-dot ac-outcome-${tone}`, 'aria-hidden': 'true' }),
            h('span', { className: 'ac-decide-outcome-text' }, t(outcomeKey)),
            state.decided ? h('span', { className: 'ac-tag ac-tag-ok' }, t('decided')) : null,
          ),
        )
      }

      return h(
        'div',
        { className: 'ac-decide', 'aria-label': t('ariaDecide') },
        h(
          'div',
          { className: 'ac-decide-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'ac-btn ac-btn-danger',
              disabled: !answerable || busy,
              onClick: () => void decide(pendingApproval, 'rejected'),
            },
            busy ? t('deciding') : t('reject'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ac-btn ac-btn-primary',
              disabled: !answerable || busy,
              onClick: () => void decide(pendingApproval, 'allowed-once'),
            },
            busy ? t('deciding') : t('allowOnce'),
          ),
        ),
        h(
          'div',
          { className: 'ac-decide-copy' },
          h('span', { className: 'ac-decide-hint' }, t('decideHint')),
          syncing ? h('span', { className: 'ac-meta' }, t('decideSyncing')) : null,
        ),
      )
    }

    function Toast(props) {
      const { t, notice } = props
      const tone = notice.tone === 'error' ? 'error' : 'info'
      return h(
        'div',
        { className: `ac-toast ac-toast-${tone}`, role: 'status' },
        h('span', { className: 'ac-toast-text' }, t(notice.key, notice.vars)),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 样式                                                                */
    /* ------------------------------------------------------------------ */

    const CSS = `
/* ---------- 基础：只用主题 token，亮暗色都必须成立 ---------- */
.ac-root{position:fixed;inset:0;z-index:40;display:flex;justify-content:flex-end;align-items:stretch;box-sizing:border-box;font-family:var(--dsw-font-family,inherit);font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#1f2329);-webkit-font-smoothing:antialiased;--ac-surface:#ffffff;--ac-surface-2:#f6f7f9;--ac-surface-3:#eef1f5;--ac-border:rgba(15,20,30,.12)}
/* 用户自定义主题可能把 --dsw-alias-bg-base 设成 transparent（壁纸主题），
   面板必须自带不透明底，否则内容会和背后的对话/审批卡片叠在一起。 */
body[data-ds-dark-theme] .ac-root{--ac-surface:#1c1e23;--ac-surface-2:#23262c;--ac-surface-3:#2a2e36;--ac-border:rgba(255,255,255,.13)}
/* 面板同时是 manual popover（top layer）：清掉 UA 的 popover 默认样式。 */
.ac-root[popover]{margin:0;padding:0;border:0;width:auto;height:auto;max-width:none;max-height:none;background:transparent;color:inherit;overflow:visible;inset:0;display:flex;justify-content:flex-end;align-items:stretch}
.ac-root[popover]::backdrop{display:none}
.ac-root *,.ac-root *::before,.ac-root *::after{box-sizing:border-box}
.ac-backdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-2,rgba(15,20,30,.12));animation:ac-fade-in 200ms ease-out;pointer-events:auto}
.ac-sheet{position:relative;display:flex;flex-direction:column;width:min(468px,100%);height:100%;min-height:0;overflow:hidden;background:var(--ac-surface);border-left:1px solid var(--ac-border);box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(15,20,30,.14));pointer-events:auto;outline:none;animation:ac-slide-in 210ms cubic-bezier(.2,.9,.3,1)}
.ac-root-narrow .ac-sheet{width:100%;height:min(88vh,100%);margin-top:auto;border-left:none;border-top:1px solid var(--ac-border);border-radius:var(--dsw-radius-xl,20px) var(--dsw-radius-xl,20px) 0 0;animation:ac-slide-up 220ms cubic-bezier(.2,.9,.3,1)}
.ac-root-narrow{align-items:flex-end;justify-content:center}
.ac-root-narrow .ac-backdrop{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24))}
@keyframes ac-fade-in{from{opacity:0}to{opacity:1}}
@keyframes ac-slide-in{from{transform:translateX(20px);opacity:.55}to{transform:none;opacity:1}}
@keyframes ac-slide-up{from{transform:translateY(26px);opacity:.55}to{transform:none;opacity:1}}
.ac-grabber{display:flex;justify-content:center;padding:8px 0 0;flex:none}
.ac-grabber span{width:38px;height:4px;border-radius:999px;background:var(--dsw-alias-border-l4,rgba(0,0,0,.16))}
.ac-root-narrow .ac-grabber{padding:12px 0 10px;touch-action:none;cursor:grab}
.ac-root-narrow .ac-grabber:active{cursor:grabbing}
.ac-root-narrow .ac-sheet{transition:transform 170ms ease-out}
.ac-root-narrow .ac-grabber span{width:42px;height:5px}

/* ---------- 悬浮胶囊（root 层唯一入口） ---------- */
.ac-pill-wrap{position:fixed;top:calc(64px + env(safe-area-inset-top,0px));right:20px;z-index:45;display:flex;align-items:center;gap:6px;pointer-events:auto;animation:ac-pill-in 240ms cubic-bezier(.2,.9,.3,1)}
.ac-pill-wrap[data-narrow]{top:calc(96px + env(safe-area-inset-top,0px));right:10px}
@keyframes ac-pill-in{from{opacity:0;transform:translateY(-6px) scale(.96)}to{opacity:1;transform:none}}
.ac-pill{position:relative;display:inline-flex;align-items:center;gap:8px;appearance:none;cursor:pointer;font:inherit;font-size:13px;line-height:18px;font-weight:500;padding:7px 14px 7px 11px;border-radius:999px;color:var(--dsw-alias-label-primary,#1f2329);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f59e0b) 14%, var(--ac-surface));border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-secondary,#f7ad31) 55%, transparent);box-shadow:var(--dsw-shadow-lv2,0 2px 8px rgba(0,0,0,.08));transition:background 140ms ease,border-color 140ms ease,transform 140ms ease,box-shadow 140ms ease}
.ac-pill:hover{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f59e0b) 22%, var(--ac-surface));transform:translateY(-1px);box-shadow:var(--dsw-shadow-lv3,0 8px 20px rgba(0,0,0,.12))}
.ac-pill:active{transform:none}
.ac-pill:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:2px}
.ac-pill-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;font-size:11px;font-weight:700;color:var(--dsw-alias-state-warn-tertiary,#fef5e7);background:var(--dsw-alias-state-warn-primary,#f59e0b);flex:none}
.ac-pill-pulse{position:absolute;left:9px;top:50%;width:8px;height:8px;margin-top:-4px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#f59e0b);opacity:0;animation:ac-pulse 2.4s ease-out infinite}
@keyframes ac-pulse{0%{transform:scale(1);opacity:.55}70%{transform:scale(3.2);opacity:0}100%{opacity:0}}
.ac-pill-text{white-space:nowrap}
.ac-pill-tool{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;padding:1px 6px;border-radius:6px;color:var(--dsw-alias-label-secondary,#4b5563);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-pill-demo{font-size:10px;line-height:14px;padding:1px 6px;border-radius:999px;color:var(--dsw-alias-label-tertiary,#6b7280);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ac-pill-dismiss{appearance:none;border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:14px;line-height:18px;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;padding:0;transition:background 120ms ease,color 120ms ease}
.ac-pill-dismiss:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.08));color:var(--dsw-alias-label-primary,#1f2329)}
.ac-pill-dismiss:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:1px}

/* ---------- 头部 ---------- */
.ac-head{flex:none;display:flex;align-items:flex-start;gap:12px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04))}
.ac-root-narrow .ac-head{padding:10px 14px 8px;flex-wrap:wrap}
.ac-head-main{min-width:0;flex:1}
.ac-head-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}
.ac-status{display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:16px;padding:2px 8px;border-radius:999px;color:var(--dsw-alias-state-warn-label,#dd8629);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f59e0b) 13%, transparent)}
.ac-status-ended{color:var(--dsw-alias-label-tertiary,#6b7280);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ac-status-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.ac-status:not(.ac-status-ended) .ac-status-dot{animation:ac-blink 1.6s ease-in-out infinite}
@keyframes ac-blink{0%,100%{opacity:1}50%{opacity:.25}}
.ac-tool{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;padding:2px 7px;border-radius:6px;color:var(--dsw-alias-label-secondary,#4b5563);background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-interactive-bg-hover,#f3f4f6));max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-badge{font-size:10px;line-height:14px;padding:1px 6px;border-radius:999px;color:var(--dsw-alias-label-tertiary,#6b7280);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ac-title{margin:0;font-size:17px;line-height:24px;font-weight:600;letter-spacing:.2px;color:var(--dsw-alias-label-primary,#1f2329)}
.ac-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#6b7280);margin-top:1px}
.ac-head-actions{display:flex;align-items:center;gap:8px;flex:none;padding-top:2px}
.ac-head-countdown{flex:1 0 100%;display:flex;justify-content:flex-end;margin-top:2px}
.ac-icon-btn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer;width:30px;height:30px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-size:15px;line-height:1;transition:background 120ms ease,color 120ms ease}
.ac-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.08));color:var(--dsw-alias-label-primary,#1f2329)}
.ac-icon-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:1px}

/* ---------- 倒计时 chip ---------- */
.ac-chip{display:inline-flex;align-items:center;gap:6px;appearance:none;font:inherit;font-size:11px;line-height:16px;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:var(--ac-surface-2);color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;transition:background 120ms ease,border-color 120ms ease,color 120ms ease;white-space:nowrap}
.ac-chip:hover{border-color:var(--dsw-alias-state-warn-secondary,#f7ad31);color:var(--dsw-alias-state-warn-label,#dd8629)}
.ac-chip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:1px}
.ac-chip-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.ac-chip-countdown{padding-right:10px}
.ac-chip-danger{color:var(--dsw-alias-state-error-primary,#ec1313);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#ec1313) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#ec1313) 8%, transparent)}
.ac-chip-danger:hover{color:var(--dsw-alias-state-error-primary,#ec1313);border-color:var(--dsw-alias-state-error-primary,#ec1313)}
.ac-chip-static{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;color:var(--dsw-alias-label-tertiary,#6b7280);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}

/* ---------- tabs ---------- */
.ac-tabs{flex:none;display:flex;align-items:center;gap:4px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));overflow-x:auto;scrollbar-width:none}
.ac-tabs::-webkit-scrollbar{display:none}
.ac-tab{appearance:none;border:none;background:transparent;font:inherit;font-size:13px;line-height:18px;padding:6px 11px;border-radius:8px;color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;transition:background 120ms ease,color 120ms ease}
.ac-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ac-tab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:-2px}
.ac-tab-active{background:color-mix(in srgb, var(--dsw-alias-brand-primary,#0f1115) 8%, transparent);color:var(--dsw-alias-label-primary,#1f2329);font-weight:600}
.ac-tab-warn{color:var(--dsw-alias-label-tertiary,#6b7280)}
.ac-tab-note{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;font-size:10px;font-weight:700;color:var(--dsw-alias-state-warn-tertiary,#fef5e7);background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.ac-compare{margin-left:auto;appearance:none;border:1px solid transparent;background:transparent;font:inherit;font-size:12px;line-height:18px;padding:4px 9px;border-radius:999px;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;transition:background 120ms ease,color 120ms ease,border-color 120ms ease}
.ac-compare:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#1f2329)}
.ac-compare:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:1px}
.ac-compare[aria-disabled="true"]{opacity:.6;cursor:not-allowed}
.ac-compare-on{color:var(--dsw-alias-label-primary,#1f2329);background:color-mix(in srgb, var(--dsw-alias-brand-primary,#0f1115) 8%, transparent);border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.ac-compare-icon{font-size:12px}

/* ---------- 结束 banner / 双问提示 ---------- */
.ac-banner{flex:none;padding:9px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));font-size:12px;line-height:18px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}
.ac-banner-success{background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#22c55e) 9%, transparent)}
.ac-banner-error{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#ec1313) 8%, transparent)}
.ac-banner-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ac-banner-title{font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}
.ac-banner-outcome{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.08));color:var(--dsw-alias-label-secondary,#4b5563)}
.ac-banner-outcome-success{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#22c55e) 14%, transparent)}
.ac-banner-outcome-error{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#ec1313) 12%, transparent)}
.ac-banner-hint{margin-top:3px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.ac-syncing{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d9a327) 10%, transparent)}
.ac-syncing .ac-link-btn{margin-top:4px;font-size:12px}
/* 倒计时进行中：给一个显眼的提示条（阅读/思考时容易超过 60s，被自动拒绝很意外） */
.ac-timeout-banner{flex:none;display:flex;align-items:center;gap:8px;padding:7px 12px 7px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#1f2329);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f59e0b) 14%, var(--ac-surface));border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-secondary,#f7ad31) 40%, transparent)}
.ac-timeout-banner-text{flex:1 1 auto;min-width:0}
.ac-timeout-banner-pause{flex:none;appearance:none;cursor:pointer;font:inherit;font-size:12px;line-height:18px;font-weight:600;padding:3px 10px;border-radius:999px;border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-secondary,#f7ad31) 60%, transparent);background:var(--ac-surface);color:var(--dsw-alias-label-primary,#1f2329)}
.ac-timeout-banner-pause:hover{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f59e0b) 18%, var(--ac-surface))}
.ac-timeout-banner-close{flex:none}
.ac-timeout-banner-close .ac-icon-btn{width:24px;height:24px}
.ac-note-toggle{margin-top:2px;text-align:left;font-size:12px}
.ac-compare-ready{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#4b5563);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f59e0b) 8%, transparent);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04))}
.ac-compare-ready-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---------- 上下文卡片 ---------- */
.ac-context{flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.025))}
.ac-context-skeleton{padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.ac-context-head{display:flex;align-items:center;gap:8px;padding:8px 14px 6px;flex-wrap:wrap}
.ac-context-toggle{appearance:none;border:none;background:transparent;font:inherit;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:2px 4px;border-radius:6px}
.ac-context-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#1f2329)}
.ac-context-toggle:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:1px}
.ac-context-title{letter-spacing:.2px}
.ac-chevron{font-size:10px;color:var(--dsw-alias-label-tertiary,#6b7280);width:10px;display:inline-block;text-align:center}
.ac-context-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}
.ac-risk,.ac-verdict{font-size:11px;line-height:16px;padding:2px 8px;border-radius:999px;border:1px solid transparent;white-space:nowrap;font-weight:500}
.ac-risk-low{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#22c55e) 13%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary,#22c55e) 30%, transparent)}
.ac-risk-medium{color:var(--dsw-alias-state-warn-label,#dd8629);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f59e0b) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f59e0b) 32%, transparent)}
.ac-risk-high{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#ec1313) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#ec1313) 30%, transparent)}
.ac-verdict-allow{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#22c55e) 10%, transparent)}
.ac-verdict-deny{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#ec1313) 10%, transparent)}
.ac-context-body{padding:0 14px 10px;display:flex;flex-direction:column;gap:8px}
.ac-reason{margin:0;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary,#4b5563);white-space:pre-wrap;word-break:break-word;max-height:57px;overflow:hidden}
.ac-reason .ac-md{font-size:12.5px;line-height:19px;color:inherit}
.ac-reason-open{max-height:none;overflow:visible}
.ac-reason-toggle{margin-left:6px;font-size:12px}
.ac-note-block{display:flex;flex-direction:column;gap:2px;padding:7px 9px;border-radius:8px;background:var(--ac-surface-2);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05))}
.ac-note-label{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.ac-note-text{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#4b5563);white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ac-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.ac-note-warn{color:var(--dsw-alias-state-warn-label,#dd8629);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f59e0b) 9%, transparent);padding:6px 9px;border-radius:8px}
.ac-args-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ac-args-toggle{appearance:none;border:none;background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:2px 4px;border-radius:6px}
.ac-args-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#1f2329)}
.ac-args-toggle:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:1px}
.ac-args{margin:0;max-height:190px;overflow:auto;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-markdown-code-block,var(--ac-surface-3));border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;line-height:17px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#4b5563)}
.ac-context-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ac-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.ac-meta-code{font-family:var(--ds-font-family-code,ui-monospace,monospace);opacity:.8}

/* ---------- 线程 ---------- */
.ac-thread-wrap{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.ac-thread{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px 16px 16px;display:flex;flex-direction:column;gap:16px;outline:none;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l1,rgba(0,0,0,.16)) transparent}
.ac-thread:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:-2px}
.ac-thread::-webkit-scrollbar{width:8px}
.ac-thread::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l1,rgba(0,0,0,.16));border-radius:999px;border:2px solid transparent;background-clip:content-box}
.ac-thread::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l1,rgba(0,0,0,.26));background-clip:content-box}
.ac-turn{display:flex;flex-direction:column;gap:8px;animation:ac-turn-in 180ms ease-out}
@keyframes ac-turn-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.ac-turn-q{display:flex;align-items:flex-end;justify-content:flex-end;gap:8px;max-width:100%}
.ac-bubble-q{max-width:min(86%,420px);padding:8px 11px;border-radius:12px 12px 4px 12px;background:var(--dsw-specific-bubble,#edf3fe);color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:19px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.ac-turn-time{font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-dimmed,#c3c7cd);flex:none}
.ac-turn-a{display:flex;flex-direction:column;gap:6px}
.ac-bubble-a{position:relative;max-width:100%;padding:9px 12px;border-radius:12px 12px 12px 4px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--ac-surface-2);font-size:13px;line-height:20px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;box-shadow:var(--dsw-shadow-lv1,0 1px 2px rgba(0,0,0,.03))}
.ac-bubble-streaming{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-secondary,#f7ad31) 45%, transparent)}
.ac-bubble-cancelled{opacity:.75}
.ac-answer-text{white-space:pre-wrap}
.ac-caret{display:inline-block;width:2px;height:14px;margin-left:2px;vertical-align:-2px;background:var(--dsw-alias-label-secondary,#4b5563);border-radius:1px;animation:ac-caret 1s step-end infinite}
@keyframes ac-caret{0%,100%{opacity:1}50%{opacity:.15}}
.ac-typing{display:inline-flex;align-items:center;gap:4px;height:14px}
.ac-typing i{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#6b7280);animation:ac-typing 1.2s ease-in-out infinite}
.ac-typing i:nth-child(2){animation-delay:.15s}
.ac-typing i:nth-child(3){animation-delay:.3s}
@keyframes ac-typing{0%,100%{opacity:.25;transform:translateY(0)}40%{opacity:.9;transform:translateY(-2px)}}
.ac-turn-actions{display:flex;gap:8px}
.ac-turn-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:16px}
.ac-tag{font-size:10.5px;line-height:16px;padding:1px 7px;border-radius:999px;white-space:nowrap}
.ac-tag-ok{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#22c55e) 11%, transparent)}
.ac-tag-warn{color:var(--dsw-alias-state-warn-label,#dd8629);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f59e0b) 12%, transparent)}
.ac-state{display:flex;flex-direction:column;align-items:center;gap:8px;padding:28px 18px;text-align:center}
.ac-state-icon{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;font-size:17px;font-weight:700;color:var(--dsw-alias-state-warn-label,#dd8629);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f59e0b) 12%, transparent)}
.ac-state-icon-quiet{color:var(--dsw-alias-label-tertiary,#6b7280);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05));font-weight:500}
.ac-state-title{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary,#4b5563)}
.ac-state-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#6b7280);max-width:320px;white-space:pre-wrap;word-break:break-word}
.ac-jump{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);display:inline-flex;align-items:center;gap:5px;appearance:none;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:var(--ac-surface);color:var(--dsw-alias-label-secondary,#4b5563);font:inherit;font-size:12px;line-height:18px;padding:5px 12px;border-radius:999px;cursor:pointer;box-shadow:var(--dsw-shadow-lv2,0 2px 8px rgba(0,0,0,.1));animation:ac-fade-in 160ms ease-out}
.ac-jump:hover{color:var(--dsw-alias-label-primary,#1f2329);border-color:var(--dsw-alias-border-l4,rgba(0,0,0,.2))}
.ac-jump:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:2px}

/* ---------- 错误 ---------- */
.ac-error-block{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary,#ec1313) 24%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#ec1313) 6%, transparent);font-size:12px;line-height:18px}
.ac-error-inline{margin-top:2px;border-radius:8px;padding:8px 10px}
.ac-error-title{font-weight:600;color:var(--dsw-alias-state-error-primary,#ec1313)}
.ac-error-detail{color:var(--dsw-alias-label-secondary,#4b5563);word-break:break-word;overflow-wrap:anywhere;white-space:pre-wrap}
.ac-error-hint{color:var(--dsw-alias-label-tertiary,#6b7280)}
.ac-error-code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}
.ac-error-actions{display:flex;gap:8px;margin-top:2px}

/* ---------- 底部：预设 / 输入 / 决策 ---------- */
.ac-bottom{flex:none;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));background:var(--ac-surface);padding-bottom:env(safe-area-inset-bottom,0px)}
.ac-presets{padding:8px 14px 4px;display:flex;flex-direction:column;gap:6px}
.ac-presets-empty{display:none}
.ac-presets-headrow{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ac-presets-edit{font-size:12px;flex:none}
.ac-presets-empty-edit{padding:8px 14px 4px}
.ac-presets-empty-hint{margin-top:4px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#6b7280)}
/* 常用问题编辑器 */
.ac-presets-editor{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
.ac-edit-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.ac-edit-limits{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.ac-edit-section{display:flex;flex-direction:column;gap:8px;border:1px solid var(--ac-border);border-radius:12px;padding:10px 12px;background:var(--ac-surface-2)}
.ac-edit-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ac-edit-section-title{font-size:12.5px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}
.ac-edit-rows{display:flex;flex-direction:column;gap:8px}
.ac-edit-row{display:flex;gap:8px;align-items:flex-start}
.ac-edit-input{flex:1 1 auto;min-height:40px;resize:vertical;font:inherit;font-size:13px;line-height:19px;padding:7px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:var(--ac-surface);color:var(--dsw-alias-label-primary,#1f2329);outline:none}
.ac-edit-input:focus{border-color:var(--dsw-alias-link,#4176e6);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-link,#4176e6) 18%, transparent)}
.ac-edit-row-actions{display:flex;gap:2px;flex:none}
.ac-edit-row-actions .ac-icon-btn{width:26px;height:26px}
.ac-icon-danger{color:var(--dsw-alias-state-error-primary,#ec1313)}
.ac-edit-add{align-self:flex-start;font-size:12px}
.ac-edit-empty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#6b7280);padding:2px 0}
.ac-edit-actions{flex:none;display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;padding:10px 16px;border-top:1px solid var(--ac-border);background:var(--ac-surface)}
.ac-edit-reset-armed{border-color:var(--dsw-alias-state-error-primary,#ec1313);color:var(--dsw-alias-state-error-primary,#ec1313)}
.ac-edit-loading{padding:18px 4px;font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.ac-edit-source{display:none}
.ac-presets-editor-narrow .ac-edit-scroll{padding:10px 12px}
.ac-presets-editor-narrow .ac-edit-actions{padding:8px 12px}
.ac-presets-head{appearance:none;border:none;background:transparent;font:inherit;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:2px 2px;border-radius:6px;align-self:flex-start}
.ac-presets-head:hover{color:var(--dsw-alias-label-secondary,#4b5563)}
.ac-presets-head:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:1px}
.ac-chips{display:flex;flex-wrap:wrap;gap:6px;max-height:168px;overflow-y:auto;scrollbar-width:thin}
.ac-root-narrow .ac-chips{max-height:96px}
.ac-chip-preset{appearance:none;font:inherit;font-size:12px;line-height:17px;padding:4px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));background:var(--ac-surface-2);color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;text-align:left;transition:background 120ms ease,border-color 120ms ease,color 120ms ease;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-chip-preset:hover:not(:disabled){border-color:color-mix(in srgb, var(--dsw-alias-brand-primary,#0f1115) 30%, transparent);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05));color:var(--dsw-alias-label-primary,#1f2329)}
.ac-chip-preset:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:1px}
.ac-chip-preset:disabled{opacity:.5;cursor:not-allowed}
.ac-composer{display:flex;flex-direction:column;gap:6px;padding:6px 14px 8px}
.ac-input-wrap{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,12px);background:var(--ac-surface-2);padding:8px 10px 6px;transition:border-color 140ms ease,box-shadow 140ms ease}
.ac-input-wrap:focus-within{border-color:color-mix(in srgb, var(--dsw-alias-link,#4176e6) 55%, transparent);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-link,#4176e6) 12%, transparent)}
.ac-input-wrap.ac-input-disabled{opacity:.62}
.ac-input{appearance:none;border:none;outline:none;background:transparent;resize:none;width:100%;padding:0;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#1f2329);min-height:40px;max-height:96px;overflow-y:auto;font-family:inherit}
.ac-input::placeholder{color:var(--dsw-alias-label-dimmed,#9aa0a6)}
.ac-input-tools{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ac-hint{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-dimmed,#9aa0a6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ac-composer-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}

/* ---------- 按钮 ---------- */
.ac-btn{appearance:none;font:inherit;font-size:13px;line-height:18px;cursor:pointer;border-radius:999px;padding:6px 14px;border:1px solid transparent;transition:background 120ms ease,border-color 120ms ease,color 120ms ease,opacity 120ms ease;white-space:nowrap}
.ac-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:2px}
.ac-btn:disabled{opacity:.45;cursor:not-allowed}
.ac-btn-sm{font-size:12px;line-height:17px;padding:4px 10px}
.ac-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#0f1115));color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}
.ac-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-label-secondary,#43454a))}
.ac-btn-ghost{background:var(--ac-surface-2);border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.12));color:var(--dsw-alias-label-secondary,#4b5563)}
.ac-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#1f2329)}
.ac-btn-danger{background:transparent;border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#ec1313) 38%, transparent);color:var(--dsw-alias-state-error-primary,#ec1313)}
.ac-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.06))}
.ac-send{min-width:76px}
.ac-icon-btn,.ac-link-btn,.ac-chip,.ac-pill,.ac-tab,.ac-compare,.ac-tool-toggle,.ac-args-toggle,.ac-context-toggle,.ac-presets-head,.ac-jump,.ac-pill-dismiss{-webkit-tap-highlight-color:transparent}
.ac-link-btn{appearance:none;border:none;background:transparent;padding:0;font:inherit;font-size:12px;line-height:17px;color:var(--dsw-alias-link,#4176e6);cursor:pointer;text-decoration:none;white-space:nowrap}
.ac-link-btn:hover{text-decoration:underline}
.ac-link-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:1px;border-radius:4px}
.ac-link-btn:disabled{opacity:.5;cursor:default;text-decoration:none}

/* ---------- 决策条 ---------- */
.ac-decide{display:flex;flex-direction:column;align-items:flex-start;gap:5px;padding:7px 14px 9px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.025));flex-wrap:wrap}
.ac-decide-copy{display:flex;flex-direction:column;gap:1px;min-width:0;order:-1;text-align:left}
.ac-decide-hint{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#4b5563)}
.ac-decide-actions{display:flex;gap:8px}
.ac-decide-ended{flex-wrap:wrap}
.ac-decide-outcome{display:flex;align-items:center;gap:8px;min-width:0}
.ac-decide-ended-hint{margin-left:auto;text-align:right;max-width:62%}
.ac-outcome-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#9aa0a6);flex:none}
.ac-outcome-success{background:var(--dsw-alias-state-success-primary,#22c55e)}
.ac-outcome-error{background:var(--dsw-alias-state-error-primary,#ec1313)}
.ac-decide-outcome-text{font-size:12.5px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329);white-space:nowrap}

/* ---------- 轻提示 ---------- */
.ac-toast{position:absolute;left:50%;bottom:calc(96px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);max-width:min(86%,420px);padding:7px 14px;border-radius:999px;background:var(--dsw-alias-toast-bg,#2c2c2e);color:var(--dsw-alias-toast-label,#fff);font-size:12px;line-height:18px;box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.2));animation:ac-toast-in 180ms ease-out;z-index:5;pointer-events:none}
.ac-toast-error{background:var(--dsw-alias-state-error-primary,#ec1313)}
.ac-toast-text{display:block;text-align:center;word-break:break-word}
@keyframes ac-toast-in{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}

/* ---------- 骨架屏 ---------- */
.ac-skeleton{display:block;border-radius:8px;background:linear-gradient(90deg,var(--dsw-alias-bg-skeleton,rgba(0,0,0,.05)) 25%,color-mix(in srgb, var(--dsw-alias-bg-skeleton,rgba(0,0,0,.05)) 45%, transparent) 37%,var(--dsw-alias-bg-skeleton,rgba(0,0,0,.05)) 63%);background-size:400% 100%;animation:ac-shimmer 1.5s ease infinite}
.ac-skeleton-line{height:12px;width:100%}
.ac-skeleton-short{width:56%}
.ac-skeleton-wrap{display:flex;flex-direction:column;gap:10px;padding:6px 2px}
.ac-skeleton-bubble{height:38px;width:66%;margin-left:auto;border-radius:12px}
.ac-skeleton-card{height:82px;width:100%;border-radius:12px}
.ac-skeleton-note{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,#6b7280)}
@keyframes ac-shimmer{0%{background-position:100% 0}100%{background-position:0 0}}

/* ---------- 兜底评估卡片 ---------- */
.ac-advisory{display:flex;flex-direction:column;gap:8px;padding:12px;margin:2px 0;border-radius:12px;border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-secondary,#f7ad31) 42%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f59e0b) 7%, transparent)}
.ac-advisory-head{display:flex;align-items:center;gap:8px}
.ac-advisory-icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;font-size:13px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#f59e0b) 15%, transparent);color:var(--dsw-alias-state-warn-label,#dd8629);flex:none}
.ac-advisory-title{font-size:13px;line-height:19px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}
.ac-advisory-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#4b5563);white-space:pre-wrap;word-break:break-word}
.ac-advisory-action{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;min-height:32px}
.ac-spinner{display:inline-block;width:11px;height:11px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;animation:ac-spin .8s linear infinite;flex:none}
@keyframes ac-spin{to{transform:rotate(360deg)}}
.ac-meta-pending{color:var(--dsw-alias-state-warn-label,#dd8629)}
.ac-tag-info{color:var(--dsw-alias-link,#4176e6);background:color-mix(in srgb, var(--dsw-alias-link,#4176e6) 10%, transparent)}

/* ---------- 回答的轻量 Markdown ---------- */
.ac-md{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#1f2329);word-break:break-word;overflow-wrap:anywhere}
.ac-md > *:first-child{margin-top:0}
.ac-md > *:last-child{margin-bottom:0}
.ac-md p{margin:0 0 8px;white-space:pre-wrap}
.ac-md h4,.ac-md h5,.ac-md h6{margin:0 0 6px;font-size:13px;line-height:20px;font-weight:600}
.ac-md ul,.ac-md ol{margin:0 0 8px;padding-left:20px}
.ac-md li{margin:2px 0;white-space:pre-wrap}
.ac-md li > p{margin:0}
.ac-md code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;padding:1px 5px;border-radius:5px;background:var(--dsw-alias-markdown-inline-code,rgba(38,49,72,.07));color:var(--dsw-alias-label-primary,#1f2329)}
.ac-md blockquote{margin:0 0 8px;padding:2px 0 2px 10px;border-left:2px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));color:var(--dsw-alias-label-secondary,#4b5563)}
.ac-md-code{position:relative;margin:0 0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05));background:var(--dsw-alias-markdown-code-block,rgba(38,49,72,.05));overflow:hidden}
.ac-md-code pre{margin:0;padding:8px 10px;overflow-x:auto;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;line-height:17px;white-space:pre;color:var(--dsw-alias-label-secondary,#4b5563);scrollbar-width:thin}
.ac-md-code-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 8px 0;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.ac-md-code-copy{appearance:none;border:none;background:transparent;font:inherit;font-size:10.5px;line-height:14px;color:var(--dsw-alias-link,#4176e6);cursor:pointer;padding:2px 4px;border-radius:4px}
.ac-md-code-copy:hover{text-decoration:underline}
.ac-md-code-copy:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:1px}
.ac-md strong{font-weight:600}
.ac-md em{font-style:italic}

/* ---------- 兜底 ---------- */
.ac-fatal{position:fixed;left:50%;top:80px;transform:translateX(-50%);z-index:60;max-width:420px;display:flex;flex-direction:column;gap:8px;align-items:flex-start;padding:14px 16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:var(--ac-surface);color:var(--dsw-alias-label-primary,#1f2329);box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.14));font-size:13px;line-height:19px;pointer-events:auto}
.ac-fatal-title{font-weight:600}
.ac-fatal-hint{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px;line-height:18px}
.ac-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* ---------- 咨询记录入口（Turn 尾部 chip，低调） ---------- */
.ac-history-tail{display:flex;justify-content:flex-start;padding:10px 0 2px}
.ac-history-chip{appearance:none;display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:11.5px;line-height:16px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer;transition:background 120ms ease,border-color 120ms ease,color 120ms ease}
.ac-history-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.05));border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.12));color:var(--dsw-alias-label-secondary,#4b5563)}
.ac-history-chip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-link,#4176e6);outline-offset:1px}
.ac-history-chip-icon{font-size:11px;line-height:14px}

/* ---------- 只读历史面板 ---------- */
.ac-history{padding-top:12px;gap:12px}
.ac-history-banner{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04));border:1px dashed var(--dsw-alias-border-l3,rgba(0,0,0,.12))}
.ac-history-banner .ac-banner-title{font-size:12px;line-height:18px}
.ac-history-banner .ac-meta{white-space:normal;line-height:17px}
.ac-history-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:12px;background:var(--ac-surface-2)}
.ac-history-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ac-history-time{margin-left:auto}
.ac-history-reason{padding:7px 9px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04));font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary,#4b5563)}
.ac-history-counts{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ac-history-thread{display:flex;flex-direction:column;gap:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05))}
.ac-history-thread-head{display:flex;align-items:center;gap:8px}
.ac-history-thread-title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary,#4b5563)}
.ac-history-turn{display:flex;flex-direction:column;gap:6px}
.ac-outcome-badge{font-size:10.5px;line-height:16px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap}
.ac-outcome-badge-success{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#22c55e) 12%, transparent)}
.ac-outcome-badge-error{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#ec1313) 11%, transparent)}

/* ---------- 手机 ---------- */
@media (max-width:700px){
  .ac-head{padding:8px 14px 8px}
  .ac-title{font-size:16px;line-height:22px}
  .ac-thread{padding:10px 12px 12px;gap:14px}
  .ac-bubble-q{max-width:88%}
  .ac-context-head{padding:6px 12px 4px}
  .ac-context-body{padding:0 12px 8px}
  /* 手机上展开的上下文卡片内部滚动，别把输入区挤出弹层。 */
  .ac-context{max-height:33vh;overflow-y:auto;overscroll-behavior:contain;flex:0 1 auto}
  .ac-thread-wrap{min-height:110px}
  .ac-sheet{overflow:hidden}
  .ac-presets{padding:6px 12px 2px}
  .ac-composer{padding:4px 12px 6px}
  .ac-decide{padding:6px 12px;gap:8px}
  .ac-decide-actions{width:100%;margin-left:0}
  .ac-decide-actions .ac-btn{flex:1}
  .ac-input{font-size:16px;line-height:22px;min-height:44px;max-height:110px}
  .ac-input-wrap{padding:8px 10px 6px}
  .ac-hint{display:none}
  .ac-send{min-width:84px;min-height:38px}
  .ac-btn{min-height:36px}
  .ac-pill{padding:8px 14px 8px 11px}
  .ac-pill-tool{display:none}
  .ac-toast{bottom:calc(120px + env(safe-area-inset-bottom,0px))}
  .ac-tabs{padding:6px 10px}
  .ac-compare{margin-left:0}
}
@media (prefers-reduced-motion: reduce){
  .ac-sheet,.ac-backdrop,.ac-pill-wrap,.ac-turn,.ac-toast,.ac-jump,.ac-skeleton,.ac-status-dot,.ac-pill-pulse,.ac-caret,.ac-typing i{animation:none !important;transition:none !important}
  .ac-caret{opacity:1}
  .ac-jump{transform:translateX(-50%)}
}
`

    /* ------------------------------------------------------------------ */
    /* 插件入口                                                            */
    /* ------------------------------------------------------------------ */

    const inject = ['slots', 'locale', 'uiSession']

    function apply(ctx) {
      // 样式：只在本插件生命周期内存在，避免 HMR 残留多份。
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-approval-consult'
        tag.dataset.pluginCss = 'dsh-approval-consult/panel'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          try {
            tag.remove()
          } catch {
            /* ignore */
          }
        }
      }, 'approval-consult styles')

      // 文案：zh 为主，en 保持同 key 集合。
      ctx.effect(() => {
        const disposeZh = ctx.locale.register(NS, 'zh', ZH)
        const disposeEn = ctx.locale.register(NS, 'en', EN)
        try {
          const missing = Object.keys(ZH).filter((key) => !(key in EN))
          const extra = Object.keys(EN).filter((key) => !(key in ZH))
          if (missing.length > 0 || extra.length > 0) {
            console.warn('[approval-consult] locale key mismatch', { missing, extra })
          }
        } catch {
          /* ignore */
        }
        return () => {
          disposeZh()
          disposeEn()
        }
      }, 'approval-consult dictionaries')

      // HMR / 插件卸载：清掉本模块的定时器与轮询。
      ctx.effect(() => () => disposeRuntime(), 'approval-consult runtime')

      // root 作用域数据源：当前会话（adapter.current）+ 会话状态（sessionStatus）。
      try {
        sessionSource = ctx.uiSession?.adapter?.current ?? ctx.uiSession?.current ?? null
        statusSource = ctx.uiSession?.sessionStatus ?? null
      } catch {
        sessionSource = null
        statusSource = null
      }
      if (sessionSource === null || statusSource === null) {
        // 不抛错：降级为仅 demo 可用，保持页面不崩。
        try {
          console.warn('[approval-consult] uiSession sources unavailable; only demo mode will render')
        } catch {
          /* ignore */
        }
      }

      const boundT = (() => {
        try {
          return ctx.locale.bind(NS)
        } catch {
          return (key) => key
        }
      })()

      // 唯一注册：root 层悬浮层。既有胶囊入口，也有抽屉/底部弹层。
      // 槽位缺失（不同 DSH 版本的 UI 组合）时降级：只告警，不影响插件其余部分加载。
      try {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'approval-consult-panel',
              order: 40,
              locale: NS,
              inject: () => ({
                resolveReason: (reason) => {
                  try {
                    return ctx.locale.resolveText(reason)
                  } catch {
                    return null
                  }
                },
              }),
            },
            (props) => {
              const t = typeof props.t === 'function' ? props.t : boundT
              return h(OverlayBoundary, { t }, h(ConsultOverlay, { ...props, t }))
            },
          ),
        )
      } catch (error) {
        try {
          console.warn('[approval-consult] shell.overlay slot unavailable; panel UI disabled', error)
        } catch {
          /* ignore */
        }
      }

      // 每轮对话尾部：只读的「审批咨询记录」入口。
      // 官方 Chat 会隐藏普通 context 注入行，用户自己需要一个回看入口。
      // 旧版 DSH 没有 turnTail 时只是没有这个入口，面板本身仍可用。
      try {
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: 'approval-consult-history',
              order: 40,
              locale: NS,
            },
            (props) => {
              const t = typeof props.t === 'function' ? props.t : boundT
              return h(HistoryChip, { ...props, t })
            },
          ),
        )
      } catch (error) {
        try {
          console.warn('[approval-consult] conversation.chat.turnTail slot unavailable; history entry disabled', error)
        } catch {
          /* ignore */
        }
      }
    }

    return { inject, apply }
  },
})
