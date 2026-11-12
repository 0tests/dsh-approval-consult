/**
 * dsh-approval-consult —— 宿主侧稳定入口（shim）
 *
 * 为什么不把实现直接写在这里：DSH 的宿主模块在进程启动时按 ESM 缓存加载，
 * 改了文件必须重启 dsh web 才会生效。我们在开发/维护期频繁调整宿主逻辑
 * （捕获策略、提示词、路由），而重启宿主进程会连带打断正在进行的会话。
 *
 * 因此入口只做三件事，保持极简稳定：
 *   1. 用带版本号的 dynamic import 加载 ./impl.js（绕过 Node ESM 缓存）；
 *   2. 把 impl.apply() 返回的 dispose 存起来，文件变化时先 dispose 旧实现再装新的；
 *   3. 用 fs.watch 看 lib 目录（devWatch 可关）。这只影响本插件的热重载，
 *      不写 profile、不动 Loader、不重启进程。
 *
 * 对外契约（impl.js 必须导出）：
 *   export function apply(ctx, config, runtime) -> (() => void) | Promise<...>
 * runtime = { generation, log } 仅用于诊断。
 *
 * 依赖注入写在这里，impl 里可以直接用 ctx.webServer / ctx.llm / ctx.approval 等。
 */

import { watch } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 加载器诊断使用的插件名。 */
export const name = 'approval-consult'

/** 实现所需宿主服务；缺任何一个时本插件保持 inactive，不会半死不活地注册路由。 */
export const inject = ['webServer', 'connection', 'llm', 'sessions', 'tools', 'approval', 'agents']

/** 目录级防抖：一次保存可能触发多个 fs 事件。 */
const RELOAD_DEBOUNCE_MS = 220

export function apply(ctx, config) {
  const log = createLogger(ctx)
  const state = {
    generation: 0,
    current: null,
    disposed: false,
    swapping: false,
    queued: false,
    watcher: null,
    reloadTimer: null,
    lastError: null,
    loadedAt: 0,
  }

  /** 可安全调用的日志。 */
  function createLogger(context) {
    const logger = context?.logger
    return {
      info: (message) => {
        try {
          if (typeof logger?.info === 'function') logger.info(message)
          else console.log(message)
        } catch {
          /* 日志永不抛出 */
        }
      },
      warn: (message) => {
        try {
          if (typeof logger?.warn === 'function') logger.warn(message)
          else console.warn(message)
        } catch {
          /* ignore */
        }
      },
      error: (message) => {
        try {
          if (typeof logger?.error === 'function') logger.error(message)
          else console.error(message)
        } catch {
          /* ignore */
        }
      },
    }
  }

  /** 先释放旧实现，再加载并应用新实现；失败时保留错误供 /health 读取。 */
  async function swap() {
    if (state.disposed) return
    if (state.swapping) {
      state.queued = true
      return
    }
    state.swapping = true
    try {
      const generation = ++state.generation
      let mod
      try {
        const href = new URL(`./impl.js?gen=${generation}&t=${Date.now()}`, import.meta.url).href
        mod = await import(href)
      } catch (error) {
        state.lastError = `import impl failed: ${error instanceof Error ? error.message : String(error)}`
        log.error(`[approval-consult] ${state.lastError}`)
        return
      }
      if (state.disposed) return
      const applyImpl = typeof mod?.apply === 'function' ? mod.apply : mod?.default?.apply
      if (typeof applyImpl !== 'function') {
        state.lastError = 'impl.js exports no apply()'
        log.error(`[approval-consult] ${state.lastError}`)
        return
      }
      const previous = state.current
      state.current = null
      if (previous) {
        try {
          await previous.dispose()
        } catch (error) {
          log.warn(`[approval-consult] dispose gen ${previous.generation} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      try {
        const runtime = {
          generation,
          log,
          /** 供 /health 读取的 shim 状态。 */
          describe: () => ({
            generation: state.generation,
            loadedAt: state.loadedAt,
            lastError: state.lastError,
            devWatch: config?.devWatch === true,
          }),
        }
        const maybeDispose = applyImpl(ctx, config, runtime)
        const dispose = await maybeDispose
        if (state.disposed) {
          if (typeof dispose === 'function') await dispose()
          return
        }
        state.current = {
          generation,
          dispose: typeof dispose === 'function' ? dispose : () => {},
        }
        state.loadedAt = Date.now()
        state.lastError = null
        log.info(`[approval-consult] host impl loaded (gen ${generation})`)
      } catch (error) {
        state.lastError = `apply failed: ${error instanceof Error ? error.message : String(error)}`
        log.error(`[approval-consult] ${state.lastError}`)
        if (error instanceof Error && error.stack) log.error(error.stack)
      }
    } finally {
      state.swapping = false
      if (state.queued && !state.disposed) {
        state.queued = false
        void swap()
      }
    }
  }

  /** 监听 lib 目录里的宿主文件（不含 client.js / index.js 自身）。 */
  function startWatcher() {
    if (config?.devWatch !== true) {
      log.info('[approval-consult] devWatch disabled')
      return
    }
    const libDir = dirname(fileURLToPath(import.meta.url))
    try {
      state.watcher = watch(libDir, { persistent: false }, (_eventType, filename) => {
        const file = typeof filename === 'string' ? filename : ''
        if (file.length === 0) return
        if (!file.endsWith('.js')) return
        if (file === 'client.js' || file === 'index.js') return
        if (state.reloadTimer !== null) clearTimeout(state.reloadTimer)
        state.reloadTimer = setTimeout(() => {
          state.reloadTimer = null
          log.info(`[approval-consult] detected change in ${file}, reloading host impl`)
          void swap()
        }, RELOAD_DEBOUNCE_MS)
      })
      state.watcher.on?.('error', (error) => {
        log.warn(`[approval-consult] fs.watch error: ${error instanceof Error ? error.message : String(error)}`)
      })
      log.info(`[approval-consult] watching ${libDir} for host impl changes`)
    } catch (error) {
      log.warn(`[approval-consult] fs.watch unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.effect(() => () => {
    state.disposed = true
    if (state.reloadTimer !== null) clearTimeout(state.reloadTimer)
    state.reloadTimer = null
    if (state.watcher) {
      try {
        state.watcher.close()
      } catch {
        /* ignore */
      }
      state.watcher = null
    }
    const current = state.current
    state.current = null
    if (current) {
      void Promise.resolve()
        .then(() => current.dispose())
        .catch((error) => log.warn(`[approval-consult] final dispose failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  }, 'approval-consult host shim lifecycle')

  // 供人工排查：在宿主进程里 __DSH_APPROVAL_CONSULT__ 可见 shim 状态。
  try {
    globalThis.__DSH_APPROVAL_CONSULT__ = state
  } catch {
    /* ignore */
  }

  void swap()
  startWatcher()
}
