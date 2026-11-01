# 贡献指南 / Contributing

> English summary at the bottom.

这是一个 **DSH（DeepSeek Harness）Web 插件**：在工具调用等待审批时，让用户同时向「执行任务的 AI」和
「自动审查 AI」提问。改动集中在 `lib/`（宿主 `impl.js` + 浏览器 `client.js`），没有构建步骤。

## 环境

- Node.js ≥ 20（仓库 CI 用 Node 20 / Ubuntu + Windows）
- DSH `0.2.1-rc.x`（Web 形态；`dsh web` 启动后默认 `http://127.0.0.1:3456`）
- 可选：`@deepseek-ai/dsh-experimental-auto-review`（审查 AI 通道）、`dsh-approval-timeout`（倒计时联动）。
  两者都**不是必需**：缺任何一个插件时对应 UI 会整体隐藏，这是必须保持的兼容性约定。

## 本地开发

1. 把仓库 link 进你的 DSH profile（`<profile>/package.json` 依赖里写 `"dsh-approval-consult": "link:<repo>"`，
   并在 bundle 里启用），或直接把仓库放进 `<profile>/plugins/`。
2. 重启 `dsh web`。
3. 打开面板：审批等待时点击右上角胶囊「审批有疑问？」。
4. 没有真实审批时，用**演示模式**迭代 UI：

   ```text
   http://127.0.0.1:3456/?consult-demo=1          # 完整（两侧都有材料）
   http://127.0.0.1:3456/?consult-demo=no-reviewer # 模拟没装自动审查插件
   http://127.0.0.1:3456/?consult-demo=no-executor # 模拟执行侧上下文不可用
   http://127.0.0.1:3456/?consult-demo=advisory    # 有材料但没有官方审查结论
   http://127.0.0.1:3456/?consult-demo=error       # 模拟 /context 失败 + 重试
   http://127.0.0.1:3456/?consult-demo=0           # 关闭演示
   ```

   演示模式不访问宿主、不发真实请求；问答是本地伪造的流式输出。
5. 需要热重载 / 排障接口时，在 `<profile>/cordis.patch.yml` 里覆盖（**默认值必须是关闭的**）：

   ```yaml
   - id: approval-consult
     name: 'dsh-approval-consult'
     config:
       devWatch: true
       devTools: true
   ```

   `devTools` 打开后可用 `GET /dsh-approval-consult/diag`、
   `POST /dsh-approval-consult/debug/synthetic-approval`（自造一条 pending）、
   `POST /dsh-approval-consult/debug/drop-pending` 等排障路由。

## 测试

```bash
npm test        # tests/unit.mjs（宿主纯函数）+ tests/locale-parity.mjs（zh/en 键对齐）
npm run check   # node --check lib/{index,impl,client}.js
```

提交前请让两者全绿。改到 UI 行为时，建议在 1440×900 与 390×844 两个视口各点一遍
（见 `docs/CLIENT-CONTRACT.md` 的验收项与 `docs/UI-NOTES.md` 的自测表）。

## 代码结构

```
lib/index.js     # 稳定入口 shim（dynamic import + 可选 devWatch）
lib/impl.js      # 宿主：捕获主/审查请求、侧调用、HTTP 路由、注入、能力检测、预设存储
lib/client.js    # 浏览器端：胶囊 + 抽屉/底部弹层 + 常用问题编辑器（无构建，React.createElement）
lib/review-policy.txt  # 官方 REVIEW_POLICY 兜底副本（运行时优先用捕获到的真实策略）
tests/           # 纯函数单测、locale 对齐、策略抽取
docs/            # 契约、兼容性、验收记录、发布清单
```

**改接口前先读 [`docs/CLIENT-CONTRACT.md`](docs/CLIENT-CONTRACT.md)**：它是客户端/宿主之间的唯一事实来源，
包括 `/context`、`/ask`、`/poll` 的字段语义与降级约定。

## 提交约定

- 一个提交做一件事；信息可以用中文或英文，能看懂即可（建议 `feat:` / `fix:` / `docs:` / `chore:` 前缀）。
- 不要提交：`node_modules/`、`data/`、日志、本机绝对路径、真实会话内容、token。
- 提交者身份请用匿名邮箱（例如 `noreply@users.noreply.github.com`）：
  `git config user.name "…" && git config user.email "…@users.noreply.github.com"`。

## PR 检查清单

- [ ] `npm test && npm run check` 通过
- [ ] 新增文案：`locale/zh.json` 与 `locale/en.json` 键完全对齐（`tests/locale-parity.mjs` 会检查）
- [ ] 缺插件（auto-review / approval-timeout）时仍然正常工作，且**不出现任何提示"未安装"的字样**
- [ ] 新增配置项默认值安全（不能默认打开 devTools / devWatch / 自动批准）
- [ ] 新增 HTTP 路由同源 + 鉴权，且不写包目录、不记录会话正文
- [ ] 改到用户可见行为时同步更新 `README.md` / `docs/`，必要时更新 `docs/assets/` 截图
- [ ] 主题兼容：亮色 / 暗色 / 自定义壁纸主题（面板自带不透明 surface，不依赖 `--dsw-alias-bg-base`）

## 行为准则

保持讨论就事论事：不人肉、不公开他人会话内容与凭据；安全问题走私有报告（见 [`SECURITY.md`](SECURITY.md)）。

---

## English summary

This repository is a **plugin for the DSH Web UI**: while a tool approval is pending, the user can ask
both the executing AI and the auto-review AI. No build step — `lib/impl.js` is the host plugin,
`lib/client.js` the browser client, tests are plain Node scripts.

- Dev: link the repo into a DSH profile, restart `dsh web`, then use `?consult-demo=1`
  (or `no-reviewer` / `no-executor` / `advisory` / `error`) to iterate the UI without a real approval.
- Test: `npm test` (unit + locale parity) and `npm run check` (syntax).
- Read [`docs/CLIENT-CONTRACT.md`](docs/CLIENT-CONTRACT.md) before changing any host/client field.
- Both optional plugins (`experimental-auto-review`, `approval-timeout`) must stay optional:
  when missing, the related UI is hidden silently — no error, no "not installed" message.
- Keep defaults safe (`devTools`/`devWatch` off), never commit credentials, local paths or session data.
- Security reports: private vulnerability report, see [`SECURITY.md`](SECURITY.md).
