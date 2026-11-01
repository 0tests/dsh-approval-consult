# 桌面端（DSH Desktop）适配说明

> 调研日期：2026-11-02。结论：**本插件在桌面端基本可用（架构同构），唯一缺的是「装进 desktop profile」。**
> 状态：调研完成；安装待执行（需要写 `~/.dsh/profiles/desktop/package.json`，属于工作区外操作，需审批）。

## 一句话结论

DSH 官方桌面端是 Electron 外壳（`@deepseek-ai/dsh-desktop`），它内部跑的是**同一套 DSH Web 应用**：
同一个 `ctx.webServer`（`http://127.0.0.1:19387`）、同一套 `dsh-web-frontend` 前端、同一套
`window.__ModuleLoader__` 客户端插件协议、同一批 UI 槽位。桌面端只把「静态页面」改成自定义协议
`dsh-app://app` 加载，其余请求全部反向代理到本地 HTTP server。

因此插件**不需要改传输层**：装进桌面端的 `desktop` profile 即可工作。

## 证据（可复核）

| 事实 | 位置 |
| --- | --- |
| 桌面端安装在本机 | `C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness`（Electron 44 / app 0.2.0-rc.2） |
| 桌面 host 启动的仍是 Web 应用 | `resources/app.asar` → `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`：`runProfile({ profile: "desktop", args: ["--no-open", "--port", "19387"] })`，随后 `ctx.connection.authenticatedUrl('http://127.0.0.1:' + ctx.webServer.port)` |
| 页面走自定义协议 + 反向代理 | `app.asar/lib/main.js`：`protocol.handle("dsh-app", …)`；静态资源读 `dsh-web-frontend/dist`，其余 `forwardWebRequest(request, hostUrl, hostCookie)` 转发到 `127.0.0.1:19387` |
| 客户端插件加载方式不变 | 前端 bundle：`dshDesktopBoot.ready()` 取回 `injections` 后运行时插 `<script src>`，之后照旧 `window.__ModuleLoader__` |
| 槽位存在 | 桌面 asar 内 `dsh-cordis-client-runner` 含 `shell.overlay`、`conversation.chat.turnTail` |
| 路由注册兼容 | `dsh-host-webserver` 支持 `kind: "exact"`；鉴权 `connection.requestRejection` 的 fence 在反代后仍成立（Host=127.0.0.1、`sec-fetch-site` 同源、`origin` 被反代删除） |
| 版本差异 | 桌面端 0.2.0-rc.2 < 本机 npm 安装 0.2.1-rc.2；已抽查 `requestRejection` / `kind:"exact"` / `collectIndexInjections` / `platform !== "web"` 四处一致 |

## 唯一硬缺口：装错 profile

- 桌面端只 boot `~/.dsh/profiles/desktop`（写死在 desktop-host 里）；
- 桌面该 profile 的 `bundles` 只有 `dsh-base` + `dsh-web-app`，`dependencies` 为空；
- 本插件目前只装在 `~/.dsh/profiles/web`。

所以在桌面端「根本不会加载插件」，不是兼容性问题。

## 安装步骤（待执行）

桌面 profile 由桌面端托管，**不能用 `dsh --profile desktop` 直接装**（会被 CLI 拒绝）。
两条等价路径：

### A. 桌面端插件 UI（推荐给普通用户）

桌面端「设置 → 插件」里安装本插件（与 Web 端相同入口）。

### B. 直接写 profile（我采用的路径，等价于 Web 端的 link 安装）

1. `~/.dsh/profiles/desktop/package.json` 增加依赖并加入 bundles：

   ```json
   "dependencies": {
     "dsh-approval-consult": "link:D:/ZeroWork/dsh-approval-consult",
     "dsh-danger-guard": "link:D:/ZeroWork/dsh-guard/plugin"
   },
   "dsh": { "profile": { "bundles": [
     "@deepseek-ai/dsh-base",
     "@deepseek-ai/dsh-web-app",
     "dsh-approval-consult"
   ] } }
   ```

   > 同时保留 `dsh-danger-guard` 的声明，避免将来 `pnpm install` 把它从 `node_modules` 里剪掉。

2. 在 `~/.dsh/profiles/desktop/node_modules/` 下建目录联接（junction）：
   `dsh-approval-consult → D:\ZeroWork\dsh-approval-consult`
   （该 profile 是 `nodeLinker: hoisted`，现有 `dsh-danger-guard` 也是 junction，保持同样形态。）
3. 启动桌面端，触发一次需要审批的工具调用。

## 验收清单（必须实际跑，不能只看代码）

- [ ] 桌面端启动正常，`dsh-app://app` 页面无白屏；
- [ ] 审批出现时右上角胶囊「审批有疑问？」出现（`shell.overlay` 槽位）；
- [ ] 打开面板 → 两个 tab（执行 AI / 审查 AI）、上下文卡片、发送/停止、决策按钮都正常；
- [ ] DevTools Network 里 `/dsh-approval-consult/context`、`/ask`、`/poll` 返回 200（经 `dsh-app://app` 反代）；
- [ ] 对话流末尾「💬 审批咨询记录」chip 出现（`conversation.chat.turnTail` 槽位）；
- [ ] 关闭桌面端后重启，插件仍加载（profile 持久化生效）。

## 已知风险 / 未知项

1. **协议层耦合（未来风险）**：桌面端把 `origin` 头删掉才让本插件的鉴权 fence 通过；若某版 Electron 改成保留 `origin: dsh-app://app`，
   `isSameAuthorityOrigin` 会失败 → 全站 403。届时优先怀疑协议层变动，而不是插件。
2. **版本漂移**：桌面端 nightly 更新通道，0.2.0-rc.2 与 npm 侧 0.2.1-rc.2 未逐 API 对齐；只在四处关键面抽查过。
3. **视觉层级未验证**：桌面端有原生标题栏 overlay，可能与面板 top-layer 产生新的遮挡关系，需要看图确认。
4. **HMR**：桌面端对 `/plugins/*` 强制 `no-store`，`devWatch` 热更是否可用未验证（生产不受影响）。

## 纪律（写给以后改代码的人）

- 客户端**只用相对 URL**，不要出现 `http://127.0.0.1:…`、`location.origin`、`document.baseURI` 之类的绝对地址
  （桌面端页面 origin 是 `dsh-app://app`）。
- 宿主只用 `ctx.webServer.register(...)` + `connection.requestRejection(...)`，不要另开不含鉴权的入口。
- 需要区分桌面端时用 `window.dshDesktop` 探测（Electron preload 注入，只在 `dsh-app://app` 主框架存在），
  不要用 UA 或 origin 判断。
