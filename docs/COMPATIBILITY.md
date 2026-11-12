# 兼容性说明（COMPATIBILITY）

> 最后更新：2026-11-12。rc.2 的验证为官方源码核对与自动测试，实机验收范围另见 `VERIFICATION.md`。

## 1. 运行环境矩阵

| 项 | 已验证 | 说明 / 兜底 |
| --- | --- | --- |
| DSH 实现 | `0.2.1-rc.2`、`0.2.2-rc.1` 历史实机；`0.2.2-rc.2` 自动验证 | rc.2 官方提交 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`；真实模型与 UI 未复测 |
| Node | `>=20.0.0`（`package.json` engines） | 宿主实现只用 Node 内置模块（`node:fs`/`node:path`/`node:url`/`node:crypto`）；注意 DSH 0.2.2 宿主本身要求 Node >=24.9 |
| OS | Windows 11（真实），路径处理用 `node:path` | 无平台专属调用；macOS/Linux 预期可用（未实机验证，CI 跑 Ubuntu/Windows） |
| 浏览器 | Microsoft Edge / Chrome（Chromium 120+） | 依赖 `HTMLElement.showPopover` 时自动降级为 fixed 层；`color-mix()` 失败时回退到 CSS 变量兜底色 |
| 屏幕 | 桌面 1440×900 / 2552×1234；手机 390×844 | 面板宽度 `min(468px, 100%)`；窄屏为底部弹层 |
| 主题 | 深色、浅色（token）、自定义壁纸主题（`--dsw-alias-bg-base: transparent`） | 面板自带不透明表面色，不依赖可能透明的主题底色 |
| 语言 | 简体中文、English（212 个 key 完全对齐） | 跟随 DSH locale；`ctx.locale.bind(NS)` 提供文案；缺少 key 时回退 key 字符串 |

## 1.1 DSH 0.2.2 的额外宿主要求

0.2.2 把「原生工具执行 / PTC 工具执行」拆成了独立插件。只升级 DSH 而不挂载执行器时，
宿主的原生工具不会注册（agent 工具列表会少掉一批，`pwsh` 等会变成 `unknown tool`，
自动审查也会报 `pending native tool schema is missing or ambiguous`）。这是**宿主配置问题**，
与本插件无关；插件只要求：

- 原生工具执行已挂载：`@deepseek-ai/dsh-tool-executor-native`（在 profile 的 composition /
  `cordis.patch.yml` 里与 `dsh-tools` 同 scope 插入）；
- 本插件依赖的扩展面（见第 2 节）在 0.2.2-rc.1 中签名不变（已核对 `.d.ts` 与实机冒烟）。

## 1.2 DSH 0.2.2-rc.2

- 自动审查的 `messages` 从单条四段材料改为环境消息加逐条 JSON。最后一条为 pending tool-call，之前最近的同 mode/name tool-schema 提供定义；插件同时支持新旧格式，追问不修改捕获前缀。
- 同步 rc.2 `REVIEW_POLICY`；从日志生成的 advisory 材料仍是保守重建，不代替官方授权。参数、schema 或路由缺失时不可用；不会把截断 JSON 当作完整证据。
- 子代理创建文本按 direct-parent-instruction/fact 分类，普通用户/SDK 文本按 user-instruction 分类，图片保持 fact，项目约束保持 constraint。
- 侧调用保留会话身份并使用 `purpose: approval-consult`；主请求捕获排除 auxiliary purpose，复制后的侧调用也不会再次捕获。
- Cordis `FiberState.ACTIVE`（2）才表示可选插件正在运行；PENDING/FAILED 等状态不开放对应入口。
- `approval/request`、`tools/pre-execute`、`llm/stream`、`agent.inject()`、`PendingApproval.answer()`、`uiSession.adapter.current`、`sessionStatus` 与所用 slots 已核对源码。插件未包装 `Session.append()`，无需迁移 rc.2 的批量追加重载；未使用新版变更的锚点浮层定位 API。
- CI 覆盖 Ubuntu/Windows × Node 20/24；Node 24 另外从固定提交加载官方纯函数，重放 native/PTC 审查请求并核对策略副本。

## 2. DSH 扩展面（必需）

| 面 | 用途 | 缺失时行为 |
| --- | --- | --- |
| `ctx.on('llm/stream')` | 捕获主对话前缀、auto-review 审查请求前缀 | 仍能登记 pending，但无法向两侧提问（会明确提示“上下文不可用”） |
| `ctx.on('tools/pre-execute')` | 记录待审批调用的参数（工具参数卡片 / 审查材料） | 工具参数与部分审查材料缺失，审查侧可能显示不可用 |
| `ctx.on('approval/request')`（prepend） | 在浏览器应答者之前登记 pending | 咨询台不会出现（没有入口） |
| `ctx.webServer.register({kind:'exact'})` | `/dsh-approval-consult/*` HTTP 路由 | 宿主整体不可用，客户端显示可重试错误 |
| `agent.inject()` | 把执行 AI 问答写入会话 | 问答仍可看，但显示“保存到会话失败”（不静默） |
| `shell.overlay` slot | 胶囊 + 面板入口 | 仅告警；面板不出现（不会崩溃页面） |
| `conversation.chat.turnTail` slot | 对话流末尾「💬 审批咨询记录」入口 | 仅告警；仍可在面板内看线程 |
| `ctx.locale` | 文案注册/绑定 | 回退 key 字符串（英文 key 形式） |
| `ctx.uiSession`（sessionStatus / adapter.current） | 当前会话与 PendingApproval | 降级为仅 demo 模式渲染 |

## 3. 可选依赖（自动检测，缺了也不报错）

| 插件 | 检测方式 | 已安装 | 未安装 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-experimental-auto-review` | cordis registry 里的 plugin runtime name（`experimental-auto-review`） | 双通道可用；优先复用捕获到的审查请求 | 只保留「执行 AI」通道，隐藏审查 tab/双问/审查文案，`/ask`(reviewer) 与 `/review` 返回 409 |
| `dsh-approval-timeout` | registry name（`approval-timeout`） | 显示倒计时 chip/提示条，可暂停；自动暂停遵守“防误伤其它审批”规则 | 客户端**一次请求都不发**，不显示任何倒计时内容（无“未安装”提示） |
| `dsh-notify` / `dsh-web-mobile-fix` 等 | 无依赖 | 无影响 | 无影响 |

补充：

- `reviewerMode: auto | on | off` 可强制审查能力；`timeoutAutoPause: on-send | on-open | off` 控制倒计时暂停策略。
- 自动审查策略会在捕获到真实审查请求时**自动同步**（`/diag.config.reviewPolicySource = captured`），
  避免 DSH 升级后 `lib/review-policy.txt` 过期；未捕获时使用内置副本。

## 4. 与其它插件冲突面

- **不修改**官方审批卡片 DOM、不接管 `approval/request` 的 `next()` 结果、不改 `req.signal`、
  不监听全局键盘、不读其它插件 DOM。
- 路由前缀独立（`/dsh-approval-consult/*`），slot id 独立（`approval-consult-*`），
  CSS 只注入一份 `<style data-plugin="dsh-approval-consult">`。
- 与 `dsh-approval-timeout` 的交互仅通过它的公开 HTTP 路由；对它的客户端补丁见 `docs/PATCHES.md`
  （本仓库不包含该插件）。
- 唯一已知耦合：审批等待期间官方 composer 被隐藏（`display:none`），所以入口挂在 `shell.overlay`，
  不依赖 `conversation.input.dock`。

## 5. 数据与隐私

- 会话内容不会写入本插件自己的文件；线程保存在宿主内存（TTL 默认 2h，随进程/审批结束消失）。
- 自定义常用问题写入用户数据目录，优先级：
  `dataDir` 配置 / `DSH_APPROVAL_CONSULT_DATA` > `$DSH_PROFILE_DIR/data/approval-consult` >
  `--profile` 推导的 `<home>/.dsh/profiles/<name>/data/approval-consult` > `<home>/.dsh-approval-consult`。
  这样 npm 安装升级不会覆盖用户配置；旧版写在包内 `data/presets.json` 的配置会自动读取并迁移。
- 提问会把相应上下文发送给当前会话使用的模型服务商（与主对话相同的 provider/route）。

## 6. 升级 DSH 后的自检

```bash
npm test          # 单元、安全、生命周期、兼容性、客户端竞态、locale/CSS
npm run check     # 语法检查
# Node >=24.9，传入 rc.2 官方源码目录：
npm run test:upstream -- /path/to/deepseek-harness
```

然后人工冒烟（5 分钟）：触发一次审批 → 胶囊/面板出现 → 执行 AI 预设问题流式回答 → 审查 tab →
拒绝/允许 → 历史入口可见。若官方审查策略或 approval/request 结构变化，`/diag` 与肉眼看板会暴露。
