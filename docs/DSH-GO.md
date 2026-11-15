# DSH Go 适配

原生面板兼容 [DSH Go v1.0.15](https://github.com/ccch1mneyyy/dsh-Go/releases/tag/v1.0.15)，固定源码提交 `a9877420ab9aee121134faf01b6a92a39ce0b05b`。本插件 v1.3.1 是本地候选包，包含之前的 DSH 0.2.2-rc.2 适配，尚未发布。原生审批卡按钮的配套 App 改动基于 2026-11-14 获取的 Go main `970f081b0d9c89cdb350fd84086d995c6104ab80`（源码版本 1.0.16），作为独立补丁交付。

## 本机原生面板

同一 npm 包保留 `dsh.client`，新增 `dshGo` 清单。宿主可选注入 `dshGo`，普通 DSH 没有桥接时不影响 Web 插件。原生界面由 Go 的 JSON 视图渲染，不加载浏览器 JS，也不需要 Flutter 或 SDK 运行时依赖。

修改后的 Go App 在独立审批卡和工具消息内的审批卡显示「咨询」，点击直接打开已有原生 sheet，自动定位该审批。按钮要求插件 **1.3.1+**、可达的本机桥接、已启用且就绪的原生面板，以及审批请求的 `callId`。无条件时不影响原来的批准／拒绝操作。会话操作中的「审批咨询」和会话插件页继续保留。

**按钮属于 Flutter App 改动，需要构建并安装配套 Go App，同时升级插件。只安装本 npm 包不会修改已发布 App 的原生卡。** 普通 Go v1.0.15 仍通过会话入口使用面板。

1. 从审批卡进入时无需选择；会话入口仍手动选择记录。查看工具、调用标识、状态和参数／理由摘要。
2. 选择执行 AI 或审查 AI，输入问题后显式发送。可以连续追问、重新评估、停止所选审批的咨询任务。
3. 最近回答提供实时摘要；所选审批的全部问答可翻页，长回答分页阅读、刷新和复制。结束后的记录可只读回看。
4. 批准／拒绝仍在 Go 自带的审批卡完成。原生插件不提供授权 effect。

输入采用原生多行 `textField`，选择器、软键盘、返回键、焦点和 sheet 关闭均由 Go 管理。插件不刷新整个视图来追逐每个 token。问题上限为 600 个 Unicode 标量，同时遵守宿主 `maxQuestionChars` 和 Go 4 KiB 动作预算；超过上限不截断发送。

选择和草稿属于当前客户端视图。服务端不按 session 保存一个共享“当前选中的审批”，多个设备不会互相改变提问目标。所有动作都以 bridge 提供的 `scope.sessionId` 校验记录归属，忽略动作里伪造的 sessionId。

卡片入口额外按 `scope.callId` 过滤并固定记录；PTC 使用内层调用，不能把根调用当作目标。记录尚未到达时等待并锁定输入，后续其他审批不能改写已有草稿的目标。重连重新定位同一调用并保留客户端草稿，不自动提问。Go 侧将主机归属绑定到面板和数据订阅，切换主机后提示返回，旧订阅不向新主机发送原会话／调用标识。

提问和重新评估立即启动宿主任务后返回，避免等待模型超过 Go 的 3 秒动作时限。数据源每 500ms 检查变化，只推送有变化的、有界摘要；订阅结束和插件卸载都会清理定时器。重新订阅只读取已有记录，不自动重放 ask/review。回答页是点按时的快照，可用「刷新本页」更新；实时摘要继续推送。

本阶段原生面板以文字咨询为范围；图片、预设问题编辑、双问、转达审查回答和自动暂停倒计时仍使用 Web 面板。关闭原生面板不等于停止模型；需要停止时点「停止回答」。审批真正结束时由现有宿主生命周期中止任务。进程重启或记录 TTL 到期不保证保留内存中的咨询全文。

## 安装候选包到手机本机引擎

把候选包解压后的**整个目录**放到手机本机环境，例如 `/root/.dsh/dsh-go/plugins/dsh-approval-consult/`，目录内应直接包含 `package.json` 与 `lib/`。然后在 Go 的本机终端执行：

```sh
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dsh-approval-consult
```

目录是链接安装，必须保留。升级已加载的 `lib/` 代码后在 Go 的「引擎」页重启引擎，再打开会话中的「审批咨询」。这是上游的[本地插件安装方式](https://github.com/ccch1mneyyy/dsh-Go/blob/v1.0.15/docs/plugins/hosts.md)；本轮只在开发机产出了候选包，没有向手机安装。

Go 的本机运行时自带桥接。SSH 原生桥接和中转模式不在本次支持范围；Web 手机端优化可以用于普通浏览器以及 Go 内的 WebView。

## Web 手机端

- 同时读取 `VisualViewport` 和 Go 的 `window.__dshAppKeyboard`，取遮挡区域的并集，避免重复扣除键盘高度。观察 Go 的键盘／安全区样式节点，覆盖 WebView 不缩高和旋转场景；缩放视口不误判为键盘。
- 短视口保留提问对象、输入、发送／停止和关闭；键盘收起、空间恢复后显示完整内容。主要触摸按钮至少 44px。手机横屏和粗指针设备的 Enter 始终换行；IME 组合输入不发送。
- Go 先 blur 输入框再向 body 派发 Escape 时，只在咨询面板为最后一个可见模态层时处理。监听仅在面板挂载期间有效，不接管其他审批或菜单的返回键。
- 离线／退到后台暂停读取；联网、回到前台或页面恢复时先取完整 context，再按 UTF-16 文本游标续读。草稿和待发图片仍留在当前页面。
- 网络错误和 502/503/504 采用 0.5–5 秒退避重试只读请求；GET 超时 15 秒。业务错误直接展示。旧面板或停止后的成功／失败响应都不能写回。
- ask 确认丢失时用 `requestId` 将本地占位与宿主线程合并。不会自动重发 POST；手动重试未确认请求时沿用标识，宿主核对目标、问题和附件后返回原任务。宿主重启／记录回收后不提供跨进程幂等保证。

## 验证

```sh
npm test
npm run check
npm run test:go -- /path/to/dsh-Go
node /path/to/dsh-Go/sdk/plugin-kit/bin/check.mjs . --load

# 可选：隔离安装浏览器测试依赖，不加入插件运行时依赖
npm install --prefix .test-browser --ignore-scripts --no-audit --no-fund react@19.2.0 react-dom@19.2.0 playwright@1.56.1
node .test-browser/node_modules/playwright/cli.js install chromium
npm run test:browser -- .test-browser /path/to/dsh-Go .browser-results
```

`test:go` 使用固定 Go 源码的 manifest、view、effect 验证器及真实返回脚本。`test:browser` 使用真实 React 与 Chromium、模拟的 DSH 服务，检查竖屏／横屏键盘区域、Enter、返回、断线恢复和草稿留存；可用 `DSH_BROWSER_EXECUTABLE` 指向本地 Edge/Chrome。

本轮使用 Windows x64 的 Flutter 3.47.7／Dart 3.13.5 运行真实组件测试；测试使用本机假桥接及插件实际生成的面板 fixture。没有 Android 设备、ADB 或真实模型 profile，未构建或安装 APK。原生键盘／系统返回／App 进程恢复仍需在手机安装后验收：输入中文未选词时按返回、先收键盘再关 sheet、切换审批／会话、飞行模式期间完成回答、重新联网、审批结束后再次发送、切换到其他主机。组件测试中的键盘遮挡和浏览器视口均为模拟，不是真机输入法验证。
