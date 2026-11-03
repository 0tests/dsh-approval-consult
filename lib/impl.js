/**
 * dsh-approval-consult —— 宿主实现（由 lib/index.js 以带版本号的 dynamic import 加载）
 *
 * 目标：当某个工具调用正在等待用户审批时，让用户可以分别向「执行任务的 AI」和
 * 「自动审查 AI」提问，并把有用的问答留存在会话里，帮助用户做出更好的判断。
 *
 * 设计要点：
 *
 * 1. 双通道、互不污染
 *    - 执行 AI：复用主对话最近一次请求的完整前缀（provider/model/system/tools/messages
 *      原样保留，只在末尾追加一条 user 消息），因此绝大多数 token 走 provider 的 prompt
 *      cache，回答也带着完整任务上下文。
 *    - 审查 AI：复用 auto-review 自己那次审查请求的完整前缀（REVIEW_POLICY +
 *      ENVIRONMENT/PROJECT_INSTRUCTIONS/FILTERED_HISTORY/PENDING_ACTION + 它的原始审查
 *      结论），只追加问答回合。绝不把主对话塞给审查 AI。
 *    所有侧调用都带 [[approval-consult-side-query]] 哨兵，避免被本插件自己的 llm/stream
 *    监听器再次捕获（也防止递归）。
 *
 * 2. 只旁路、不接管
 *    对 tools/pre-execute 只记录参数并返回 next()；对 approval/request 只在浏览器应答者
 *    之前登记一条 pending，最终原样返回 next() 的结果；对 llm/stream 只透传并记录。
 *    绝不修改 req.signal（dsh-approval-timeout 依赖它）、不替换官方审批卡片、不监听全局
 *    键盘。
 *
 * 3. 问答留存
 *    执行 AI 的回答完成后，用 agent.inject() 注入一条 source.kind =
 *    "approval-consult"、form = "notice" 的 user-role 上下文消息：它会进入模型下一步的
 *    请求（执行 AI 不会「选完就忘」），并在 Chat 里以可展开的上下文行显示。
 *    审查 AI 的回答默认不进入主对话；用户点「转达给执行 AI」时才注入。
 *
 * 4. 会话状态在宿主侧
 *    线程记录放宿主内存（按 consultKey 索引），手机和电脑看到同一份问答；刷新页面不丢失；
 *    宿主重启后随 pending 一起消失（审批本身也已经不存在）。
 *
 * 5. 明确的失败语义
 *    每个接口都返回 {ok:false, code, error}，客户端据此展示可操作的提示，而不是静默失败。
 *    所有异常都被包含，不会影响主流程（审批、工具执行、模型请求）。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

const ROUTE_PREFIX = '/dsh-approval-consult'
const REVIEW_POLICY_PREFIX = 'REVIEW_POLICY'
const SIDE_SENTINEL = '[[approval-consult-side-query]]'
/** 侧调用没有工具执行器：模型若只发工具调用而没有正文，追加纠正消息自动重试的次数。 */
const SIDE_TOOLCALL_RETRIES = 1
/** 纠正消息（只追加在消息末尾，前缀不变，仍然命中 prompt cache）。 */
const SIDE_TOOLCALL_CORRECTION =
  '【系统纠正】你上一次回答只发起了工具调用、没有给出正文。这里是纯文本咨询，工具不会被执行；' +
  '请直接用纯文本回答上面的问题，绝对不要调用任何工具。'
const INJECT_SOURCE_KIND = 'approval-consult'
const CONTEXT_SUMMARY_MAX_CHARS = 120
const MAX_BODY_BYTES = 64 * 1024
/** 插件版本（诊断用）：从 package.json 读取，避免手写版本号漂移。 */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()
/** 图片上传请求体上限（再受 DSH 附件服务的 imageLimits 约束）。 */
const MAX_ATTACHMENT_BODY_BYTES = 8 * 1024 * 1024
/** 附件引用登记的有效期（审批结束后立即失效，这里是兜底）。 */
const ATTACHMENT_TTL_MS = 2 * 60 * 60 * 1000
/** 允许上传的图片类型（与 DSH attachment 的 ImageMediaType 对齐）。 */
const ATTACHMENT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
/** 只传图不写字时，客户端补的默认问题。 */
const ATTACHMENT_ONLY_QUESTION = '请结合我附的图片说明你的判断。'
const PRESET_MAX_COUNT = 10
const PRESET_MAX_CHARS = 300
/** 包内 data/ 目录：仅用于兼容旧版本写在包内的 presets.json。 */
const PACKAGE_DATA_DIR = dirname(fileURLToPath(new URL('../data/presets.json', import.meta.url)))
/** 可由插件配置 dataDir 覆盖的用户数据目录（apply 时从 config 读取）。 */
let configuredDataDir = null

/**
 * 用户数据的根目录（常用问题等）。
 * 优先级：config.dataDir / DSH_APPROVAL_CONSULT_DATA > $DSH_PROFILE_DIR/data/approval-consult
 *        > --profile 指定的 ~/.dsh/profiles/<name>/data/approval-consult > ~/.dsh-approval-consult。
 * 不用包目录：npm 升级会替换包目录，用户配置会丢；也不用 cwd（DSH 启动目录不固定）。
 */
function profileNameFromArgv(argv = []) {
  for (let i = 0; i < argv.length; i += 1) {
    const item = String(argv[i] ?? '')
    if (item === '--profile' && argv[i + 1] !== undefined) return String(argv[i + 1])
    if (item.startsWith('--profile=')) return item.slice('--profile='.length)
  }
  return null
}

function resolveDataRoot(env = process.env, argv = process.argv, home = homedir(), explicit = null) {
  const direct = typeof explicit === 'string' ? explicit.trim() : ''
  if (direct.length > 0) return direct
  const override = typeof env.DSH_APPROVAL_CONSULT_DATA === 'string' ? env.DSH_APPROVAL_CONSULT_DATA.trim() : ''
  if (override.length > 0) return override
  const profileDir = typeof env.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR.trim() : ''
  if (profileDir.length > 0) return join(profileDir, 'data', 'approval-consult')
  const profile = profileNameFromArgv(argv)
  if (profile !== null && profile.length > 0) return join(home, '.dsh', 'profiles', profile, 'data', 'approval-consult')
  return join(home, '.dsh-approval-consult')
}

function presetsFilePath() {
  return join(resolveDataRoot(process.env, process.argv, homedir(), configuredDataDir), 'presets.json')
}

function parseUserPresetsFile(filePath) {
  if (!existsSync(filePath)) return null
  const data = JSON.parse(readFileSync(filePath, 'utf8'))
  const clean = (list) =>
    Array.isArray(list)
      ? list
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item) => item.length > 0 && item.length <= PRESET_MAX_CHARS)
          .slice(0, PRESET_MAX_COUNT)
      : null
  const executor = clean(data?.executor)
  const reviewer = clean(data?.reviewer)
  if (executor === null || reviewer === null) return null
  return { executor, reviewer }
}

/** 读取用户自定义预设；新路径不存在时兼容旧版包内 data/presets.json。 */
function readUserPresets() {
  try {
    const primary = presetsFilePath()
    const fromPrimary = parseUserPresetsFile(primary)
    if (fromPrimary !== null) return fromPrimary
    // 迁移兼容：老版本写在包内 data/presets.json。
    return parseUserPresetsFile(join(PACKAGE_DATA_DIR, 'presets.json'))
  } catch {
    return null
  }
}

/** 原子写入用户预设（写到 profile 数据目录）。 */
function writeUserPresets(lists) {
  const target = presetsFilePath()
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, executor: lists.executor, reviewer: lists.reviewer }, null, 2) + '\n', 'utf8')
  renameSync(tmp, target)
}

/** 删除用户预设（同时清理新旧位置，恢复 config / 内置默认）。 */
function clearUserPresets() {
  for (const file of [presetsFilePath(), join(PACKAGE_DATA_DIR, 'presets.json')]) {
    try {
      if (existsSync(file)) unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
}

const DEFAULT_PRESETS = {
  executor: [
    '这个操作为什么必须执行？它和当前任务是什么关系？',
    '它会具体改动哪些文件、系统状态或账号状态？',
    '如果执行失败或结果不对，怎么回滚？影响范围有多大？',
    '有没有更小、更安全的替代做法，能达到同样的目的？',
    '如果现在不允许执行，后续任务还能继续吗？',
  ],
  reviewer: [
    '这次审查的结论和风险等级分别是什么意思？',
    '具体是哪条证据让你判定为需要人工确认？',
    '在什么条件下，我可以放心地允许这一次？',
    '如果允许执行，最坏的可能后果是什么？',
    '我要怎么调整操作（缩小范围、换方式）才能降低风险？',
  ],
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

function intIn(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}

function clip(text, max) {
  if (typeof text !== 'string') return ''
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function jsonText(value, max) {
  try {
    const rendered = JSON.stringify(value, null, 2)
    return clip(typeof rendered === 'string' ? rendered : '', max ?? 4000)
  } catch {
    return ''
  }
}

/** 稳定序列化（键排序），用于比较两次工具调用参数是否一致。 */
function canonicalJson(value) {
  const seen = new WeakSet()
  const walk = (input) => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input) ?? 'null'
    if (seen.has(input)) return '"[[cycle]]"'
    seen.add(input)
    if (Array.isArray(input)) return `[${input.map(walk).join(',')}]`
    const keys = Object.keys(input).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${walk(input[key])}`).join(',')}}`
  }
  try {
    return walk(value)
  } catch {
    return ''
  }
}

function normalizeArguments(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return {}
    try {
      return JSON.parse(trimmed)
    } catch {
      return { __raw: trimmed }
    }
  }
  return value === undefined ? {} : value
}

function textOfMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 用精确前缀找出审查请求四段材料里的某一段（缺失返回 ''）。 */
function reviewSection(rawUserText, name) {
  if (typeof rawUserText !== 'string' || rawUserText.length === 0) return ''
  const names = ['ENVIRONMENT', 'PROJECT_INSTRUCTIONS', 'FILTERED_HISTORY', 'PENDING_ACTION']
  const head = `${name}\n\n`
  let start
  if (rawUserText.startsWith(head)) start = head.length
  else {
    const token = `\n\n${head}`
    const index = rawUserText.indexOf(token)
    if (index < 0) return ''
    start = index + token.length
  }
  let end = rawUserText.length
  for (const other of names) {
    if (other === name) continue
    const token = `\n\n${other}\n\n`
    const index = rawUserText.indexOf(token, start)
    if (index >= 0 && index < end) end = index
  }
  return rawUserText.slice(start, end)
}

function parsePendingAction(rawUserText) {
  const section = reviewSection(rawUserText, 'PENDING_ACTION')
  if (section.length === 0) return null
  try {
    const value = JSON.parse(section)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return {
      mode: typeof value.mode === 'string' ? value.mode : 'native',
      name: typeof value.name === 'string' ? value.name : 'unknown',
      description: typeof value.description === 'string' ? value.description : '',
      parameters: value.parameters ?? null,
      arguments: value.arguments,
    }
  } catch {
    return null
  }
}

function parseReviewDecision(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const parse = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const risk = value.risk
    const decision = value.decision
    if (typeof risk !== 'string' || typeof decision !== 'string') return null
    return {
      risk,
      decision,
      ...(typeof value.reason === 'string' && value.reason.length > 0 ? { reason: value.reason } : {}),
    }
  }
  try {
    return parse(JSON.parse(trimmed))
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return parse(JSON.parse(trimmed.slice(start, end + 1)))
      } catch {
        return null
      }
    }
    return null
  }
}

function anySignal(signals) {
  const list = signals.filter((signal) => signal instanceof AbortSignal)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  const controller = new AbortController()
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

function looksLikeReviewRequest(options) {
  return Boolean(
    options &&
      typeof options === 'object' &&
      typeof options.system === 'string' &&
      options.system.startsWith(REVIEW_POLICY_PREFIX) &&
      Array.isArray(options.messages),
  )
}

function looksLikeMainRequest(options) {
  if (!options || typeof options !== 'object') return false
  if (options.system !== undefined) return false
  if (options.sessionId === undefined || options.sessionId === null) return false
  if (!Array.isArray(options.messages) || options.messages.length === 0) return false
  if (options.messages[0]?.role !== 'system') return false
  return Array.isArray(options.tools)
}

function hasSideSentinel(options) {
  const messages = options?.messages
  if (!Array.isArray(messages) || messages.length === 0) return false
  return textOfMessage(messages[messages.length - 1]).includes(SIDE_SENTINEL)
}

function summaryLine(text) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (oneLine.length <= CONTEXT_SUMMARY_MAX_CHARS) return oneLine
  return `${oneLine.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/* -------------------------------------------------------------------------- */
/* 主入口                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 安装宿主能力。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @param {object} config 插件配置
 * @param {{generation:number, log:{info:Function,warn:Function,error:Function}, describe:Function}} runtime 入口 shim 诊断信息
 * @returns {() => void} 释放函数（热重载/卸载时调用）
 */
export function apply(ctx, config, runtime) {
  const log = runtime?.log ?? {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
  }

  const cfg = {
    maxQuestionChars: intIn(config?.maxQuestionChars, 2000, 50, 8000),
    maxConcurrentJobs: intIn(config?.maxConcurrentJobs, 3, 1, 8),
    executorMaxTokens: intIn(config?.executorMaxTokens, 1200, 128, 8000),
    reviewerMaxTokens: intIn(config?.reviewerMaxTokens, 1200, 128, 8000),
    threadTtlMs: intIn(config?.threadTtlMs, 7_200_000, 60_000, 86_400_000),
    maxPendingPerSession: intIn(config?.maxPendingPerSession, 20, 1, 100),
    devTools: config?.devTools === true,
    devWatch: config?.devWatch === true,
    /** 用户数据目录覆盖（空 = 自动定位）。 */
    dataDir: typeof config?.dataDir === 'string' && config.dataDir.trim().length > 0 ? config.dataDir.trim() : null,
    /**
     * 审查 AI 能力：auto（按官方自动审查插件是否安装/启用自动检测，默认）/ on（强制显示）/ off（强制只问执行 AI）。
     */
    reviewerMode: normalizeReviewerMode(config?.reviewerMode),
    /**
     * 自动拒绝倒计时（可选集成 dsh-approval-timeout）的暂停策略：
     *   'on-send'  仅当用户真正开始提问时暂停（默认；打开面板不会动它）
     *   'on-open'  打开面板即暂停（更激进，适合“打开=人在”的场景）
     *   'off'      完全不动别人的倒计时，只保留面板里手动的「暂停倒计时」按钮
     */
    timeoutAutoPause: normalizeTimeoutAutoPause(config?.timeoutAutoPause),
    /** 图文上传总开关（false = 整块功能不存在）。 */
    attachmentsEnabled: config?.attachmentsEnabled !== false,
    /** 每问最多几张图。 */
    maxAttachmentsPerAsk: intIn(config?.maxAttachmentsPerAsk, 3, 1, 6),
    /** 单图字节上限（仍受附件服务 imageLimits 约束）。 */
    maxAttachmentBytes: intIn(config?.maxAttachmentBytes, MAX_ATTACHMENT_BODY_BYTES, 64 * 1024, 20 * 1024 * 1024),
    /** 每问图片原始字节总量上限。 */
    maxAskImageBytes: intIn(config?.maxAskImageBytes, 6 * 1024 * 1024, 0, 20 * 1024 * 1024),
    /** 同一审批下保留的附件引用上限。 */
    maxAttachmentsPerConsult: intIn(config?.maxAttachmentsPerConsult, 6, 1, 20),
    /** 审查侧是否也接收图片：auto（用户在该 tab 主动加图才发）/ on / off。 */
    attachmentForReviewer: normalizeAttachmentForReviewer(config?.attachmentForReviewer),
    /** devTools 自测用：true/false 强制倒计时集成可用性；null = 按插件检测。 */
    timeoutAvailableOverride: null,
    presets: normalizePresets(config?.presets),
  }

  configuredDataDir = cfg.dataDir
  /* 常用问题：用户文件 > config.presets > 内置默认；面板里编辑后写入 <dataDir>/presets.json。 */
  const configPresets = normalizePresets(config?.presets)
  let userPresets = readUserPresets()
  const applyEffectivePresets = () => {
    cfg.presets = userPresets === null ? configPresets : userPresets
  }
  applyEffectivePresets()

  /**
   * 官方 auto-review 的审查策略原文。来源：@deepseek-ai/dsh-experimental-auto-review
   * （MIT）。由 tests/extract-review-policy.mjs 原样抽取到 lib/review-policy.txt，
   * 避免手抄漂移；读取失败时退回一个最小的等价策略。
   */
  let REVIEW_POLICY_TEXT = ''
  try {
    REVIEW_POLICY_TEXT = readFileSync(new URL('./review-policy.txt', import.meta.url), 'utf8')
  } catch (error) {
    log.warn(`[approval-consult] review-policy.txt 读取失败，使用内置兜底策略: ${messageOf(error)}`)
    REVIEW_POLICY_TEXT = [
      'REVIEW_POLICY',
      'You are the authorization reviewer for exactly one pending tool call.',
      'Return exactly one JSON object: {"risk":"low|medium|high","decision":"allow|deny"} and optionally {"reason":"..."} only with deny.',
      'low: ordinary project-local reads/writes and analysis. medium: irreversible deletion, production access, permission/security changes, external sends. high: sensitive data exfiltration.',
      'Fail closed when effects are ambiguous. Write the reason value in Simplified Chinese.',
    ].join('\n')
  }

  /** 内置策略副本的来源：bundled = lib/review-policy.txt；captured = 从真实审查请求同步。 */
  let reviewPolicySource = 'bundled'
  function rememberReviewPolicy(system) {
    if (typeof system !== 'string' || system.length < 200) return
    if (system === REVIEW_POLICY_TEXT) return
    REVIEW_POLICY_TEXT = system
    reviewPolicySource = 'captured'
    log.info(`[approval-consult] review policy synced from live request (${system.length} chars)`)
  }

  /**
   * 状态容器。用 globalThis 做一层「热重载存活」：devWatch 重新加载 impl.js 时，
   * 旧实现的订阅会被释放，但 pending / 线程 / 捕获缓存都留在同一进程里，
   * 新实现直接复用 —— 否则用户会看到「审批还在，但咨询台说已结束」的不一致。
   */
  const STATE_KEY = '__DSH_APPROVAL_CONSULT_STATE_V1__'
  function createConsultState() {
    return {
      version: 1,
      /** sessionId -> { options, at, provider, model, messageCount, toolCount } */
      mainRequests: new Map(),
      /** sessionId -> review record[]（新→旧） */
      reviews: new Map(),
      /** `${sessionId}\u0000${callId}` -> exec record */
      execs: new Map(),
      /** consultKey -> pending record */
      pendings: new Map(),
      /** sessionId -> consultKey[]（旧→新） */
      pendingBySession: new Map(),
      /** jobId -> job */
      jobs: new Map(),
      /** uploadId -> 附件引用登记（图片只存引用，字节在 DSH 附件服务里） */
      attachments: new Map(),
      /** consultKey -> 进行中的上传预占数（先占名额再 saveImage，失败释放） */
      attachmentPending: new Map(),
      /** 侧调用 options 集合（对象身份），llm/stream 捕获器直接跳过 */
      sideOptions: new WeakSet(),
      /** 已被本插件包装/记录过的 options（避免根与 agent 两处监听重复处理） */
      wrappedOptions: new WeakSet(),
      /** agentId -> per-agent disposer[] */
      agentDisposers: new Map(),
      /** 递增序号 */
      seq: 0,
      stats: {
        mainRequests: 0,
        reviews: 0,
        execs: 0,
        pendings: 0,
        asks: 0,
        done: 0,
        failed: 0,
        injections: 0,
        sideCalls: 0,
        /** 侧调用中「模型只发工具调用、没有正文」而自动重试的次数。 */
        toolCallRetries: 0,
        /** 登记过的图片附件引用数（只计数，不含内容）。 */
        attachments: 0,
        swallowed: 0,
      },
      /** 最近 30 次 llm/stream 的分类摘要（只用于诊断，不含对话内容） */
      llmSeen: [],
      /** 最近 80 次 llm/stream 调用的原始摘要（诊断“为什么没捕获审查请求”）。 */
      llmAll: [],
      /** 最近 20 次 tools/pre-execute 的摘要（只用于诊断）。 */
      execSeen: [],
      lastError: null,
    }
  }

  const previousState = (() => {
    try {
      const value = globalThis[STATE_KEY]
      return value !== null && typeof value === 'object' && value.version === 1 ? value : null
    } catch {
      return null
    }
  })()

  let state
  if (previousState !== null) {
    state = previousState
    // 瞬态字段一律重建；旧 jobs 已被上一代 dispose 中止。
    state.jobs = new Map()
    state.attachmentPending = new Map()
    state.sideOptions = new WeakSet()
    state.wrappedOptions = new WeakSet()
    state.agentDisposers = new Map()
    state.llmSeen = []
    state.llmAll = []
    state.execSeen = []
    state.lastError = null
    for (const record of state.pendings.values()) {
      record.jobs = new Set()
      for (const target of ['executor', 'reviewer']) {
        for (const turn of record.threads[target] ?? []) {
          if (turn.status !== 'streaming') continue
          turn.status = 'cancelled'
          turn.error = '插件已热重载，本次回答已中止。'
        }
      }
    }
    log.info(
      `[approval-consult] reused state across reload: pendings=${state.pendings.size}, reviewSessions=${state.reviews.size}`,
    )
  } else {
    state = createConsultState()
    try {
      globalThis[STATE_KEY] = state
    } catch {
      /* ignore */
    }
  }

  const disposers = []
  /** 可选注入的权限预设服务（仅诊断用）。 */
  let permissionPresetsService = null
  const addDisposer = (dispose) => {
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  }
  const noteError = (scope, error) => {
    state.stats.swallowed += 1
    state.lastError = `${scope}: ${messageOf(error)}`
    log.warn(`[approval-consult] ${state.lastError}`)
  }
  const nextSeq = () => {
    state.seq += 1
    return state.seq
  }
  /** 带错误码的异常。 */
  const httpError = (status, code, message) => {
    const error = new Error(message)
    error.status = status
    error.code = code
    return error
  }

  /** 侧调用的输出预算：思考型模型会先消耗 reasoning token，预算过低会出现“只有思考没有正文”。 */
  const executorMaxTokens = Math.max(cfg.executorMaxTokens, 3000)
  const reviewerMaxTokens = Math.max(cfg.reviewerMaxTokens, 1800)

  /* ------------------------------------------------------------------ */
  /* 1. 捕获                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * llm/stream waterfall：透传所有 chunk，只旁路记录审查请求与主对话请求。
   * 绝不改写 options，绝不吞 chunk，也绝不把错误抛给调用方。
   *
   * 为什么同一个函数还要挂到每个 agent 的 ctx 上：llm/stream 的派发会按
   * LlmRuntime 所属的作用域过滤监听器；根上下文监听器能收到“主对话请求”，
   * 但 auto-review 这类在 agent 作用域里发起的审查调用可能只派发给该 agent 的
   * 监听器。两处都注册、用 WeakSet 去重，可同时覆盖两种派发路径。
   */
  function llmStreamListener(options, next) {
    try {
      if (options && typeof options === 'object') {
        try {
          state.llmAll.push({
            at: Date.now(),
            scope: scopeLabel(next),
            sessionId: options.sessionId === undefined || options.sessionId === null ? '' : String(options.sessionId),
            systemHead: typeof options.system === 'string' ? options.system.slice(0, 24) : '',
            messages: Array.isArray(options.messages) ? options.messages.length : 0,
            hasTools: Array.isArray(options.tools),
            side: state.sideOptions.has(options) || hasSideSentinel(options),
          })
          if (state.llmAll.length > 80) state.llmAll.shift()
        } catch {
          /* ignore debug ring errors */
        }
      }
      if (options && typeof options === 'object' && !state.sideOptions.has(options) && !hasSideSentinel(options)) {
        const isReview = looksLikeReviewRequest(options)
        const isMain = !isReview && looksLikeMainRequest(options)
        const alreadyWrapped = state.wrappedOptions.has(options)
        if (!alreadyWrapped && (isReview || isMain)) {
          state.llmSeen.push({
            at: Date.now(),
            kind: isReview ? 'review' : 'main',
            scope: scopeLabel(next),
            sessionId: options.sessionId === undefined || options.sessionId === null ? '' : String(options.sessionId),
            systemHead: typeof options.system === 'string' ? options.system.slice(0, 40) : '',
            messages: Array.isArray(options.messages) ? options.messages.length : 0,
            tools: Array.isArray(options.tools) ? options.tools.length : -1,
          })
          if (state.llmSeen.length > 60) state.llmSeen.shift()
        }
        if (isReview) {
          if (alreadyWrapped) return next()
          state.wrappedOptions.add(options)
          // 顺手用真实审查请求的 system 文本刷新内置策略副本：DSH 升级后官方策略变了也不会漂移。
          rememberReviewPolicy(options.system)
          return teeReview(options, next)
        }
        if (isMain && !alreadyWrapped) {
          state.wrappedOptions.add(options)
          rememberMainRequest(options)
        }
      }
    } catch (error) {
      noteError('llm-stream-capture', error)
    }
    return next()
  }

  /** 仅用于诊断的作用域标签。 */
  function scopeLabel() {
    return 'hook'
  }

  /** 记录主对话请求（每个 session 只保留最近一次）。 */
  function rememberMainRequest(options) {
    const sessionId = String(options.sessionId)
    state.mainRequests.delete(sessionId)
    state.mainRequests.set(sessionId, {
      options,
      at: Date.now(),
      provider: typeof options.provider === 'string' ? options.provider : '',
      model: typeof options.model === 'string' ? options.model : '',
      messageCount: Array.isArray(options.messages) ? options.messages.length : 0,
      toolCount: Array.isArray(options.tools) ? options.tools.length : 0,
    })
    state.stats.mainRequests += 1
    if (state.mainRequests.size > 200) {
      const oldest = state.mainRequests.keys().next().value
      if (oldest !== undefined) state.mainRequests.delete(oldest)
    }
  }

  /** 创建审查记录并把它包进透传生成器。 */
  function teeReview(options, next) {
    const record = {
      id: `rv:${nextSeq()}`,
      sessionId: String(options.sessionId ?? ''),
      provider: typeof options.provider === 'string' ? options.provider : '',
      model: typeof options.model === 'string' ? options.model : '',
      options,
      at: Date.now(),
      rawUserText: textOfMessage(options.messages?.[0]),
      text: '',
      usage: null,
      finishKind: null,
      decision: null,
      decisionText: '',
      error: null,
      claimedBy: null,
      action: null,
    }
    record.action = parsePendingAction(record.rawUserText)
    if (record.sessionId.length > 0) {
      const list = state.reviews.get(record.sessionId) ?? []
      list.push(record)
      list.sort((left, right) => right.at - left.at)
      if (list.length > 40) list.length = 40
      state.reviews.set(record.sessionId, list)
    }
    state.stats.reviews += 1
    let stream
    try {
      stream = next()
    } catch (error) {
      record.error = messageOf(error)
      throw error
    }
    return (async function* transparent() {
      try {
        for await (const chunk of stream) {
          try {
            consumeReviewChunk(record, chunk)
          } catch (error) {
            noteError('review-chunk', error)
          }
          yield chunk
        }
      } catch (error) {
        record.error = messageOf(error)
        throw error
      } finally {
        try {
          finalizeReview(record)
        } catch (error) {
          noteError('review-finalize', error)
        }
      }
    })()
  }

  function consumeReviewChunk(record, chunk) {
    if (!chunk || typeof chunk !== 'object') return
    switch (chunk.type) {
      case 'text-delta':
        if (typeof chunk.text === 'string') record.text += chunk.text
        break
      case 'block-end':
        if (chunk.block?.type === 'text' && typeof chunk.block.text === 'string' && record.text.length === 0) {
          record.text = chunk.block.text
        }
        break
      case 'usage':
        record.usage = chunk.usage ?? null
        break
      case 'finish':
        record.finishKind = chunk.reason?.kind ?? null
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
          record.error = messageOf(chunk.reason.failure)
        }
        break
      default:
        break
    }
  }

  function finalizeReview(record) {
    record.decisionText = record.text.trim()
    record.decision = parseReviewDecision(record.decisionText)
  }

  /** tools/pre-execute：只记录待执行的调用参数，然后原样放行。 */
  function preExecuteListener(exec, next) {
    try {
      recordExec(exec)
      const sessionId = exec?.agent?.session?.id === undefined ? '' : String(exec.agent.session.id)
      let preset = null
      try {
        preset = permissionPresetsService?.current?.(exec.agent.session) ?? null
      } catch {
        preset = null
      }
      state.execSeen.push({
        at: Date.now(),
        sessionId,
        name: typeof exec.name === 'string' ? exec.name : '',
        preset,
        parent: exec.parent !== undefined,
      })
      if (state.execSeen.length > 20) state.execSeen.shift()
    } catch (error) {
      noteError('pre-execute-capture', error)
    }
    return next()
  }

  function recordExec(exec) {
    const agent = exec?.agent
    const sessionId = agent?.session?.id === undefined ? undefined : String(agent.session.id)
    if (sessionId === undefined) return
    const callId = exec?.callId === undefined ? '' : String(exec.callId)
    if (callId.length === 0) return
    state.execs.set(`${sessionId}\u0000${callId}`, {
      sessionId,
      callId,
      name: typeof exec.name === 'string' ? exec.name : 'unknown',
      args: exec.arguments,
      hasSchema: Boolean(exec.schema),
      at: Date.now(),
      agent,
    })
    state.stats.execs += 1
    if (state.execs.size > 500) {
      const oldest = state.execs.keys().next().value
      if (oldest !== undefined) state.execs.delete(oldest)
    }
  }

  /**
   * approval/request waterfall（prepend）：在浏览器应答者之前登记 pending，让
   * /context 在用户看到审批卡片的同时就可用；最后原样返回 next() 的结果。
   */
  async function approvalListener(req, next) {
    let record = null
    try {
      record = recordPending(req)
    } catch (error) {
      noteError('approval-capture', error)
    }
    try {
      const outcome = await next()
      if (record !== null) finalizePending(record, outcome, null)
      return outcome
    } catch (error) {
      if (record !== null) finalizePending(record, null, error)
      throw error
    }
  }

  /** 用审批卡片上的 auto-review 结论合成一条“审查记录”（可继续追问）。 */
  function buildSyntheticReview(sessionId, exec, snapshot, verdict) {
    const main = state.mainRequests.get(sessionId)
    const provider = snapshot?.provider ?? main?.provider ?? null
    const model = snapshot?.model ?? main?.model ?? null
    const options = snapshot === null
      ? null
      : {
          provider: snapshot.provider,
          model: snapshot.model,
          sessionId,
          system: REVIEW_POLICY_TEXT,
          messages: [
            { role: 'user', content: [{ type: 'text', text: snapshot.userText }] },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    `REVIEWER_VERDICT (from the approval gate, authoritative): ${verdict.kind === 'deny' ? 'deny' : 'failed'}\n` +
                    verdict.text,
                },
              ],
            },
          ],
          temperature: 0,
        }
    return {
      id: `syn:${nextSeq()}`,
      sessionId,
      provider,
      model,
      options,
      at: Date.now(),
      rawUserText: snapshot?.userText ?? '',
      text: verdict.text,
      usage: null,
      finishKind: 'stop',
      decision: verdict.kind === 'deny' ? { risk: null, decision: 'deny', reason: verdict.text } : null,
      decisionText: clip(JSON.stringify({ source: 'approval-reason', kind: verdict.kind, reason: verdict.text }), 2000),
      error: verdict.kind === 'failed' ? `Auto review failed: ${verdict.text}` : null,
      claimedBy: null,
      action: snapshot?.action ?? null,
      advisory: false,
      synthetic: true,
    }
  }

  /** 登记一条 pending。 */
  function recordPending(req) {
    const agent = req?.agent
    const sessionId = agent?.session?.id === undefined ? undefined : String(agent.session.id)
    if (sessionId === undefined) return null
    const callId = req?.callId === undefined ? undefined : String(req.callId)
    const toolName = typeof req?.toolName === 'string' && req.toolName.length > 0 ? req.toolName : 'unknown'
    const exec = callId === undefined ? undefined : state.execs.get(`${sessionId}\u0000${callId}`)
    let review = matchReview(sessionId, toolName, exec, req?.reason)
    // 未捕获到审查请求，但审批理由里已经带着 auto-review 的结论：合成一条可追问的审查记录。
    let advisorySnapshot = null
    if (review === null) {
      advisorySnapshot = buildAdvisorySnapshot(agent, exec)
      const verdict = autoReviewVerdictFromReason(typeof req?.reason === 'string' ? req.reason : '')
      if (verdict !== null) review = buildSyntheticReview(sessionId, exec, advisorySnapshot, verdict)
    }
    const record = {
      key: `ac:${nextSeq()}`,
      sessionId,
      callId,
      toolName,
      reason: typeof req?.reason === 'string' ? req.reason : undefined,
      displayReason: req?.displayReason ?? undefined,
      agent,
      exec,
      review,
      /** 未能捕获官方审查请求时，按官方规则重建的材料（惰性使用）。 */
      advisorySnapshot: review === null ? advisorySnapshot ?? buildAdvisorySnapshot(agent, exec) : null,
      advisoryReview: null,
      startedAt: Date.now(),
      resolvedAt: null,
      outcome: null,
      error: null,
      threads: { executor: [], reviewer: [] },
      jobs: new Set(),
      relays: [],
    }
    if (review !== null) review.claimedBy = record.key
    state.pendings.set(record.key, record)
    const list = state.pendingBySession.get(sessionId) ?? []
    list.push(record.key)
    while (list.length > cfg.maxPendingPerSession) {
      const dropped = list.shift()
      if (dropped !== undefined) state.pendings.delete(dropped)
    }
    state.pendingBySession.set(sessionId, list)
    state.stats.pendings += 1
    log.info(
      `[approval-consult] pending ${record.key} tool=${toolName} session=${sessionId} review=${
        review === null ? 'none' : `${review.decision?.risk ?? '?'}/${review.decision?.decision ?? '?'}`
      }`,
    )
    return record
  }

  /**
   * 把这次审批和一条审查记录配对：只接受**可验证的关联**——参数完全一致，或审批理由里
   * 原样包含审查理由。工具名相同不再构成匹配依据，也不跨 session 猜测（安全审查 2026-11-03）。
   * 无法准确关联时返回 null，让面板显示「缺少审查材料」或对当前调用重新评估。
   */
  function matchReview(sessionId, toolName, exec, reason) {
    const list = state.reviews.get(sessionId)
    if (!Array.isArray(list) || list.length === 0) return null
    const candidates = list.filter((review) => review.claimedBy === null && review.error === null)
    if (candidates.length === 0) return null
    const execArgs = exec === undefined ? undefined : canonicalJson(exec.args)
    let best = null
    let bestScore = 0
    for (const review of candidates) {
      const action = review.action
      if (action === null) continue
      if (action.name !== toolName) continue
      const reviewArgs = canonicalJson(normalizeArguments(action.arguments))
      const argsKnown = execArgs !== undefined && reviewArgs.length > 0
      const sameArgs = argsKnown && reviewArgs === execArgs
      const reasonHit =
        typeof reason === 'string' &&
        typeof review.decision?.reason === 'string' &&
        review.decision.reason.length >= 12 &&
        reason.includes(review.decision.reason)
      // 参数已知且不一致：无论理由文字是否命中都不复用——理由文本不能替代调用身份。
      if (argsKnown && !sameArgs) continue
      // 参数未知时，才退化为「理由原样命中」这一弱证据；两者都无法核对则不复用。
      if (!sameArgs && !reasonHit) continue
      let score = 1
      if (reasonHit) score += 4
      if (sameArgs) score += 3
      if (review.decision !== null) score += 1
      if (score > bestScore || (score === bestScore && best !== null && review.at > best.at)) {
        best = review
        bestScore = score
      }
    }
    return best
  }

  /** pending 结束：记录结果、中止仍在流式输出的侧调用。 */
  function finalizePending(record, outcome, error) {
    if (record.resolvedAt !== null) return
    record.resolvedAt = Date.now()
    // kernel 超时/取消时 next() 可能返回 null：不能 String(null) 成 "null"（前端会把它当成结果标签）。
    const raw = outcome === null || outcome === undefined ? null : typeof outcome === 'string' ? outcome : String(outcome)
    record.outcome = raw === 'null' || raw === 'undefined' ? null : raw
    if (error !== null) record.error = messageOf(error)
    for (const jobId of [...record.jobs]) {
      const job = state.jobs.get(jobId)
      if (job === undefined) continue
      if (job.status !== 'streaming') continue
      job.status = 'cancelled'
      job.error = '审批已经结束，本次回答已中止。'
      job.entry.status = 'cancelled'
      job.entry.error = job.error
      try {
        job.controller.abort(new Error('approval resolved'))
      } catch {
        /* ignore */
      }
    }
    // 审批结束：中止仍在进行的「重新评估」，避免审批结束后继续计费（安全审查 2026-11-03）。
    for (const candidate of [record.review, record.advisoryReview]) {
      const classifyController = candidate?.classifyController ?? null
      if (classifyController === null) continue
      try {
        classifyController.abort(new Error('approval resolved'))
      } catch {
        /* ignore */
      }
    }
    log.info(`[approval-consult] pending ${record.key} resolved outcome=${String(record.outcome)}`)
    // 审批结束：立即失效该审批下的图片引用（字节仍由 DSH 附件服务保留，不在这里删）。
    try {
      dropAttachments(record.key)
    } catch (error) {
      noteError('drop-attachments', error)
    }
  }

  /* ------------------------------------------------------------------ */
  /* 2. 侧调用                                                          */
  /* ------------------------------------------------------------------ */

  /** 为「执行 AI」构造旁路请求：主对话请求原样 + 一条 user 消息（命中主对话缓存）。 */
  function buildExecutorOptions(record, question, job) {
    const main = state.mainRequests.get(record.sessionId)
    if (main === undefined) {
      throw httpError(409, 'executor-context-missing', '还没有捕获到执行 AI 的对话上下文（插件可能刚安装）。请先拒绝或允许本次审批，等下一轮再提问。')
    }
    const base = main.options
    const details = describePendingForPrompt(record)
    const assistantNote = lastAssistantText(record.agent)
    /** 随这条问题发送的图片（ImageBlock；放在最后一条 user 消息里，前缀不变）。 */
    const images = Array.isArray(job.attachments) ? job.attachments : []
    // 追问：把本线程里已经完成的问答按消息顺序补在请求末尾（首轮为空，前缀完全不变，
    // 因此首轮仍然最大程度命中主对话缓存；后续轮次只有追加部分不同）。
    const followUps = []
    for (const turn of record.threads.executor) {
      if (turn.id === job.threadId) continue
      if (turn.status !== 'done' || typeof turn.answer !== 'string' || turn.answer.trim().length === 0) continue
      followUps.push({ role: 'user', content: [{ type: 'text', text: turn.question }] })
      followUps.push({
        role: 'assistant',
        content: [{ type: 'text', text: clip(turn.answer, 2000) }],
        source: { kind: 'model', provider: base.provider, model: base.model },
      })
    }
    const text = [
      '【审批等待中的提问 —— 这不是新的任务指令】',
      '当前有一个工具调用正在等待用户审批，它还没有执行：',
      details,
      assistantNote.length === 0 ? '' : `你上一步的说明（供参考）：\n${clip(assistantNote, 1200)}`,
      '',
      '用户此刻的问题：',
      question,
      '',
      '请直接回答用户的问题：简体中文，具体、简洁，不要客套和免责声明堆砌。',
      '不要调用任何工具，不要继续原任务，也不要假设该工具已经执行。这次回答只用于帮助用户判断是否允许该调用。',
      '注意：这次是纯文本咨询，你没有可用的工具执行器——任何工具调用都不会被执行，只会让这次回答失败。',
      images.length === 0
        ? ''
        : `用户随这个问题附了 ${images.length} 张图片（已随本条消息发送，见下方图片）。请把图里的内容当作问题的一部分来读；如果图中看不清或不包含所需信息，直接说明，不要猜测。`,
      SIDE_SENTINEL,
    ]
      .filter((line) => line !== '')
      .join('\n')
    const options = {
      ...base,
      messages: [
        ...base.messages,
        ...followUps,
        {
          role: 'user',
          content: [{ type: 'text', text }, ...images.map((ref) => ({ type: 'image', attachment: ref }))],
        },
      ],
      maxTokens: executorMaxTokens,
      signal: anySignal([base.signal, job.controller.signal]),
    }
    delete options.purpose
    return options
  }

  /** 为「审查 AI」构造旁路请求：审查请求原样 + 它的结论 + 本线程问答回合。 */
  function buildReviewerOptions(record, question, job) {
    const review = record.review ?? record.advisoryReview ?? null
    if (review === null) {
      throw httpError(409, 'reviewer-context-missing', '本次审批没有可用的自动审查上下文（可能不是 auto-review 触发的，或审查调用失败）。')
    }
    const base = review.options
    const history = []
    const decisionText = review.decisionText.trim()
    if (decisionText.length > 0) {
      history.push({
        role: 'assistant',
        content: [{ type: 'text', text: decisionText }],
        source: { kind: 'model', provider: review.provider, model: review.model },
      })
    }
    for (const turn of record.threads.reviewer) {
      if (turn.id === job.threadId) continue
      if (turn.status !== 'done' || typeof turn.answer !== 'string' || turn.answer.trim().length === 0) continue
      history.push({ role: 'user', content: [{ type: 'text', text: turn.question }] })
      history.push({
        role: 'assistant',
        content: [{ type: 'text', text: clip(turn.answer, 2000) }],
        source: { kind: 'model', provider: review.provider, model: review.model },
      })
    }
    const summary =
      review.decision === null
        ? '（上次审查没有给出可解析的结论）'
        : `${review.decision.risk} / ${review.decision.decision}${
            review.decision.reason === undefined ? '' : `：${review.decision.reason}`
          }`
    const images = Array.isArray(job.attachments) ? job.attachments : []
    const askedImages = Number(job.askedAttachmentCount) || 0
    const text = [
      '用户正在审批这次工具调用，并想向你（自动审查 AI）进一步了解你的判断。',
      `你当时给出的审查结论是：${summary}`,
      '用户的问题：',
      question,
      '',
      '请基于同一份审查材料直接回答：简体中文，具体、简洁。',
      '这次只是解释与咨询：不要重新输出审查 JSON，不要输出任何 JSON 或代码块，不要调用任何工具；如果材料不足以回答，请明确说不确定、缺什么信息。',
      images.length === 0
        ? ''
        : `用户随这个问题附了 ${images.length} 张图片。它们只作为用户澄清用，不改变你当时的审查材料；结论仍以 PENDING_ACTION 与 FILTERED_HISTORY 为准。`,
      askedImages > 0 && images.length === 0
        ? `（用户附了 ${askedImages} 张图片，但本次只发给执行 AI；你按原审查材料回答即可。）`
        : '',
      SIDE_SENTINEL,
    ]
      .filter((line) => line !== '')
      .join('\n')
    const options = {
      ...base,
      messages: [
        ...base.messages,
        ...history,
        {
          role: 'user',
          content: [{ type: 'text', text }, ...images.map((ref) => ({ type: 'image', attachment: ref }))],
        },
      ],
      temperature: typeof base.temperature === 'number' ? base.temperature : 0,
      maxTokens: reviewerMaxTokens,
      signal: anySignal([base.signal, job.controller.signal]),
    }
    delete options.purpose
    return options
  }

  /** 把当前 pending 写成模型可读的几行说明。 */
  function describePendingForPrompt(record) {
    const args = pendingArguments(record)
    const lines = [`- 工具：${record.toolName}`]
    const argsText = jsonText(args, 2200)
    if (argsText.length > 0) lines.push(`- 参数：${argsText}`)
    const review = record.review
    if (review !== null) {
      if (review.decision !== null) {
        lines.push(
          `- 自动审查结论：${review.decision.risk} / ${review.decision.decision}` +
            (review.decision.reason === undefined ? '' : ` —— 理由：${clip(review.decision.reason, 800)}`),
        )
      } else if (review.error !== null) {
        lines.push(`- 自动审查调用失败：${clip(review.error, 300)}`)
      }
    }
    if (typeof record.reason === 'string' && record.reason.length > 0) {
      lines.push(`- 审批卡片上的说明：${clip(record.reason, 800)}`)
    }
    return lines.join('\n')
  }

  function pendingArguments(record) {
    if (record.exec !== undefined) return record.exec.args
    const action = record.review?.action
    if (action !== undefined && action !== null) return action.arguments
    return {}
  }

  /** 读 session 里最后一条 assistant 文本。 */
  function lastAssistantText(agent) {
    try {
      const session = agent?.session
      if (session === undefined || typeof session.snapshotEvents !== 'function') return ''
      const events = session.snapshotEvents()
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type !== 'assistant/message') continue
        const text = textOfMessage(event.data?.message).trim()
        if (text.length > 0) return text
      }
    } catch {
      /* 读日志失败不影响提问 */
    }
    return ''
  }

  /** 发起一次侧调用并流式收集结果。 */
  async function startAsk(input) {
    const record = resolvePending(input)
    if (record === null) throw httpError(409, 'no-pending', '没有找到这次待审批的调用：它可能已经被允许/拒绝，或者已经取消。')
    if (record.resolvedAt !== null) throw httpError(409, 'approval-resolved', '这次审批已经结束了，不能继续提问。')
    const target = input.target === 'reviewer' ? 'reviewer' : 'executor'
    if (target === 'reviewer' && !reviewerAvailable()) {
      throw httpError(409, 'reviewer-unavailable', '当前环境不支持咨询审查 AI，只能向执行 AI 提问。')
    }
    const question = String(input.question ?? '').trim()
    if (question.length === 0) throw httpError(400, 'empty-question', '问题不能为空。')
    if (question.length > cfg.maxQuestionChars) throw httpError(413, 'question-too-long', `问题太长（上限 ${cfg.maxQuestionChars} 字）。`)
    if (target === 'executor' && !state.mainRequests.has(record.sessionId)) {
      throw httpError(409, 'executor-context-missing', '还没有捕获到执行 AI 的对话上下文，暂时无法向它提问。')
    }
    if (target === 'reviewer') {
      const review = record.review ?? record.advisoryReview ?? null
      if (review === null) {
        if (record.advisorySnapshot === null || record.advisorySnapshot === undefined) {
          throw httpError(409, 'reviewer-context-missing', '本次审批没有可用的自动审查上下文，无法向审查 AI 提问。')
        }
        throw httpError(409, 'review-not-initialized', '审查材料已就绪，但还没有重新评估。请先点「让审查 AI 重新评估」，再继续提问。')
      }
      if (review.advisory === true && review.decision === null) {
        throw httpError(409, 'review-not-initialized', '审查材料已就绪，但还没有重新评估。请先点「让审查 AI 重新评估」，再继续提问。')
      }
      if (review.options === null || review.options === undefined) {
        throw httpError(409, 'reviewer-context-missing', '这条审查结论来自审批卡片本身，缺少可继续追问的审查材料。')
      }
    }
    const activeJobs = [...record.jobs].filter((jobId) => state.jobs.get(jobId)?.status === 'streaming').length
    if (activeJobs >= cfg.maxConcurrentJobs) {
      throw httpError(429, 'too-many-jobs', `同一审批下最多同时有 ${cfg.maxConcurrentJobs} 个回答在生成，请等其中一个结束。`)
    }

    /* ---- 图片附件：解析引用 → 能力复查 → 预算预检 ---- */
    const askedAttachmentCount = clampAttachmentIds(input.attachmentIds, cfg.maxAttachmentsPerAsk).length
    let attachmentRecords = []
    if (askedAttachmentCount > 0) {
      if (!cfg.attachmentsEnabled || attachmentStore === null) {
        throw httpError(409, 'attachment-unavailable', '当前环境不支持图片上传。')
      }
      const ids = clampAttachmentIds(input.attachmentIds, cfg.maxAttachmentsPerAsk)
      attachmentRecords = resolveAttachments(ids, record.key)
      if (attachmentRecords.length !== ids.length) {
        throw httpError(409, 'attachment-unknown', '有图片已经失效，请重新上传或去掉后重试。')
      }
      const caps = await attachmentCapabilities(record)
      if (target === 'executor' && caps.executor !== true) {
        throw httpError(409, 'model-no-image-input', '当前执行模型不支持图片输入，请去掉图片再提问。')
      }
      if (target === 'reviewer' && (cfg.attachmentForReviewer === 'off' || caps.reviewer !== true)) {
        // 审查侧不接收图片：纯文本继续，提示词里说明"用户附了图，只发给执行 AI"。
        attachmentRecords = []
      }
      if (attachmentRecords.length > 0) {
        const totalBytes = estimateAttachmentBytes(attachmentRecords.map((item) => ({ bytes: item.ref?.bytes })))
        if (cfg.maxAskImageBytes > 0 && totalBytes > cfg.maxAskImageBytes) {
          throw httpError(413, 'image-budget-exceeded', '这次附带的图片太大，请减少张数或压缩后重试。')
        }
      }
    }

    /* 上面的 await 会让出执行权：必须在不再 await 的临界段里重新核对审批状态与并发名额，
       否则多个并发请求会一起通过数量检查（安全审查 2026-11-03）。 */
    if (record.resolvedAt !== null) {
      throw httpError(409, 'approval-resolved', '这次审批已经结束了，不能继续提问。')
    }
    if (target === 'reviewer') {
      const reviewAfterAwait = record.review ?? record.advisoryReview ?? null
      if (reviewAfterAwait === null || reviewAfterAwait.options === null || reviewAfterAwait.options === undefined) {
        throw httpError(409, 'reviewer-context-missing', '本次审批的审查材料已失效，请重新评估后再提问。')
      }
      if (reviewAfterAwait.advisory === true && reviewAfterAwait.decision === null) {
        throw httpError(409, 'review-not-initialized', '审查材料已就绪，但还没有重新评估。请先点「让审查 AI 重新评估」，再继续提问。')
      }
    }
    const activeJobsAfterAwait = [...record.jobs].filter((jobId) => state.jobs.get(jobId)?.status === 'streaming').length
    if (activeJobsAfterAwait >= cfg.maxConcurrentJobs) {
      throw httpError(429, 'too-many-jobs', `同一审批下最多同时有 ${cfg.maxConcurrentJobs} 个回答在生成，请等其中一个结束。`)
    }

    const entry = {
      id: `q:${nextSeq()}`,
      question,
      answer: '',
      status: 'streaming',
      at: Date.now(),
      usage: null,
      error: null,
      injectedAt: null,
      relayedAt: null,
      /** 回答是否因为输出预算（finish reason = length）被截断。 */
      truncated: false,
      /** 对应 job id：客户端换页/重开面板后可以据此续订轮询。 */
      jobId: null,
      /** 这条问答附带的图片元数据（面板里渲染缩略图；不含字节）。 */
      attachments: attachmentRecords.map(attachmentMeta),
    }
    record.threads[target].push(entry)
    const job = {
      id: `j:${nextSeq()}`,
      consultKey: record.key,
      sessionId: record.sessionId,
      target,
      threadId: entry.id,
      question,
      text: '',
      usage: null,
      status: 'streaming',
      error: null,
      entry,
      /** 实际随这条问题发送的图片引用（ImageBlock 的 attachment）。 */
      attachments: attachmentRecords.map((item) => item.ref),
      /** 用户原本想附几张图（审查侧不接收时用来在提示词里说明）。 */
      askedAttachmentCount,
      controller: new AbortController(),
      createdAt: Date.now(),
      finishedAt: null,
    }
    state.jobs.set(job.id, job)
    record.jobs.add(job.id)
    entry.jobId = job.id
    state.stats.asks += 1
    void runJob(record, job, entry)
    return { jobId: job.id, threadId: entry.id, consultKey: record.key, target }
  }

  /** 执行一次侧调用。所有结果都落在 job/entry 上，绝不向 HTTP 层抛错。 */
  async function runJob(record, job, entry) {
    let options = null
    try {
      let attempt = 0
      let sawText = false
      let sawToolCall = false
      let finishKind = null
      for (;;) {
        options = job.target === 'reviewer' ? buildReviewerOptions(record, job.question, job) : buildExecutorOptions(record, job.question, job)
        if (attempt > 0) {
          // 上一轮模型只发了工具调用、没有正文：侧调用没有执行器，追加一条纠正消息再试一次。
          // 只追加在最末，前缀不变，仍然命中 prompt cache。
          options = {
            ...options,
            messages: [...options.messages, { role: 'user', content: [{ type: 'text', text: SIDE_TOOLCALL_CORRECTION }] }],
          }
        }
        job.text = ''
        job.usage = null
        job.error = null
        job.promptChars = promptCharsOf(options)
        state.sideOptions.add(options)
        state.stats.sideCalls += 1
        sawText = false
        sawToolCall = false
        finishKind = null
        const stream = ctx.llm.stream(options)
        for await (const chunk of stream) {
          if (job.controller.signal.aborted) break
          if (!chunk || typeof chunk !== 'object') continue
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            job.text += chunk.text
            sawText = sawText || chunk.text.length > 0
          } else if (chunk.type === 'block-end') {
            if (chunk.block?.type === 'text' && typeof chunk.block.text === 'string' && job.text.length === 0) {
              job.text = chunk.block.text
            } else if (chunk.block?.type === 'tool-call') {
              sawToolCall = true
            }
          } else if (chunk.type === 'usage') {
            job.usage = chunk.usage ?? null
          } else if (chunk.type === 'finish') {
            finishKind = chunk.reason?.kind ?? null
            if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
              job.error = `模型调用结束于 ${chunk.reason.kind}：${clip(messageOf(chunk.reason.failure), 300)}`
            }
          }
          entry.answer = job.text
        }
        entry.answer = job.text
        entry.truncated = finishKind === 'length'
        entry.usage = job.usage
        if (job.controller.signal.aborted) {
          job.status = 'cancelled'
          entry.status = 'cancelled'
          if (job.error === null) job.error = '回答已取消。'
          entry.error = job.error
          break
        }
        if (job.error !== null) {
          job.status = 'error'
          entry.status = 'error'
          entry.error = job.error
          state.stats.failed += 1
          break
        }
        if (!sawText && sawToolCall && attempt < SIDE_TOOLCALL_RETRIES) {
          // 模型把这次咨询当成任务、只发了工具调用：侧调用没有工具执行器，
          // 补一条纠正消息自动重试一次（对用户表现为「偶尔慢一点」，而不是一条错误）。
          attempt += 1
          job.toolCallRetries = attempt
          state.stats.toolCallRetries = (state.stats.toolCallRetries ?? 0) + 1
          continue
        }
        if (!sawText && sawToolCall) {
          job.status = 'error'
          entry.status = 'error'
          job.error = '模型两次都只尝试调用工具而没有给出正文（侧调用无法执行工具），请重试一次或换一种问法。'
          entry.error = job.error
          state.stats.failed += 1
          break
        }
        if (!sawText && job.text.trim().length === 0) {
          job.status = 'error'
          entry.status = 'error'
          job.error = '模型把输出预算都用在思考上了，没有产出正文。可以重试，或先直接做出决定。'
          entry.error = job.error
          state.stats.failed += 1
          break
        }
        job.status = 'done'
        entry.status = 'done'
        state.stats.done += 1
        break
        }
      entry.answer = job.text
      entry.usage = job.usage
    } catch (error) {
      if (job.controller.signal.aborted) {
        job.status = 'cancelled'
        entry.status = 'cancelled'
        job.error = '回答已取消。'
      } else {
        job.status = 'error'
        entry.status = 'error'
        job.error = friendlySideCallError(error)
        state.stats.failed += 1
        noteError('side-call', error)
      }
      entry.error = job.error
    } finally {
      if (options !== null) state.sideOptions.delete(options)
      job.finishedAt = Date.now()
      entry.answer = job.text
      // 执行 AI 的问答自动留存到会话（审查 AI 默认不写入）。
      if (job.status === 'done' && job.target === 'executor') {
        try {
          injectExecutorQa(record, entry)
        } catch (error) {
          entry.injectError = messageOf(error)
          noteError('inject-after-answer', error)
        }
      }
    }
  }

  function friendlySideCallError(error) {
    const message = messageOf(error)
    if (/context|token|too long|maximum/i.test(message)) {
      return `上下文超出模型限制，无法完成这次回答。可以试试更短的问题，或直接做出决定。原始错误：${clip(message, 240)}`
    }
    if (/abort|cancel/i.test(message)) return '回答已取消。'
    return `回答失败：${clip(message, 400)}`
  }

  /* ------------------------------------------------------------------ */
  /* 2.5 审查上下文兜底（未能捕获官方审查请求时）                         */
  /* ------------------------------------------------------------------ */

  /**
   * 官方 auto-review 在每次工具调用前会用固定策略 + 四段材料做审查。我们的主路径是
   * 在 llm/stream 里直接捕获那次请求（零成本、100% 一致）。但有些审批不是 auto-review
   * 触发的（例如 sandbox 升级），或者审查请求没有出现在我们的监听路径上。
   *
   * 这种情况下，按官方 snapshotAutoReview 的规则从 session 日志重建同样的四段材料：
   *   ENVIRONMENT / PROJECT_INSTRUCTIONS / FILTERED_HISTORY / PENDING_ACTION
   * 用户点「让审查 AI 重新评估」时，用同一份 REVIEW_POLICY 跑一次分类，得到
   * risk/decision/reason；之后的问答复用这份材料（与官方审查的上下文形状一致）。
   */
  function buildAdvisorySnapshot(agent, exec) {
    try {
      const session = agent?.session
      if (session === undefined || exec === undefined) return null
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      if (!Array.isArray(events) || events.length === 0) return null
      const surfaceNodes = Array.isArray(session.surface?.nodes) ? [...session.surface.nodes] : []
      const bySeq = new Map()
      for (const event of events) if (event !== undefined && event.seq !== undefined) bySeq.set(event.seq, event)
      const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
      let provider = header?.config?.provider ?? ''
      let model = header?.config?.model ?? ''
      if (provider.length === 0 || model.length === 0) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]
          if (event?.type !== 'request/header') continue
          provider = event.data?.header?.config?.provider ?? provider
          model = event.data?.header?.config?.model ?? model
          break
        }
      }
      const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : ''
      const parentSession = session.header?.parentSession
      const currentCallId = exec.callId === undefined ? '' : String(exec.callId)
      const rootCallId = exec.rootCallId === undefined ? currentCallId : String(exec.rootCallId)
      const projectInstructions = []
      const history = []
      for (const seq of surfaceNodes) {
        const event = bySeq.get(seq)
        if (event === undefined) continue
        if (event.type === 'user/message') {
          const source = event.data?.source
          const content = Array.isArray(event.data?.content) ? event.data.content : []
          if (source?.kind === 'tool') continue
          if (source?.kind === 'agent-instructions') {
            if (content.length > 0) projectInstructions.push({ kind: 'user-message', role: 'constraint', source, content })
            continue
          }
          const role = advisoryRoleOf(source, parentSession)
          for (const block of content) history.push({ kind: 'user-message', role, source, content: [block] })
          continue
        }
        if (event.type !== 'assistant/message') continue
        const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
        for (const block of content) {
          if (block?.type !== 'tool-call') continue
          if (String(block.id) === rootCallId) continue
          history.push({ kind: 'tool-call', role: 'fact', mode: 'native', name: block.name, arguments: block.arguments })
        }
      }
      for (const event of events) {
        if (event?.type !== 'tool/ptc-dispatch-start') continue
        if (event.data?.subCallId === undefined || String(event.data.subCallId) === currentCallId) continue
        history.push({
          kind: 'tool-call',
          role: 'fact',
          mode: 'ptc-inner',
          name: typeof event.data.name === 'string' ? event.data.name : 'unknown',
          arguments: jsonText(event.data.arguments ?? {}, 4000),
        })
      }
      let action
      if (exec.parent === undefined) {
        const tools = Array.isArray(header?.tools) ? header.tools : []
        const schema = tools.find((candidate) => candidate?.name === exec.name)
        action = {
          mode: 'native',
          name: exec.name,
          description: typeof schema?.description === 'string' ? schema.description : '',
          parameters: schema?.parameters ?? {},
          arguments: exec.arguments,
        }
      } else {
        const schema = exec.schema
        action = {
          mode: 'ptc-inner',
          name: exec.name,
          description: typeof schema?.description === 'string' ? schema.description : '',
          parameters: schema?.parameters ?? {},
          arguments: jsonText(exec.arguments ?? {}, 4000),
        }
      }
      const userText = [
        'ENVIRONMENT',
        jsonText({ cwd }, 800),
        'PROJECT_INSTRUCTIONS',
        jsonText(projectInstructions, 12000),
        'FILTERED_HISTORY',
        jsonText(history, 120000),
        'PENDING_ACTION',
        jsonText(action, 12000),
      ].join('\n\n')
      return { provider, model, cwd, userText, action, historyCount: history.length }
    } catch (error) {
      noteError('advisory-snapshot', error)
      return null
    }
  }

  /** 与官方 auto-review 相同的来源角色判定（当前实现允许的四种角色）。 */
  function advisoryRoleOf(source, parentSession) {
    if (source?.kind === 'user' && typeof source.rpcId === 'string') return 'human-instruction'
    if (source?.kind === 'agent-message' && parentSession !== undefined && source.senderSessionId === parentSession) {
      return 'direct-parent-instruction'
    }
    if (source?.kind === 'compact-checkpoint') return 'checkpoint'
    return 'fact'
  }

  /** 为一条 pending 惰性创建“临时审查记录”（尚未分类）。 */
  function ensureAdvisoryReview(record) {
    if (record.review !== null) return record.review
    if (record.advisoryReview !== undefined && record.advisoryReview !== null) return record.advisoryReview
    const snapshot = record.advisorySnapshot
    if (snapshot === null || snapshot === undefined) return null
    const review = {
      id: `adv:${nextSeq()}`,
      sessionId: record.sessionId,
      provider: snapshot.provider,
      model: snapshot.model,
      options: {
        provider: snapshot.provider,
        model: snapshot.model,
        sessionId: record.sessionId,
        system: REVIEW_POLICY_TEXT,
        messages: [{ role: 'user', content: [{ type: 'text', text: snapshot.userText }] }],
        temperature: 0,
      },
      at: Date.now(),
      rawUserText: snapshot.userText,
      text: '',
      usage: null,
      finishKind: null,
      decision: null,
      decisionText: '',
      error: null,
      claimedBy: record.key,
      action: snapshot.action,
      advisory: true,
    }
    record.advisoryReview = review
    return review
  }

  /** 用官方策略跑一次“重新评估”，把结论记到临时审查记录上。 */
  async function classifyAdvisoryReview(record) {
    const review = ensureAdvisoryReview(record)
    if (review === null) throw httpError(409, 'reviewer-context-missing', '本次审批没有可用的审查材料。')
    if (review.decision !== null) {
      return { review, reused: true }
    }
    if (record.resolvedAt !== null && record.resolvedAt !== undefined) {
      throw httpError(409, 'approval-resolved', '这次审批已经结束了，不能继续重新评估。')
    }
    // 同一条记录只允许一个进行中的评估：重复请求共享同一个 Promise，避免重复计费与输出混合。
    if (review.classifyPromise !== undefined && review.classifyPromise !== null) {
      await review.classifyPromise
      return { review, reused: true }
    }
    const task = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('advisory review timeout')), 90_000)
      review.classifyController = controller
      // 每次尝试使用独立缓冲：上一次失败留下的半截输出/错误不能污染本次结果。
      let text = ''
      let error = null
      let usage = null
      let finishKind = null
      const options = {
        ...review.options,
        maxTokens: 1800,
        signal: controller.signal,
      }
      state.sideOptions.add(options)
      state.stats.sideCalls += 1
      try {
        for await (const chunk of ctx.llm.stream(options)) {
          if (!chunk || typeof chunk !== 'object') continue
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string' && text.length === 0) text = chunk.block.text
          else if (chunk.type === 'usage') usage = chunk.usage ?? null
          else if (chunk.type === 'finish') {
            finishKind = chunk.reason?.kind ?? null
            if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') error = messageOf(chunk.reason.failure)
          }
        }
        review.text = text
        review.decisionText = text.trim()
        review.decision = parseReviewDecision(review.decisionText)
        if (review.decision === null && error === null) {
          error = `审查输出无法解析：${clip(review.decisionText, 200)}`
        }
      } catch (thrown) {
        review.text = text
        error = friendlySideCallError(thrown)
        noteError('advisory-classify', thrown)
      } finally {
        review.error = error
        review.usage = usage
        review.finishKind = finishKind
        clearTimeout(timer)
        state.sideOptions.delete(options)
        review.classifyController = null
      }
    })()
    review.classifyPromise = task
    try {
      await task
    } finally {
      review.classifyPromise = null
    }
    return { review, reused: false }
  }

  /** 序列化“重新评估”的结果。 */
  function serializeAdvisoryResult(review, reused) {
    return {
      ok: review.decision !== null,
      advisory: true,
      reused,
      risk: review.decision?.risk ?? null,
      decision: review.decision?.decision ?? null,
      reason: review.decision?.reason ?? null,
      decisionText: clip(review.decisionText, 2000),
      usage: review.usage,
      error: review.error,
      elapsedMs: null,
    }
  }

  /* ------------------------------------------------------------------ */
  /* 3. 注入到会话                                                       */
  /* ------------------------------------------------------------------ */

  /** 把一次执行 AI 问答注入会话（进入模型下一步请求 + 在 Chat 里显示为上下文行）。 */
  function injectExecutorQa(record, entry) {
    if (entry.injectedAt !== null) return
    if (typeof entry.answer !== 'string' || entry.answer.trim().length === 0) return
    const agent = liveAgent(record)
    if (agent === null) throw new Error('执行 AI 已经不在线，无法保存到会话')
    const text = [
      '【审批咨询记录 · 用户在等待审批期间向你提问，你已作答】',
      `审批对象：${record.toolName}`,
      describePendingForPrompt(record),
      '',
      `用户的问题：${clip(entry.question, 1000)}`,
      `你的回答：${clip(entry.answer, 4000)}`,
      entry.truncated === true ? '（注意：该回答因输出长度限制被截断，以上是已生成的部分。）' : '',
      '',
      '以上问答发生在该工具调用执行之前，用户当时尚未做出决定。请把用户关注的点纳入后续处理；如果用户随后拒绝，不要绕过这个决定。',
    ]
      .filter((line) => line !== '')
      .join('\n')
    const message = makeInjectedMessage(text, {
      kind: INJECT_SOURCE_KIND,
      form: 'notice',
      summary: summaryLine(`审批咨询：用户就 ${record.toolName} 向你提问并已得到回答`),
      consultKey: record.key,
      phase: 'qa',
    })
    if (typeof agent.inject !== 'function') throw new Error('当前 agent 不支持注入上下文')
    agent.inject(message)
    entry.injectedAt = Date.now()
    state.stats.injections += 1
    log.info(`[approval-consult] injected executor Q&A for ${record.key}`)
  }

  /** 构造一条可注入的 user-role 上下文消息。 */
  function makeInjectedMessage(text, sourceExtra) {
    const source = { kind: INJECT_SOURCE_KIND, ...sourceExtra }
    try {
      return { role: 'user', id: randomUUID(), content: [{ type: 'text', text }], source }
    } catch {
      return { role: 'user', id: `ac-${Date.now()}-${Math.random().toString(16).slice(2)}`, content: [{ type: 'text', text }], source }
    }
  }

  /** 取 session 当前仍然在线的 agent。 */
  function liveAgent(record) {
    const direct = record.agent
    try {
      if (direct !== undefined && direct !== null && direct.session?.id !== undefined) {
        if (direct.status === 'idle' || direct.status === 'running') return direct
      }
    } catch {
      /* 继续走注册表 */
    }
    try {
      const fromRegistry = ctx.agents.get(record.sessionId)
      if (fromRegistry !== undefined && fromRegistry !== null) return fromRegistry
    } catch {
      /* ignore */
    }
    return null
  }

  /** 用户主动「转达给执行 AI」：把审查 AI 的回答 / 用户备注写进会话（仅限审批等待期间）。 */
  function relayToExecutor(input) {
    const record = resolvePending(input)
    if (record === null) throw httpError(409, 'no-pending', '没有找到这次待审批的调用。')
    if (record.resolvedAt !== null) {
      throw httpError(409, 'approval-resolved', '本次审批已经结束，转达按钮已关闭；结束后的咨询记录只支持回看。')
    }
    const agent = liveAgent(record)
    if (agent === null) throw httpError(409, 'agent-offline', '执行 AI 已经不在线，无法转达。')
    const kind = input.kind === 'decision' ? 'decision' : input.kind === 'note' ? 'note' : 'reviewer'
    const text = String(input.text ?? '').trim()
    if (text.length === 0) throw httpError(400, 'empty-text', '要转达的内容不能为空。')
    if (text.length > 8000) throw httpError(413, 'text-too-long', '要转达的内容太长（上限 8000 字）。')
    const header =
      kind === 'reviewer'
        ? '【用户转达了自动审查 AI 的回答 · 请据此调整后续行动，但这不改变你收到的任务指令】'
        : kind === 'decision'
          ? '【用户在做出审批决定时的说明】'
          : '【用户补充说明】'
    const turn = typeof input.threadId === 'string' ? record.threads.reviewer.find((item) => item.id === input.threadId) : undefined
    const bodyLines = [header, `审批对象：${record.toolName}`, describePendingForPrompt(record), '', text]
    if (turn?.truncated === true) bodyLines.push('', '（注意：以上回答因输出长度限制被截断，并非完整回答。）')
    const body = bodyLines.join('\n')
    const message = makeInjectedMessage(body, {
      kind: INJECT_SOURCE_KIND,
      form: 'notice',
      summary: summaryLine(`审批咨询：用户转达了关于 ${record.toolName} 的说明`),
      consultKey: record.key,
      phase: kind,
    })
    agent.inject(message)
    state.stats.injections += 1
    record.relays.push({ kind, at: Date.now(), length: text.length })
    if (turn !== undefined) turn.relayedAt = Date.now()
    return { injected: true, kind }
  }

  /* ------------------------------------------------------------------ */
  /* 4. 查询与序列化                                                     */
  /* ------------------------------------------------------------------ */

  /** 按 consultKey 或 sessionId + callId/toolName 找到 pending（必要时从会话日志重建）。 */
  function resolvePending(input) {
    const key = typeof input?.consultKey === 'string' ? input.consultKey : ''
    if (key.length > 0) {
      const direct = state.pendings.get(key)
      if (direct !== undefined) return direct
    }
    const sessionId = input?.sessionId === undefined || input.sessionId === null ? '' : String(input.sessionId)
    if (sessionId.length === 0) return null
    const callId = input?.callId === undefined || input.callId === null ? '' : String(input.callId)
    const toolName = typeof input?.toolName === 'string' ? input.toolName : ''
    const keys = state.pendingBySession.get(sessionId)
    if (!Array.isArray(keys) || keys.length === 0) {
      const rebuilt = reconstructPending(sessionId, callId.length > 0 ? callId : undefined, toolName.length > 0 ? toolName : undefined)
      if (rebuilt !== null) refreshReconstructed(rebuilt)
      return rebuilt
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const record = state.pendings.get(keys[index])
      if (record === undefined || record.resolvedAt !== null) continue
      if (callId.length > 0) {
        if (record.callId === callId) return record
        continue
      }
      if (toolName.length > 0) {
        if (record.toolName === toolName) return record
        continue
      }
      return record
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const record = state.pendings.get(keys[index])
      if (record === undefined) continue
      if (callId.length > 0 && record.callId !== callId) continue
      if (callId.length === 0 && toolName.length > 0 && record.toolName !== toolName) continue
      return record
    }
    // 记录可能因插件热重载/重启丢失：从会话日志里的 approval/asked（尚无 approval/decided）重建。
    const rebuilt = reconstructPending(sessionId, callId.length > 0 ? callId : undefined, toolName.length > 0 ? toolName : undefined)
    if (rebuilt !== null) refreshReconstructed(rebuilt)
    return rebuilt
  }

  /**
   * 重建出来的记录没有连接到 approval/request 的 next()，需要自己看日志确认是否已经有结果，
   * 否则用户一旦在别处决定，面板会一直停在“等待审批”。
   */
  function refreshReconstructed(record) {
    if (record.reconstructed !== true || record.resolvedAt !== null) return
    if (record.approvalId === undefined) return
    try {
      const agent = liveAgentBySessionId(record.sessionId)
      if (agent === null || typeof agent.session?.snapshotEvents !== 'function') return
      const events = agent.session.snapshotEvents()
      for (const event of events) {
        if (event?.type !== 'approval/decided') continue
        if (event.data?.id === undefined || String(event.data.id) !== record.approvalId) continue
        record.resolvedAt = Date.now()
        record.outcome = typeof event.data?.outcome === 'string' ? event.data.outcome : null
        return
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * 从会话日志重建一条仍在等待的审批记录。
   * 这是 /context 的兜底：审批由宿主（approval 服务）维护，可能比插件的内存记录活得更久；
   * 只要日志里存在没有对应 approval/decided 的 approval/asked，就说明它还在等待。
   */
  function reconstructPending(sessionId, callId, toolName) {
    try {
      const agent = liveAgentBySessionId(sessionId)
      if (agent === null || typeof agent.session?.snapshotEvents !== 'function') return null
      const events = agent.session.snapshotEvents()
      if (!Array.isArray(events) || events.length === 0) return null
      const decided = new Set()
      for (const event of events) {
        if (event?.type !== 'approval/decided') continue
        if (event.data?.id !== undefined) decided.add(String(event.data.id))
      }
      let asked = null
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type !== 'approval/asked') continue
        if (event.data?.id !== undefined && decided.has(String(event.data.id))) continue
        const eventCallId = event.data?.callId === undefined ? undefined : String(event.data.callId)
        if (callId !== undefined && eventCallId !== callId) continue
        if (callId === undefined && toolName !== undefined && event.data?.toolName !== toolName) continue
        asked = event
        break
      }
      if (asked === null) return null
      const resolvedCallId = asked.data?.callId === undefined ? undefined : String(asked.data.callId)
      let exec = undefined
      if (resolvedCallId !== undefined) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]
          if (event?.type !== 'tool/call') continue
          if (event.data?.callId === undefined || String(event.data.callId) !== resolvedCallId) continue
          let args = event.data?.arguments
          try {
            if (typeof args === 'string') args = JSON.parse(args)
          } catch {
            /* 保留原始字符串，用于展示 */
          }
          exec = {
            sessionId,
            callId: resolvedCallId,
            name: typeof event.data?.name === 'string' ? event.data.name : asked.data?.toolName ?? 'unknown',
            args,
            at: event.time ?? Date.now(),
            agent,
          }
          break
        }
      }
      const resolvedToolName = typeof asked.data?.toolName === 'string' ? asked.data.toolName : toolName ?? 'unknown'
      const review = matchReview(sessionId, resolvedToolName, exec, asked.data?.reason)
      const record = {
        key: `re:${nextSeq()}`,
        approvalId: asked.data?.id === undefined ? undefined : String(asked.data.id),
        sessionId,
        callId: resolvedCallId,
        toolName: resolvedToolName,
        reason: typeof asked.data?.reason === 'string' ? asked.data.reason : undefined,
        displayReason: undefined,
        agent,
        exec,
        review,
        advisorySnapshot: review === null ? buildAdvisorySnapshot(agent, exec) : null,
        advisoryReview: null,
        startedAt: typeof asked.time === 'number' ? asked.time : Date.now(),
        resolvedAt: null,
        outcome: null,
        error: null,
        reconstructed: true,
        threads: { executor: [], reviewer: [] },
        jobs: new Set(),
        relays: [],
      }
      if (review !== null) review.claimedBy = record.key
      state.pendings.set(record.key, record)
      const list = state.pendingBySession.get(sessionId) ?? []
      list.push(record.key)
      while (list.length > cfg.maxPendingPerSession) {
        const dropped = list.shift()
        if (dropped !== undefined) state.pendings.delete(dropped)
      }
      state.pendingBySession.set(sessionId, list)
      log.info(`[approval-consult] reconstructed pending ${record.key} from session log (tool=${resolvedToolName})`)
      return record
    } catch (error) {
      noteError('reconstruct-pending', error)
      return null
    }
  }

  function reviewerAvailability(record) {
    const review = record.review ?? record.advisoryReview ?? null
    if (review !== null) {
      return {
        available: true,
        failed: review.error !== null,
        error: review.error,
        ...(review.advisory === true ? { advisory: true } : {}),
      }
    }
    if (record.advisorySnapshot !== null && record.advisorySnapshot !== undefined) {
      return {
        available: true,
        advisory: true,
        needsClassification: true,
        action: record.advisorySnapshot.action,
        historyCount: record.advisorySnapshot.historyCount,
        hint: '没有捕获到官方审查请求，但有足够的材料让审查 AI 重新评估这次调用。',
      }
    }
    const list = state.reviews.get(record.sessionId)
    if (!Array.isArray(list) || list.length === 0) {
      return {
        available: false,
        reason: 'no-review-captured',
        hint: '本次审批没有自动审查记录：可能是别的机制触发的审批，或插件在审查之后才加载。',
      }
    }
    return {
      available: false,
      reason: 'review-not-matched',
      hint: '捕获到过自动审查，但没能和这次审批配对（常见于并行审批）。重启后重新触发一次审批即可。',
    }
  }

  function serializePending(record) {
    return {
      consultKey: record.key,
      toolName: record.toolName,
      callId: record.callId ?? null,
      reason: record.reason ?? null,
      displayReason: record.displayReason ?? null,
      startedAt: record.startedAt,
      resolved: record.resolvedAt !== null,
      resolvedAt: record.resolvedAt,
      outcome: record.outcome,
      error: record.error,
    }
  }

  function serializeExecutor(record) {
    const main = state.mainRequests.get(record.sessionId)
    const argumentsValue = pendingArguments(record)
    return {
      available: main !== undefined,
      provider: main?.provider ?? null,
      model: main?.model ?? null,
      messageCount: main?.messageCount ?? 0,
      toolCount: main?.toolCount ?? 0,
      capturedAt: main?.at ?? null,
      argumentsPreview: jsonText(argumentsValue, 2400),
      toolDescription: record.review?.action?.description ?? null,
      assistantNote: clip(lastAssistantText(record.agent), 1600),
    }
  }

  function serializeReviewer(record) {
    const availability = reviewerAvailability(record)
    const review = record.review ?? record.advisoryReview ?? null
    if (review === null) return availability
    return {
      ...availability,
      advisory: review.advisory === true,
      synthetic: review.synthetic === true,
      classified: review.decision !== null,
      provider: review.provider,
      model: review.model,
      capturedAt: review.at,
      risk: review.decision?.risk ?? null,
      decision: review.decision?.decision ?? null,
      reason: review.decision?.reason ?? null,
      decisionText: clip(review.decisionText, 2000),
      finishKind: review.finishKind,
      usage: review.usage,
      action:
        review.action === null
          ? null
          : {
              mode: review.action.mode,
              name: review.action.name,
              description: clip(review.action.description, 1200),
              parameters: review.action.parameters,
            },
      historyCount: countReviewHistory(review.rawUserText),
    }
  }

  function countReviewHistory(rawUserText) {
    const section = reviewSection(rawUserText, 'FILTERED_HISTORY')
    if (section.length === 0) return 0
    try {
      const value = JSON.parse(section)
      return Array.isArray(value) ? value.length : 0
    } catch {
      return 0
    }
  }

  function serializeThreads(record) {
    const map = (list) =>
      list.map((turn) => ({
        id: turn.id,
        question: turn.question,
        answer: turn.answer,
        status: turn.status,
        at: turn.at,
        usage: turn.usage,
        error: turn.error ?? null,
        injectedAt: turn.injectedAt ?? null,
        relayedAt: turn.relayedAt ?? null,
        injectError: turn.injectError ?? null,
        truncated: turn.truncated === true,
        jobId: turn.jobId ?? null,
        /** 这条问答附带的图片元数据（只读渲染缩略图；不含字节）。 */
        attachments: Array.isArray(turn.attachments) ? turn.attachments : [],
      }))
    return { executor: map(record.threads.executor), reviewer: map(record.threads.reviewer) }
  }

  /**
   * 官方 auto-review 插件在 profile 中是否已安装并启用。
   * 找不到 registry 或插件未加载时返回 false —— 这种时候咨询台降级为“只问执行 AI”。
   */
  function reviewPluginInstalled() {
    try {
      const registry = Reflect.get(ctx, 'registry')
      if (registry !== null && registry !== undefined && typeof registry.values === 'function') {
        for (const runtime of registry.values()) {
          if (!isAutoReviewPluginName(runtime?.name)) continue
          const fibers = runtime?.fibers
          if (fibers !== undefined && typeof fibers.length === 'number' && fibers.length === 0) continue
          return true
        }
      }
    } catch (error) {
      noteError('detect-review-plugin', error)
    }
    return false
  }

  /** 官方/第三方自动拒绝倒计时插件（dsh-approval-timeout）是否已安装并启用。 */
  function timeoutPluginInstalled() {
    try {
      const registry = Reflect.get(ctx, 'registry')
      if (registry !== null && registry !== undefined && typeof registry.values === 'function') {
        for (const runtime of registry.values()) {
          if (!isTimeoutPluginName(runtime?.name)) continue
          const fibers = runtime?.fibers
          if (fibers !== undefined && typeof fibers.length === 'number' && fibers.length === 0) continue
          return true
        }
      }
    } catch (error) {
      noteError('detect-timeout-plugin', error)
    }
    return false
  }

  /** 倒计时集成是否可用（devTools 可临时覆盖，用于适配自测）。 */
  function timeoutAvailable() {
    if (cfg.timeoutAvailableOverride === true) return true
    if (cfg.timeoutAvailableOverride === false) return false
    return timeoutPluginInstalled()
  }

  /** 审查 AI 能力是否可用：默认按插件检测，也可用 config.reviewerMode 强制 on/off。 */
  function reviewerAvailable() {
    if (cfg.reviewerMode === 'on') return true
    if (cfg.reviewerMode === 'off') return false
    return reviewPluginInstalled()
  }

  async function buildContextResponse(query) {
    const record = resolvePending(query)
    const reviewAvailable = reviewerAvailable()
    const attachmentCaps = await attachmentCapabilities(record)
    if (record === null) {
      return {
        ok: true,
        pending: null,
        hint: '当前没有可咨询的待审批调用。',
        presets: cfg.presets,
        limits: { maxQuestionChars: cfg.maxQuestionChars, maxConcurrentJobs: cfg.maxConcurrentJobs },
        features: {
          ask: true,
          followUp: true,
          relay: true,
          decision: true,
          compare: reviewAvailable,
          timeoutAutoPause: cfg.timeoutAutoPause,
          reviewerAvailable: reviewAvailable,
          timeoutAvailable: timeoutAvailable(),
          attachments: attachmentCaps,
        },
      }
    }
    const threadSnapshots = serializeThreads(record)
    if (!reviewAvailable) threadSnapshots.reviewer = []
    return {
      ok: true,
      serverTime: Date.now(),
      consultKey: record.key,
      pending: serializePending(record),
      executor: serializeExecutor(record),
      // 没装自动审查插件时不暴露审查侧内容，客户端会隐藏整个审查 tab。
      reviewer: reviewAvailable ? serializeReviewer(record) : null,
      threads: threadSnapshots,
      relays: record.relays.length,
      presets: cfg.presets,
      limits: {
        maxQuestionChars: cfg.maxQuestionChars,
        maxConcurrentJobs: cfg.maxConcurrentJobs,
        attachments: {
          maxFiles: cfg.maxAttachmentsPerAsk,
          maxBytes: cfg.maxAttachmentBytes,
          maxTotalBytes: cfg.maxAskImageBytes,
          mediaTypes: [...ATTACHMENT_MEDIA_TYPES],
        },
      },
      features: {
        ask: true,
        followUp: true,
        relay: true,
        decision: true,
        compare: reviewAvailable,
        timeoutAutoPause: cfg.timeoutAutoPause,
        reviewerAvailable: reviewAvailable,
        timeoutAvailable: timeoutAvailable(),
        attachments: attachmentCaps,
      },
    }
  }

  function buildPollResponse(query) {
    const jobId = typeof query.jobId === 'string' ? query.jobId : ''
    const job = state.jobs.get(jobId)
    if (job === undefined) throw httpError(404, 'job-not-found', '这次回答已经过期或不存在。')
    const cursor = intIn(query.cursor, 0, 0, Number.MAX_SAFE_INTEGER)
    const safeCursor = Math.min(cursor, job.text.length)
    return {
      ok: true,
      jobId: job.id,
      consultKey: job.consultKey,
      target: job.target,
      threadId: job.threadId,
      status: job.status,
      delta: job.text.slice(safeCursor),
      cursor: job.text.length,
      question: job.question,
      usage: job.usage,
      error: job.error,
      promptChars: job.promptChars ?? null,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    }
  }

  /* ------------------------------------------------------------------ */
  /* 5. HTTP 路由                                                       */
  /* ------------------------------------------------------------------ */

  function findConnection() {
    for (const source of [ctx]) {
      if (source === undefined || source === null) continue
      try {
        const connection = Reflect.get(source, 'connection')
        if (connection && typeof connection.requestRejection === 'function') return connection
      } catch {
        /* ignore */
      }
    }
    return null
  }

  const connection = findConnection()
  const webServer = ctx.webServer

  function sendJson(res, status, payload) {
    try {
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(body)
    } catch (error) {
      noteError('send-json', error)
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    }
  }

  function sendText(res, status, text) {
    try {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(text)
    } catch {
      /* ignore */
    }
  }

  function queryOf(req) {
    try {
      return new URL(req.url ?? ROUTE_PREFIX, 'http://localhost').searchParams
    } catch {
      return new URLSearchParams()
    }
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      req.on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          fail(httpError(413, 'body-too-large', '请求体太大。'))
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        if (raw.length === 0) {
          resolve({})
          return
        }
        try {
          const value = JSON.parse(raw)
          if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            reject(httpError(400, 'bad-json', '请求体必须是 JSON 对象。'))
            return
          }
          resolve(value)
        } catch {
          reject(httpError(400, 'bad-json', '请求体不是合法 JSON。'))
        }
      })
      req.on('error', (error) => fail(error))
    })
  }

  /** 统一的路由守卫：鉴权 → 分发 → 错误包含。 */
  function route(path, handler) {
    const guarded = (req, res) => {
      void (async () => {
        try {
          const rejection = (() => {
            if (connection === null) return 503
            try {
              return connection.requestRejection(req) ?? undefined
            } catch {
              return 401
            }
          })()
          if (rejection !== undefined && rejection !== null && rejection !== false) {
            sendText(res, typeof rejection === 'number' ? rejection : 401, rejection === 403 ? 'forbidden' : 'unauthorized')
            return
          }
          await handler(req, res)
        } catch (error) {
          const status = typeof error?.status === 'number' ? error.status : 500
          if (status >= 500) noteError(`route ${path}`, error)
          if (!res.headersSent) {
            sendJson(res, status, {
              ok: false,
              code: typeof error?.code === 'string' ? error.code : 'internal',
              error: clip(messageOf(error), 800),
            })
          } else {
            try {
              res.end()
            } catch {
              /* ignore */
            }
          }
        }
      })()
    }
    try {
      return webServer.register({ name: `approval-consult${path.replace(/\//g, '-')}`, kind: 'exact', path, handler: guarded })
    } catch (error) {
      noteError(`register ${path}`, error)
      return () => {}
    }
  }

  function requireMethod(req, method) {
    if ((req.method ?? 'GET').toUpperCase() !== method) throw httpError(405, 'method-not-allowed', `只支持 ${method}。`)
  }

  /* ------------------------------------------------------------------ */
  /* 5.4 常用问题（预设）读写                                            */
  /* ------------------------------------------------------------------ */

  function cleanPresetList(value, label) {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) throw httpError(400, 'bad-presets', `${label}必须是字符串数组。`)
    const out = []
    for (const item of value) {
      if (typeof item !== 'string') throw httpError(400, 'bad-presets', `${label}的每一项都必须是文本。`)
      const text = item.trim()
      if (text.length === 0) continue
      if (text.length > PRESET_MAX_CHARS) throw httpError(413, 'preset-too-long', `${label}单条不能超过 ${PRESET_MAX_CHARS} 字。`)
      if (out.includes(text)) continue
      if (out.length >= PRESET_MAX_COUNT) throw httpError(413, 'too-many-presets', `${label}最多 ${PRESET_MAX_COUNT} 条。`)
      out.push(text)
    }
    return out
  }

  function presetsPayload() {
    return {
      ok: true,
      executor: cfg.presets.executor,
      reviewer: cfg.presets.reviewer,
      defaults: { executor: [...DEFAULT_PRESETS.executor], reviewer: [...DEFAULT_PRESETS.reviewer] },
      config: { executor: [...configPresets.executor], reviewer: [...configPresets.reviewer] },
      source: userPresets !== null ? 'user' : config?.presets === undefined ? 'builtin' : 'config',
      reviewerAvailable: reviewerAvailable(),
      limits: { maxCount: PRESET_MAX_COUNT, maxChars: PRESET_MAX_CHARS },
    }
  }

  if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
    addDisposer(
      route(`${ROUTE_PREFIX}/context`, async (req, res) => {
        requireMethod(req, 'GET')
        const query = queryOf(req)
        sendJson(res, 200, await buildContextResponse({
          sessionId: query.get('sessionId'),
          callId: query.get('callId'),
          toolName: query.get('toolName'),
          consultKey: query.get('consultKey'),
        }))
      }),
    )
    addDisposer(
      route(`${ROUTE_PREFIX}/presets`, async (req, res) => {
        const method = (req.method ?? 'GET').toUpperCase()
        if (method === 'GET') {
          sendJson(res, 200, presetsPayload())
          return
        }
        if (method !== 'POST') throw httpError(405, 'method-not-allowed', '只支持 GET / POST。')
        const body = await readJsonBody(req)
        const executor = cleanPresetList(body.executor, '执行 AI 预设')
        const reviewer = cleanPresetList(body.reviewer, '审查 AI 预设')
        if (executor === undefined && reviewer === undefined) throw httpError(400, 'bad-presets', '没有需要保存的内容。')
        const next = {
          executor: executor ?? cfg.presets.executor,
          reviewer: reviewer ?? cfg.presets.reviewer,
        }
        try {
          writeUserPresets(next)
        } catch (error) {
          throw httpError(500, 'presets-write-failed', `保存常用问题失败：${messageOf(error)}`)
        }
        userPresets = next
        applyEffectivePresets()
        sendJson(res, 200, presetsPayload())
      }),
    )
    addDisposer(
      route(`${ROUTE_PREFIX}/presets/reset`, async (req, res) => {
        requireMethod(req, 'POST')
        clearUserPresets()
        userPresets = null
        applyEffectivePresets()
        sendJson(res, 200, presetsPayload())
      }),
    )
    addDisposer(
      route(`${ROUTE_PREFIX}/attachment`, async (req, res) => {
        const method = (req.method ?? 'GET').toUpperCase()
        if (method === 'GET') {
          const query = queryOf(req)
          const id = String(query.get('id') ?? '')
          const consultKey = String(query.get('consultKey') ?? '')
          if (id.length === 0) throw httpError(400, 'attachment-bad-request', '缺少图片 id。')
          const item = state.attachments.get(id)
          if (item === undefined || item.consultKey !== consultKey || Date.now() > item.expiresAt) {
            throw httpError(404, 'attachment-unknown', '这张图片已经失效，请重新上传。')
          }
          // 审批结束后图片引用必须立即失效（finalizePending 会清理，这里兜底防止竞态残留）。
          const pendingForImage = state.pendings.get(consultKey)
          if (pendingForImage === undefined || pendingForImage.resolvedAt !== null) {
            throw httpError(404, 'attachment-unknown', '这张图片已经失效，请重新上传。')
          }
          if (attachmentStore === null || typeof attachmentStore.readImage !== 'function') {
            throw httpError(409, 'attachment-unavailable', '当前环境没有可用的附件服务。')
          }
          let stored = null
          try {
            stored = await attachmentStore.readImage(item.ref)
          } catch (error) {
            throw mapAttachmentError(error)
          }
          sendImage(res, stored.data, stored.ref?.mediaType ?? item.ref.mediaType)
          return
        }
        if (method !== 'POST') throw httpError(405, 'method-not-allowed', '只支持 GET / POST。')
        if (!cfg.attachmentsEnabled || attachmentStore === null) {
          throw httpError(409, 'attachment-unavailable', '当前环境不支持图片上传。')
        }
        const query = queryOf(req)
        const sessionId = String(query.get('sessionId') ?? '')
        const consultKey = String(query.get('consultKey') ?? '')
        const mediaType = pickAttachmentMediaType(query.get('mediaType'))
        if (sessionId.length === 0 || mediaType === null) {
          throw httpError(400, 'attachment-bad-request', '缺少 sessionId 或图片类型。')
        }
        const record = resolvePending({ consultKey, sessionId })
        if (record === null) throw httpError(404, 'no-pending', '没有找到这次待审批的调用。')
        if (record.resolvedAt !== null) throw httpError(409, 'approval-resolved', '这次审批已经结束，不能继续上传。')
        const contentType = String(req.headers?.['content-type'] ?? '')
        if (contentType.length > 0 && !/application\/octet-stream/i.test(contentType)) {
          throw httpError(415, 'attachment-content-type', '图片必须以 application/octet-stream 上传。')
        }
        const serviceLimit = Number(attachmentStore.imageLimits?.maxImageBytes)
        const limit = Math.min(cfg.maxAttachmentBytes, Number.isFinite(serviceLimit) && serviceLimit > 0 ? serviceLimit : MAX_ATTACHMENT_BODY_BYTES)
        // 先占名额再读取/保存：超额或并发上传不会浪费宿主存储与解析资源。
        reserveAttachmentSlot(record.key)
        try {
          const data = await readBinaryBody(req, limit)
          if (data.length === 0) throw httpError(400, 'attachment-bad-request', '图片内容为空。')
          // 读取期间审批可能已经结束：结束后的图片一律不再登记（否则会“复活”已失效引用）。
          if (record.resolvedAt !== null) {
            throw httpError(409, 'approval-resolved', '这次审批已经结束，不能再上传图片。')
          }
          let ref = null
          try {
            ref = await attachmentStore.saveImage({
              data,
              mediaType,
              name: sanitizeAttachmentName(query.get('name')),
            })
          } catch (error) {
            throw mapAttachmentError(error)
          }
          // saveImage 也可能耗时：登记前再复核一次；若此时审批已结束，本次保存的宿主对象
          // 没有对应引用（宿主接口未提供删除语义），但绝不会被登记成可读取的附件。
          if (record.resolvedAt !== null) {
            throw httpError(409, 'approval-resolved', '这次审批已经结束，不能再上传图片。')
          }
          const item = registerAttachment(ref, record.key, record.sessionId)
          sendJson(res, 200, { ok: true, attachment: attachmentMeta(item) })
        } finally {
          releaseAttachmentSlot(record.key)
        }
      }),
    )
    addDisposer(
      route(`${ROUTE_PREFIX}/attachment/drop`, async (req, res) => {
        requireMethod(req, 'POST')
        const body = await readJsonBody(req)
        const consultKey = String(body.consultKey ?? '')
        if (consultKey.length === 0) throw httpError(400, 'attachment-bad-request', '缺少 consultKey。')
        const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : []
        sendJson(res, 200, { ok: true, dropped: dropAttachments(consultKey, ids) })
      }),
    )
    addDisposer(
      route(`${ROUTE_PREFIX}/ask`, async (req, res) => {
        requireMethod(req, 'POST')
        const body = await readJsonBody(req)
        sendJson(res, 200, { ok: true, ...(await startAsk(body)) })
      }),
    )
    addDisposer(
      route(`${ROUTE_PREFIX}/poll`, async (req, res) => {
        requireMethod(req, 'GET')
        const query = queryOf(req)
        sendJson(res, 200, buildPollResponse({ jobId: query.get('jobId'), cursor: query.get('cursor') }))
      }),
    )
    addDisposer(
      route(`${ROUTE_PREFIX}/cancel`, async (req, res) => {
        requireMethod(req, 'POST')
        const body = await readJsonBody(req)
        const jobId = typeof body.jobId === 'string' ? body.jobId : ''
        const job = state.jobs.get(jobId)
        if (job === undefined) {
          sendJson(res, 404, { ok: false, code: 'job-not-found', error: '这次回答已经结束或不存在。' })
          return
        }
        if (job.status === 'streaming') {
          job.status = 'cancelled'
          job.error = '回答已取消。'
          job.entry.status = 'cancelled'
          job.entry.error = job.error
          try {
            job.controller.abort(new Error('cancelled by user'))
          } catch {
            /* ignore */
          }
        }
        sendJson(res, 200, { ok: true, status: job.status })
      }),
    )
    addDisposer(
      route(`${ROUTE_PREFIX}/relay`, async (req, res) => {
        requireMethod(req, 'POST')
        const body = await readJsonBody(req)
        sendJson(res, 200, { ok: true, ...relayToExecutor(body) })
      }),
    )
    addDisposer(
      route(`${ROUTE_PREFIX}/review`, async (req, res) => {
        requireMethod(req, 'POST')
        if (!reviewerAvailable()) throw httpError(409, 'reviewer-unavailable', '当前环境不支持咨询审查 AI，只能向执行 AI 提问。')
        const body = await readJsonBody(req)
        const record = resolvePending(body)
        if (record === null) throw httpError(409, 'no-pending', '没有找到这次待审批的调用。')
        if (record.review !== null) {
          // 已经捕获到官方审查：直接返回它的结论，不重复跑模型。
          sendJson(res, 200, {
            ok: record.review.decision !== null,
            advisory: false,
            reused: true,
            risk: record.review.decision?.risk ?? null,
            decision: record.review.decision?.decision ?? null,
            reason: record.review.decision?.reason ?? null,
            decisionText: clip(record.review.decisionText, 2000),
            usage: record.review.usage,
            error: record.review.error,
            elapsedMs: 0,
          })
          return
        }
        const { review, reused } = await classifyAdvisoryReview(record)
        sendJson(res, 200, serializeAdvisoryResult(review, reused))
      }),
    )
    addDisposer(
      route(`${ROUTE_PREFIX}/history`, async (req, res) => {
        requireMethod(req, 'GET')
        sendJson(res, 200, buildHistory(queryOf(req)))
      }),
    )
    addDisposer(
      route(`${ROUTE_PREFIX}/diag`, async (req, res) => {
        requireMethod(req, 'GET')
        sendJson(res, 200, buildDiag())
      }),
    )
    if (cfg.devTools) {
      addDisposer(
        route(`${ROUTE_PREFIX}/debug/inspect`, async (req, res) => {
          requireMethod(req, 'GET')
          sendJson(res, 200, buildInspect(queryOf(req)))
        }),
      )
      addDisposer(
        route(`${ROUTE_PREFIX}/debug/selftest`, async (req, res) => {
          requireMethod(req, 'GET')
          sendJson(res, 200, await runSelftest(queryOf(req)))
        }),
      )
      addDisposer(
        route(`${ROUTE_PREFIX}/debug/events`, async (req, res) => {
          requireMethod(req, 'GET')
          sendJson(res, 200, buildEventTail(queryOf(req)))
        }),
      )
      addDisposer(
        route(`${ROUTE_PREFIX}/debug/inject`, async (req, res) => {
          requireMethod(req, 'POST')
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '')
          const text = String(body.text ?? '').trim()
          if (sessionId.length === 0 || text.length === 0) throw httpError(400, 'bad-request', '需要 sessionId 与 text。')
          const agent = liveAgentBySessionId(sessionId)
          if (agent === null) throw httpError(404, 'agent-offline', '该会话没有在线的 agent。')
          agent.inject(makeInjectedMessage(clip(text, 8000), {
            kind: INJECT_SOURCE_KIND,
            form: 'notice',
            summary: summaryLine('审批咨询：devTools 注入测试'),
            phase: 'devtest',
          }))
          state.stats.injections += 1
          sendJson(res, 200, { ok: true, injected: true })
        }),
      )
      // 自测适配：临时切换能力开关（只影响本进程内存，重启/热重载后回到配置值）。
      addDisposer(
        route(`${ROUTE_PREFIX}/debug/features`, async (req, res) => {
          requireMethod(req, 'POST')
          const body = await readJsonBody(req)
          if (body.reviewerMode !== undefined) {
            const mode = normalizeReviewerMode(body.reviewerMode)
            cfg.reviewerMode = mode
          }
          if (body.timeoutAvailable !== undefined) {
            cfg.timeoutAvailableOverride = body.timeoutAvailable === null ? null : body.timeoutAvailable === true
          }
          sendJson(res, 200, {
            ok: true,
            reviewerMode: cfg.reviewerMode,
            reviewerAvailable: reviewerAvailable(),
            timeoutAvailable: timeoutAvailable(),
          })
        }),
      )
      // 自测：造一条“审批理由是 auto-review 拒绝”的 pending，验证合成审查结论/UI（devTools 专用）。
      addDisposer(
        route(`${ROUTE_PREFIX}/debug/synthetic-approval`, async (req, res) => {
          requireMethod(req, 'POST')
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '')
          const agent = liveAgentBySessionId(sessionId)
          if (agent === null) throw httpError(404, 'agent-offline', '该会话没有在线的 agent。')
          const reason =
            typeof body.reason === 'string' && body.reason.length > 0
              ? body.reason
              : 'Auto review denied tool "edit": 测试用：来自审批卡片的审查拒绝结论。'
          const record = recordPending({
            agent,
            toolName: typeof body.toolName === 'string' && body.toolName.length > 0 ? body.toolName : 'edit',
            reason,
          })
          sendJson(res, 200, { ok: true, consultKey: record.key, reviewer: serializeReviewer(record) })
        }),
      )
      addDisposer(
        route(`${ROUTE_PREFIX}/debug/drop-pending`, async (req, res) => {
          requireMethod(req, 'POST')
          const body = await readJsonBody(req)
          const key = String(body.consultKey ?? '')
          const record = state.pendings.get(key)
          if (record === undefined) throw httpError(404, 'no-pending', '没有这条 pending。')
          state.pendings.delete(key)
          const list = state.pendingBySession.get(record.sessionId) ?? []
          state.pendingBySession.set(record.sessionId, list.filter((item) => item !== key))
          sendJson(res, 200, { ok: true, dropped: key })
        }),
      )
    }
    log.info(`[approval-consult] routes registered under ${ROUTE_PREFIX}`)
  } else {
    log.warn('[approval-consult] webServer 不可用，HTTP 路由未注册')
  }

  /* ------------------------------------------------------------------ */
  /* 5.5 开发自检（devTools）                                            */
  /* ------------------------------------------------------------------ */

  /** 某个会话的审批咨询历史（含已结束），按时间倒序。 */
  function buildHistory(query) {
    const sessionId = String(query.get('sessionId') ?? '')
    const limit = intIn(query.get('limit'), 8, 1, 30)
    if (sessionId.length === 0) throw httpError(400, 'session-required', '缺少 sessionId。')
    const keys = state.pendingBySession.get(sessionId) ?? []
    const items = []
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const record = state.pendings.get(keys[index])
      if (record === undefined) continue
      const executor = record.threads.executor
      const reviewer = record.threads.reviewer
      if (executor.length === 0 && reviewer.length === 0) continue
      items.push({
        ...serializePending(record),
        threads: serializeThreads(record),
        relays: record.relays.length,
        reviewSource:
          record.review === null
            ? record.advisoryReview === null
              ? 'none'
              : 'advisory'
            : record.review.synthetic === true
              ? 'approval-reason'
              : 'captured',
        risk: (record.review ?? record.advisoryReview)?.decision?.risk ?? null,
        decision: (record.review ?? record.advisoryReview)?.decision?.decision ?? null,
        reason: (record.review ?? record.advisoryReview)?.decision?.reason ?? null,
        counts: { executor: executor.length, reviewer: reviewer.length },
      })
      if (items.length >= limit) break
    }
    return { ok: true, sessionId, items, total: items.length }
  }

  /** 构造一条不进入 pending 列表的临时记录，复用真实前缀跑侧调用。 */
  function syntheticRecord(sessionId, review) {
    return {
      key: `dbg:${nextSeq()}`,
      sessionId,
      callId: undefined,
      toolName: review?.action?.name ?? 'unknown',
      reason: undefined,
      displayReason: undefined,
      agent: liveAgentBySessionId(sessionId),
      exec: latestExecOf(sessionId),
      review,
      startedAt: Date.now(),
      resolvedAt: null,
      outcome: null,
      error: null,
      threads: { executor: [], reviewer: [] },
      jobs: new Set(),
      relays: [],
    }
  }

  function liveAgentBySessionId(sessionId) {
    try {
      return ctx.agents.get(sessionId) ?? null
    } catch {
      return null
    }
  }

  function latestExecOf(sessionId) {
    let found
    for (const value of state.execs.values()) {
      if (value.sessionId === sessionId) found = value
    }
    return found
  }

  function promptCharsOf(options) {
    let total = typeof options?.system === 'string' ? options.system.length : 0
    if (Array.isArray(options?.messages)) {
      for (const message of options.messages) total += textOfMessage(message).length
    }
    return total
  }

  /** 用真实上下文跑一次自检侧调用（不写会话、不产生审批）。 */
  async function runSelftest(query) {
    const sessionId = String(query.get('sessionId') ?? '')
    if (sessionId.length === 0) throw httpError(400, 'session-required', '缺少 sessionId。')
    const target = query.get('target') === 'executor' ? 'executor' : 'reviewer'
    const question =
      String(query.get('question') ?? '').trim() ||
      (target === 'reviewer' ? '请解释你这次审查结论的关键风险点。' : '你为什么需要执行这个操作？失败会怎样？')
    let record
    let provider
    let model
    if (target === 'executor') {
      const main = state.mainRequests.get(sessionId)
      if (main === undefined) throw httpError(404, 'executor-context-missing', '该会话还没有捕获到主对话请求。')
      record = syntheticRecord(sessionId, null)
      provider = main.provider
      model = main.model
    } else {
      const list = state.reviews.get(sessionId) ?? []
      const review = list.find((item) => item.action !== null && item.error === null) ?? list[0]
      if (review === undefined) throw httpError(404, 'review-context-missing', '该会话还没有捕获到自动审查请求。')
      record = syntheticRecord(sessionId, review)
      provider = review.provider
      model = review.model
    }
    const entry = { id: `dbg:${nextSeq()}`, question, answer: '', status: 'streaming', at: Date.now(), usage: null, error: null, injectedAt: null, relayedAt: null }
    record.threads[target].push(entry)
    const job = {
      id: `dbgjob:${nextSeq()}`,
      consultKey: record.key,
      sessionId,
      target,
      threadId: entry.id,
      question,
      text: '',
      usage: null,
      status: 'streaming',
      error: null,
      controller: new AbortController(),
      createdAt: Date.now(),
      finishedAt: null,
    }
    const startedAt = Date.now()
    let options = null
    try {
      options = target === 'reviewer' ? buildReviewerOptions(record, question, job) : buildExecutorOptions(record, question, job)
      state.sideOptions.add(options)
      state.stats.sideCalls += 1
      for await (const chunk of ctx.llm.stream(options)) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') job.text += chunk.text
        else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string' && job.text.length === 0) job.text = chunk.block.text
        else if (chunk.type === 'usage') job.usage = chunk.usage ?? null
      }
      job.status = 'done'
    } catch (error) {
      job.status = 'error'
      job.error = friendlySideCallError(error)
      noteError('selftest', error)
    } finally {
      if (options !== null) state.sideOptions.delete(options)
      job.finishedAt = Date.now()
      state.jobs.delete(job.id)
    }
    const reviewBrief =
      record.review === null
        ? null
        : {
            action: record.review.action?.name ?? null,
            risk: record.review.decision?.risk ?? null,
            decision: record.review.decision?.decision ?? null,
            reason: clip(record.review.decision?.reason ?? '', 400),
            capturedAt: record.review.at,
            historyCount: countReviewHistory(record.review.rawUserText),
          }
    return {
      ok: job.status === 'done',
      target,
      status: job.status,
      provider,
      model,
      answer: job.text,
      usage: job.usage,
      error: job.error,
      elapsedMs: Date.now() - startedAt,
      promptChars: options === null ? 0 : promptCharsOf(options),
      review: reviewBrief,
      note: 'devTools 自检：使用真实捕获的上下文跑一次侧调用，不写会话、不产生审批。',
    }
  }

  /**
   * 读取某个 session 最近的 session 事件（只含类型与文本片段），用于验证
   * “审批咨询记录”是否真的进入了会话表面（user/message 事件）。
   */
  function buildEventTail(query) {
    const sessionId = String(query.get('sessionId') ?? '')
    const limit = intIn(query.get('limit'), 20, 1, 100)
    if (sessionId.length === 0) throw httpError(400, 'session-required', '缺少 sessionId。')
    let agent = null
    try {
      agent = ctx.agents.get(sessionId) ?? null
    } catch {
      agent = null
    }
    if (agent === null) {
      // 已结束的会话不在 agents 注册表里；尝试从 sessions 服务找。
      try {
        const session = ctx.sessions.get?.(sessionId) ?? undefined
        if (session === undefined) throw new Error('no session')
        agent = { session }
      } catch {
        throw httpError(404, 'session-not-found', '找不到这个会话。')
      }
    }
    const events = agent.session.snapshotEvents()
    const tail = events.slice(-limit).map((event) => ({
      seq: event.seq,
      type: event.type,
      at: event.time,
      text: clip(textOfMessage(event.data?.message ?? event.data), 400),
      source: event.data?.source?.kind ?? null,
    }))
    return {
      ok: true,
      sessionId,
      total: events.length,
      tail,
      injected: events.filter((event) => event.type === 'user/message' && event.data?.source?.kind === INJECT_SOURCE_KIND).length,
    }
  }

  function buildInspect(query) {
    const sessionId = String(query.get('sessionId') ?? '')
    const main = sessionId.length === 0 ? undefined : state.mainRequests.get(sessionId)
    const reviews = (sessionId.length === 0 ? [] : state.reviews.get(sessionId) ?? []).map((review) => ({
      id: review.id,
      at: review.at,
      action: review.action === null ? null : { name: review.action.name, mode: review.action.mode },
      decision: review.decision,
      error: review.error,
      claimedBy: review.claimedBy,
      finishKind: review.finishKind,
      textChars: review.text.length,
      historyCount: countReviewHistory(review.rawUserText),
    }))
    const pendings = []
    for (const [key, record] of state.pendings) {
      if (sessionId.length > 0 && record.sessionId !== sessionId) continue
      pendings.push({
        key,
        sessionId: record.sessionId,
        toolName: record.toolName,
        callId: record.callId ?? null,
        reason: record.reason ?? null,
        displayReason: record.displayReason ?? null,
        startedAt: record.startedAt,
        resolvedAt: record.resolvedAt,
        outcome: record.outcome,
        reviewId: record.review?.id ?? null,
        reviewSource: record.review !== null ? 'captured' : record.advisorySnapshot ? 'advisory' : 'none',
        advisoryClassified: record.advisoryReview?.decision !== null && record.advisoryReview !== null,
        threads: { executor: record.threads.executor.length, reviewer: record.threads.reviewer.length },
      })
    }
    const agentCapture = (() => {
      try {
        return {
          attached: [...state.agentDisposers.keys()],
          agents: ctx.agents.list().map((agent) => String(agent?.session?.id ?? '')),
        }
      } catch (error) {
        return { error: messageOf(error) }
      }
    })()
    return { ok: true, sessionId, main: main === undefined ? null : { at: main.at, provider: main.provider, model: main.model, messageCount: main.messageCount, toolCount: main.toolCount }, reviews, pendings, agentCapture, lastError: state.lastError, devTools: cfg.devTools }
  }

  /* ------------------------------------------------------------------ */
  /* 5.6 诊断                                                            */
  /* ------------------------------------------------------------------ */

  function buildDiag() {
    // 诊断时顺手核对 per-agent 捕获器（agent 对象可能已重建）。
    try {
      for (const agent of ctx.agents.list()) attachAgentCapture(agent)
    } catch {
      /* ignore */
    }
    const shim = (() => {
      try {
        return runtime?.describe?.() ?? null
      } catch {
        return null
      }
    })()
    const pendingList = []
    for (const [sessionId, keys] of state.pendingBySession) {
      const live = keys
        .map((key) => state.pendings.get(key))
        .filter((record) => record !== undefined && record.resolvedAt === null)
        .map((record) => ({ consultKey: record.key, toolName: record.toolName, review: record.review !== null }))
      if (live.length > 0) pendingList.push({ sessionId, pendings: live })
    }
    const presets = (() => {
      const service = permissionPresetsService
      if (service === null || typeof service.current !== 'function') return null
      try {
        return ctx.agents.list().map((agent) => {
          let preset = null
          try {
            preset = service.current(agent.session) ?? null
          } catch {
            preset = null
          }
          return { sessionId: String(agent.session.id), preset }
        })
      } catch {
        return null
      }
    })()
    return {
      ok: true,
      version: PLUGIN_VERSION,
      uptimeMs: Math.round(process.uptime() * 1000),
      shim,
      config: {
        maxQuestionChars: cfg.maxQuestionChars,
        maxConcurrentJobs: cfg.maxConcurrentJobs,
        executorMaxTokens: cfg.executorMaxTokens,
        reviewerMaxTokens: cfg.reviewerMaxTokens,
        timeoutAutoPause: cfg.timeoutAutoPause,
        reviewerMode: cfg.reviewerMode,
        reviewerAvailable: reviewerAvailable(),
        timeoutAvailable: timeoutAvailable(),
        devTools: cfg.devTools,
        devWatch: cfg.devWatch,
        dataRoot: resolveDataRoot(process.env, process.argv, homedir(), cfg.dataDir),
        reviewPolicySource,
        reviewPolicyChars: REVIEW_POLICY_TEXT.length,
      },
      stats: state.stats,
      live: {
        sessionsWithMainRequest: state.mainRequests.size,
        reviewSessions: state.reviews.size,
        execs: state.execs.size,
        pendings: state.pendings.size,
        jobs: [...state.jobs.values()].filter((job) => job.status === 'streaming').length,
      },
      presets,
      captured: {
        mainRequests: [...state.mainRequests.keys()],
        reviews: [...state.reviews.entries()].map(([sessionKey, list]) => ({ sessionId: sessionKey, count: list.length, lastAt: list[0]?.at ?? null })),
      },
      llmSeen: state.llmSeen,
      llmAll: state.llmAll,
      execSeen: state.execSeen,
      pendings: pendingList,
      lastError: state.lastError,
    }
  }

  /* ------------------------------------------------------------------ */
  /* 6. 注册监听器与清理                                                 */
  /* ------------------------------------------------------------------ */

  addDisposer(ctx.on('llm/stream', llmStreamListener))
  addDisposer(ctx.on('tools/pre-execute', preExecuteListener))
  // prepend：必须赶在浏览器应答者之前登记 pending。
  addDisposer(ctx.on('approval/request', approvalListener, true))

  /**
   * 每个 agent 的作用域内也挂一份 llm/stream 监听器：某些审查调用在 agent 作用域
   * 派发时不会到达根上下文监听器（不同 LlmRuntime 实例的 scope filter 不同）。
   * 用 wrappedOptions 去重，保证同一请求只记录/包装一次。
   */
  function attachAgentCapture(agent) {
    try {
      const agentId = String(agent.session.id)
      const existing = state.agentDisposers.get(agentId)
      if (existing !== undefined) {
        // 同一个 session 的 agent 对象可能被重建（换轮次/压缩后）；旧监听器绑在已死的 ctx 上，
        // 若只按 sessionId 去重就永远不会重新挂载 —— 这会造成“某些会话的 auto-review 审查请求
        // 明明发生了，但本插件一次都捕获不到”。按对象身份判断，不一致就换新的。
        if (existing.agent === agent) return
        try {
          existing.dispose()
        } catch {
          /* ignore */
        }
        state.agentDisposers.delete(agentId)
      }
      const dispose = agent.ctx.on('llm/stream', llmStreamListener)
      state.agentDisposers.set(agentId, { agent, dispose })
    } catch (error) {
      noteError('agent-capture-attach', error)
    }
  }

  function detachAgentCapture(agent) {
    try {
      const agentId = String(agent.session.id)
      const entry = state.agentDisposers.get(agentId)
      if (entry === undefined) return
      state.agentDisposers.delete(agentId)
      try {
        entry.dispose()
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  }

  try {
    for (const agent of ctx.agents.list()) attachAgentCapture(agent)
  } catch (error) {
    noteError('agent-capture-list', error)
  }
  addDisposer(ctx.on('agent/created', (payload) => {
    if (payload?.agent !== undefined) attachAgentCapture(payload.agent)
  }))
  addDisposer(ctx.on('agent/disposed', (payload) => {
    if (payload?.agent !== undefined) detachAgentCapture(payload.agent)
  }))
  addDisposer(() => {
    for (const entry of state.agentDisposers.values()) {
      try {
        entry.dispose()
      } catch {
        /* ignore */
      }
    }
    state.agentDisposers.clear()
  })

  // 可选依赖：权限预设服务（仅诊断用）。
  try {
    const injected = ctx.inject(['permissionPresets'], (scope) => {
      permissionPresetsService = scope.permissionPresets ?? null
    })
    if (injected !== undefined && injected !== null) {
      addDisposer(() => {
        try {
          if (typeof injected.dispose === 'function') injected.dispose()
        } catch {
          /* ignore */
        }
        permissionPresetsService = null
      })
    }
  } catch {
    permissionPresetsService = null
  }

  // 可选依赖：DSH 内置附件服务（图片校验/归一化/内容寻址/按路由生成请求版本）。
  // 没有它时图文上传整块不可用（features.attachments 全 false），不提示、不报错。
  let attachmentStore = null
  try {
    const injectedAttachments = ctx.inject(['attachments'], (scope) => {
      attachmentStore = scope.attachments ?? null
    })
    if (injectedAttachments !== undefined && injectedAttachments !== null) {
      addDisposer(() => {
        try {
          if (typeof injectedAttachments.dispose === 'function') injectedAttachments.dispose()
        } catch {
          /* ignore */
        }
        attachmentStore = null
      })
    } else {
      attachmentStore = ctx.attachments ?? null
    }
  } catch {
    attachmentStore = null
  }

  /* ---------------- 图文附件：能力探测 / 引用登记 / 预算 ---------------- */

  /** `${provider}\0${model}` -> 是否支持图片输入（true/false）。 */
  const imageCapabilityCache = new Map()
  /** 进行中的能力查询，避免同一路由并发重复 resolve。 */
  const imageCapabilityInflight = new Map()
  /** 路由能力变化时清空缓存。 */
  addDisposer(
    ctx.on('llm/adapters-updated', () => {
      imageCapabilityCache.clear()
      imageCapabilityInflight.clear()
    }),
  )

  /** 某条路由是否支持图片输入；缺省/异常一律按不支持处理。 */
  function imageCapability(provider, model) {
    if (attachmentStore === null) return Promise.resolve(false)
    if (typeof provider !== 'string' || provider.length === 0) return Promise.resolve(false)
    if (typeof model !== 'string' || model.length === 0) return Promise.resolve(false)
    const key = `${provider}\u0000${model}`
    if (imageCapabilityCache.has(key)) return Promise.resolve(imageCapabilityCache.get(key))
    const inflight = imageCapabilityInflight.get(key)
    if (inflight !== undefined) return inflight
    const task = (async () => {
      try {
        const info = await ctx.llm.resolveModelInfo(provider, model)
        return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
      } catch (error) {
        noteError('image-capability', error)
        return false
      }
    })()
      .then((value) => {
        imageCapabilityCache.set(key, value)
        imageCapabilityInflight.delete(key)
        return value
      })
      .catch(() => {
        imageCapabilityCache.set(key, false)
        imageCapabilityInflight.delete(key)
        return false
      })
    imageCapabilityInflight.set(key, task)
    return task
  }

  /** 当前审批的图文能力：总开关 + 执行侧 / 审查侧路由是否支持图片。 */
  async function attachmentCapabilities(record) {
    const enabled = cfg.attachmentsEnabled && attachmentStore !== null
    if (!enabled) return { enabled: false, executor: false, reviewer: false }
    if (record === null) return { enabled: true, executor: false, reviewer: false }
    const main = state.mainRequests.get(record.sessionId)
    const review = record.review ?? record.advisoryReview ?? null
    const executor = main?.options ? await imageCapability(main.options.provider, main.options.model) : false
    const reviewer =
      cfg.attachmentForReviewer === 'off'
        ? false
        : review?.options
          ? await imageCapability(review.options.provider, review.options.model)
          : false
    return { enabled: true, executor, reviewer }
  }

  /** 该审批下的附件引用条目。 */
  function attachmentsForConsult(consultKey) {
    const out = []
    for (const item of state.attachments.values()) {
      if (item.consultKey === consultKey) out.push(item)
    }
    return out
  }

  /** 该审批下进行中的上传预占数。 */
  function pendingAttachmentCount(consultKey) {
    return state.attachmentPending.get(consultKey) ?? 0
  }

  /**
   * 上传前预占名额：超额/并发上传不会先 saveImage 再被拒（安全审查 2026-11-03）。
   * 调用方必须在 finally 里 releaseAttachmentSlot。
   */
  function reserveAttachmentSlot(consultKey) {
    const existing = attachmentsForConsult(consultKey).length
    const pending = pendingAttachmentCount(consultKey)
    if (existing + pending >= cfg.maxAttachmentsPerConsult) {
      throw httpError(413, 'attachment-too-many', `同一审批下最多保留 ${cfg.maxAttachmentsPerConsult} 张图片。`)
    }
    state.attachmentPending.set(consultKey, pending + 1)
  }

  function releaseAttachmentSlot(consultKey) {
    const pending = pendingAttachmentCount(consultKey)
    if (pending <= 1) state.attachmentPending.delete(consultKey)
    else state.attachmentPending.set(consultKey, pending - 1)
  }

  /** 登记一张已存入附件服务的图片，返回对外展示的元数据。 */
  function registerAttachment(ref, consultKey, sessionId) {
    const existing = attachmentsForConsult(consultKey)
    if (existing.length >= cfg.maxAttachmentsPerConsult) {
      throw httpError(413, 'attachment-too-many', `同一审批下最多保留 ${cfg.maxAttachmentsPerConsult} 张图片。`)
    }
    const id = `att:${randomUUID()}`
    const record = {
      id,
      ref,
      consultKey,
      sessionId,
      createdAt: Date.now(),
      expiresAt: Date.now() + ATTACHMENT_TTL_MS,
    }
    state.attachments.set(id, record)
    state.stats.attachments += 1
    return record
  }

  /** 把引用条目转成客户端可渲染的元数据（不含字节、不含附件服务内部 id）。 */
  function attachmentMeta(record) {
    return {
      id: record.id,
      name: record.ref?.name ?? '',
      mediaType: record.ref?.mediaType ?? 'image/png',
      bytes: Number(record.ref?.bytes ?? 0),
      width: Number(record.ref?.width ?? 0),
      height: Number(record.ref?.height ?? 0),
    }
  }

  /** 解析 /ask 带来的 attachmentIds：只认同一审批下、未过期的引用。 */
  function resolveAttachments(ids, consultKey) {
    const out = []
    for (const id of ids) {
      const record = state.attachments.get(id)
      if (record === undefined) continue
      if (record.consultKey !== consultKey) continue
      if (Date.now() > record.expiresAt) {
        state.attachments.delete(id)
        continue
      }
      out.push(record)
    }
    return out
  }

  /** 丢弃某个审批下的全部附件引用（字节仍由附件服务负责，不在这里删）。 */
  function dropAttachments(consultKey, ids) {
    let dropped = 0
    for (const [id, item] of [...state.attachments]) {
      if (item.consultKey !== consultKey) continue
      if (Array.isArray(ids) && ids.length > 0 && !ids.includes(id)) continue
      state.attachments.delete(id)
      dropped += 1
    }
    return dropped
  }

  /** 附件服务错误 → 插件错误码（客户端据此显示可操作提示）。 */
  function mapAttachmentError(error) {
    const code = typeof error?.code === 'string' ? error.code : 'attachment-failed'
    const table = {
      UNSUPPORTED_IMAGE_TYPE: [415, 'attachment-unsupported-type', '不支持的图片格式（只支持 png/jpeg/webp/gif）。'],
      INVALID_IMAGE: [400, 'attachment-invalid-image', '这张图片无法解析，可能已损坏。'],
      INVALID_IMAGE_BASE64: [400, 'attachment-invalid-image', '这张图片无法解析，可能已损坏。'],
      IMAGE_TYPE_MISMATCH: [400, 'attachment-type-mismatch', '图片实际格式与声明不符。'],
      IMAGE_TOO_LARGE: [413, 'attachment-too-large', '图片太大，请换一张或裁剪后重试。'],
      TOO_MANY_IMAGES: [413, 'attachment-too-many', '图片数量太多。'],
      IMAGES_TOO_LARGE: [413, 'attachment-too-large', '图片总量太大，请减少张数。'],
      IMAGE_TOO_MANY_PIXELS: [413, 'attachment-too-many-pixels', '图片像素尺寸太大，请缩小后重试。'],
      IMAGE_DIMENSION_TOO_LARGE: [413, 'attachment-dimension-too-large', '图片单边尺寸太大，请缩小后重试。'],
    }
    const mapped = table[code]
    if (mapped !== undefined) return httpError(mapped[0], mapped[1], mapped[2])
    return httpError(500, 'attachment-store-failed', `保存图片失败：${clip(messageOf(error), 240)}`)
  }

  /** 读取二进制请求体（流式计数，超限直接断开）。 */
  function readBinaryBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      req.on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > limit) {
          fail(httpError(413, 'attachment-too-large', '图片太大，请换一张或裁剪后重试。'))
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks))
      })
      req.on('error', (error) => fail(error))
    })
  }

  /** 二进制响应（图片预览用）。 */
  function sendImage(res, bytes, mediaType) {
    try {
      res.writeHead(200, {
        'content-type': mediaType,
        'content-length': String(bytes.length),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
      })
      res.end(bytes)
    } catch (error) {
      noteError('send-image', error)
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    }
  }


  const sweepTimer = setInterval(() => {
    try {
      sweep()
    } catch (error) {
      noteError('sweep', error)
    }
  }, 60_000)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
  addDisposer(() => clearInterval(sweepTimer))

  function sweep() {
    const now = Date.now()
    // 定期核对 per-agent 捕获器：agent 对象被重建时自动换绑。
    try {
      for (const agent of ctx.agents.list()) attachAgentCapture(agent)
    } catch (error) {
      noteError('agent-capture-sweep', error)
    }
    for (const [sessionId, keys] of [...state.pendingBySession]) {
      const kept = []
      for (const key of keys) {
        const record = state.pendings.get(key)
        if (record === undefined) continue
        const ended = record.resolvedAt !== null
        const age = now - (ended ? record.resolvedAt : record.startedAt)
        if (ended && age > cfg.threadTtlMs) {
          state.pendings.delete(key)
          continue
        }
        kept.push(key)
      }
      if (kept.length === 0) state.pendingBySession.delete(sessionId)
      else state.pendingBySession.set(sessionId, kept)
    }
    for (const [jobId, job] of [...state.jobs]) {
      const reference = job.finishedAt ?? job.createdAt
      if (now - reference > 10 * 60_000) {
        for (const record of state.pendings.values()) {
          if (record.jobs.delete(jobId)) break
        }
        state.jobs.delete(jobId)
      }
    }
    for (const [sessionId, list] of [...state.reviews]) {
      const recent = list.filter((review) => now - review.at <= cfg.threadTtlMs)
      if (recent.length === 0) state.reviews.delete(sessionId)
      else if (recent.length !== list.length) state.reviews.set(sessionId, recent)
    }
    if (state.execs.size > 300) {
      const cutoff = now - 30 * 60_000
      for (const [key, value] of [...state.execs]) {
        if (value.at < cutoff) state.execs.delete(key)
      }
    }
    // 附件引用：审批已不存在 / TTL 到期的一律丢弃（字节在附件服务里，不归我们删）。
    for (const [id, item] of [...state.attachments]) {
      if (now > item.expiresAt || !state.pendings.has(item.consultKey)) state.attachments.delete(id)
    }
  }

  log.info(`[approval-consult] ready (gen ${runtime?.generation ?? '?'}), routes: ${ROUTE_PREFIX}`)

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        noteError('dispose', error)
      }
    }
    disposers.length = 0
    for (const job of state.jobs.values()) {
      if (job.status !== 'streaming') continue
      job.status = 'cancelled'
      try {
        job.controller.abort(new Error('approval-consult unloaded'))
      } catch {
        /* ignore */
      }
    }
    state.jobs.clear()
    log.info('[approval-consult] host impl disposed')
  }
}

/**
 * 从审批理由里识别 auto-review 给出的结论。
 * auto-review 在“拒绝并转人工”时会把自己的审查理由写进 approval reason：
 *   Auto review denied tool "<name>": <reason>
 * 或失败：
 *   Auto review of tool "<name>" failed; its body was not executed: <error>
 * 这种情况下即使没捕获到那次审查请求，结论本身是确定的，不能让面板显示“没有结论”。
 */
function autoReviewVerdictFromReason(reasonText) {
  if (typeof reasonText !== 'string') return null
  const denied = reasonText.match(/^Auto review denied tool "[^"]*": ([\s\S]+)$/)
  if (denied !== null && denied[1].trim().length > 0) return { kind: 'deny', text: denied[1].trim() }
  const failed = reasonText.match(/^Auto review of tool "[^"]*" failed; its body was not executed: ([\s\S]+)$/)
  if (failed !== null) return { kind: 'failed', text: failed[1].trim() }
  return null
}

/** 规范化审查 AI 能力开关。 */
function normalizeReviewerMode(value) {
  if (value === 'on' || value === 'off' || value === 'auto') return value
  if (value === true) return 'on'
  if (value === false) return 'off'
  return 'auto'
}

/** 插件 runtime name 是否来自官方 auto-review（其名称是 experimental-auto-review）。 */
function isAutoReviewPluginName(value) {
  return typeof value === 'string' && /auto-review/i.test(value)
}

/** 插件 runtime name 是否来自自动拒绝倒计时插件（dsh-approval-timeout）。 */
function isTimeoutPluginName(value) {
  return typeof value === 'string' && /approval-timeout/i.test(value)
}

/** 规范化自动拒绝倒计时暂停策略。 */
function normalizeTimeoutAutoPause(value) {
  if (value === 'on-open' || value === 'off' || value === 'on-send') return value
  if (value === false) return 'off'
  return 'on-send'
}

/** 规范化「审查侧是否接收图片」：auto（用户在该 tab 主动加图才发）/ on / off。 */
function normalizeAttachmentForReviewer(value) {
  if (value === 'on' || value === 'off' || value === 'auto') return value
  if (value === true) return 'on'
  if (value === false) return 'off'
  return 'auto'
}

/** 附件展示名：只当文本用，绝不作路径；剥控制字符、限长 120。 */
function sanitizeAttachmentName(value) {
  const raw = typeof value === 'string' ? value : ''
  const base = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]+/g, ' ').trim()
  const name = base.length > 0 ? base : '图片'
  return name.length > 120 ? name.slice(0, 117) + '…' : name
}

/** 校验并返回允许的图片 MIME 类型；不支持时返回 null。 */
function pickAttachmentMediaType(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return ATTACHMENT_MEDIA_TYPES.includes(normalized) ? normalized : null
}

/** 规整 attachmentIds：去重、截断、丢弃非字符串。 */
function clampAttachmentIds(value, max) {
  if (!Array.isArray(value) || max <= 0) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id.length === 0 || id.length > 200) continue
    if (out.includes(id)) continue
    out.push(id)
    if (out.length >= max) break
  }
  return out
}

/** 附件引用列表的原始字节总和（用于请求预算预检，不读盘）。 */
function estimateAttachmentBytes(list) {
  let total = 0
  for (const item of Array.isArray(list) ? list : []) {
    const bytes = Number(item?.bytes ?? item?.ref?.bytes ?? 0)
    if (Number.isFinite(bytes) && bytes > 0) total += bytes
  }
  return total
}

/** 规范化预设问题配置。 */
function normalizePresets(value) {
  const pick = (list, fallback) => {
    if (!Array.isArray(list)) return [...fallback]
    const cleaned = list
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0 && item.length <= 300)
      .slice(0, 10)
    return cleaned.length > 0 ? cleaned : [...fallback]
  }
  return {
    executor: pick(value?.executor, DEFAULT_PRESETS.executor),
    reviewer: pick(value?.reviewer, DEFAULT_PRESETS.reviewer),
  }
}

/** 供离线测试使用的内部实现（不参与运行时路径）。 */
export const __test = {
  intIn,
  clip,
  canonicalJson,
  normalizeArguments,
  reviewSection,
  parsePendingAction,
  parseReviewDecision,
  looksLikeReviewRequest,
  looksLikeMainRequest,
  summaryLine,
  normalizePresets,
  normalizeTimeoutAutoPause,
  normalizeReviewerMode,
  isAutoReviewPluginName,
  isTimeoutPluginName,
  autoReviewVerdictFromReason,
  resolveDataRoot,
  normalizeAttachmentForReviewer,
  sanitizeAttachmentName,
  pickAttachmentMediaType,
  clampAttachmentIds,
  estimateAttachmentBytes,
}
