# DSH Go 适配

官方 DSH Go 的本机引擎可以在聊天页打开原生咨询面板。已发布的插件 v1.3.1 支持右侧栏「信息 → 审批咨询」和「对话详情 → 插件」。本分支在聊天输入框的「＋」菜单增加了「审批咨询」，直接打开同一个底部面板。这个入口随插件安装生效，适用于官方 v1.0.15、v1.2.0 的原生插件协议。[v1.3.1 发布包](https://github.com/0tests/dsh-approval-consult/releases/tag/v1.3.1) · [Go 的插件入口](https://github.com/ccch1mneyyy/dsh-Go/blob/v1.2.0/docs/plugins/slots.md#L103-L129)

## 在审批卡旁咨询

1. 看到待审批卡时，点聊天输入框「＋ → 审批咨询」。加号适用于可编辑、已连接的会话。若插件磁贴已满，从右侧栏「信息」打开。
2. 加号传入当前会话。面板在确认只有一项待审批时预选；多项时按工具名、调用标识和参数摘要选择。支持卡内入口的宿主额外传入 `callId`，嵌套工具按内层调用定位。
3. 选择执行 AI 或审查 AI，输入问题后发送。面板支持追问、重新评估、停止回答、翻页与复制。编辑页是当前设备的快照，可点「重读审批列表」核对最新状态；「实时回答」单独订阅同一会话的进展。收起面板后，在原审批卡点「允许一次」或「拒绝」。
4. 已结束的记录可只读回看。咨询全文保存在引擎内存；重启进程或记录过期后，仅能从会话日志恢复仍可识别的审批材料。

审批选择与阅读位置保存在当前设备。每次提问都按宿主提供的会话、选中的咨询记录及审批状态校验。打开或刷新面板只读取数据，产生模型调用需要显式提问或重评。原生面板使用 Go 的多行输入控件；单个问题上限为 600 个 Unicode 标量，同时遵守宿主字符限制和 Go 的动作大小限制。图片、预设编辑、双问和转达可在完整 DSH Web 面板使用。

## 安装到手机本机引擎

测试本分支时，可下载 PR 分支的源码，或在检出目录运行 `npm pack` 并解压。把包含 `package.json` 与 `lib/` 的整个插件目录放在手机本机环境，再在 Go 的本机终端执行：

```sh
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dsh-approval-consult
```

本地目录是链接安装，升级时更新同一目录。在当前回复或审批结束后，到「引擎」页重启一次，再进入聊天。插件代码和入口已经包含在上述目录里，无须重新下载或安装 App。当前 npm／GitHub Release 的 v1.3.1 使用会话入口；要测试加号请选择包含本次修改的源码。[上游安装指南](https://github.com/ccch1mneyyy/dsh-Go/blob/v1.2.0/docs/plugins/hosts.md#L13-L33)

官方 App 的批准／拒绝按钮由 Flutter 绘制。卡内加入第三个按钮需要宿主支持；本分支使用宿主已有的加号入口。手机本机运行时自带桥接。SSH／中转的原生能力取决于上游支持；能打开完整 DSH Web 的连接可使用 Web 咨询胶囊。[审批卡渲染](https://github.com/ccch1mneyyy/dsh-Go/blob/v1.2.0/app/lib/ui/chat/widgets/approval_card.dart#L126-L179) · [主机支持表](https://github.com/ccch1mneyyy/dsh-Go/blob/v1.2.0/docs/plugins/hosts.md#L3-L9)

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

本分支的回归使用官方 Go 协议、模拟宿主和 Chromium。手机验收时按顺序检查：在官方 App 安装插件、重启本机引擎、在新审批卡旁打开加号、中文输入与返回、多项审批与其他设备同时选择、断线后核对上次发送、结束后再发送，以及切换主机。历史 Flutter 组件测试记录见 [验收记录](VERIFICATION.md)。
