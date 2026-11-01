# 发布前检查清单（PUBLISHING）

> 目标：把 `dsh-approval-consult` 作为独立、通用、可维护的开源 DSH 插件发布（npm + GitHub）。
> 当前状态：**本地功能完成，尚未发布**。下面是发布前还缺的东西和已完成的项。

## 已完成（2026-11-01）

- [x] 安全默认值：`devWatch: false`、`devTools: false`（排障接口默认关闭；本地开发用 profile patch 覆盖）
- [x] `package.json` 发布元数据：去掉 `private`、license MIT、engines、exports、files、scripts（`test`/`check`）、keywords
- [x] `LICENSE`（MIT）、`NOTICE.md`（DSH / auto-review 的 MIT 归属与策略文本来源）
- [x] `.gitignore`（`node_modules/`、`data/`、日志、本地截图）
- [x] 测试：`tests/unit.mjs`（25 项）+ `tests/locale-parity.mjs`（186 key zh/en 对齐）
- [x] CI：`.github/workflows/ci.yml`（Ubuntu + Windows，Node 20）
- [x] `docs/COMPATIBILITY.md`（环境矩阵、必需/可选扩展面、缺插件降级、隐私）
- [x] 用户数据改为与包目录无关（默认 `~/.dsh-approval-consult`；`--profile` 时用 profile 数据目录；
      支持 `dataDir` 配置 / `DSH_APPROVAL_CONSULT_DATA`；旧包内文件自动迁移），npm 升级不丢配置
- [x] 运行时自动同步官方审查策略（避免 DSH 升级后内置 policy 过期）
- [x] 槽位缺失时降级（只告警，不拖垮页面）
- [x] `CHANGELOG.md` 1.0.0
- [x] `README.en.md` 英文简版 + `docs/assets/` 截图（相对路径）

## 发布前还需要

- [ ] **GitHub 仓库**：建仓库、`git init`、首提交；把 `docs/assets/` 的截图提交进去。
- [x] **README 双语**：`README.md`（中文，主）+ `README.en.md`（英文简版）；截图改用相对路径。
- [ ] **npm 包名**：确认 `dsh-approval-consult` 可用（`npm view`；本机 npm 被 PowerShell 执行策略拦住，需用 `cmd /c npm view`）；
      如不可用改 scoped（`@<user>/dsh-approval-consult`）并同步包内 `name`、README、安装示例。
- [ ] **版本**：从 `0.x` 开始还是直接 `1.0.0`（当前 1.0.0；首个公开版本可考虑 0.1.0 以示 API 未冻结）。
- [ ] **发布 dry-run**：`npm pack --dry-run` 检查 `files` 列表没有漏（`lib/`、`locale/`、`icon.svg`、`cordis.patch.yml`、LICENSE/NOTICE）。
- [ ] **安装即用验证**：
      在一个干净 profile（`dsh` 新 profile）里 `install_bundle` 安装本包，不依赖任何本地开发文件；
      验证无 `auto-review`、无 `approval-timeout`、无网络时分别的降级行为。
- [ ] **真实浏览器矩阵**：Chrome / Edge / Firefox（Firefox 的 Popover 支持情况需验证；
      若不支持会退化为 fixed 层）、亮色主题、iPhone 真机键盘。
- [ ] **License 合规复查**：确认 `lib/review-policy.txt` 的 MIT 归属已在 NOTICE 写明（已写），
      发行包内附 LICENSE + NOTICE。
- [ ] **安全审查**：确认发布包不含 `data/`、日志、本机路径；`/debug/*` 默认不可用；
      HTTP 路由全部经 `connection.requestRejection` 鉴权。
- [ ] **文档**：把 `docs/VERIFICATION.md`、`docs/DOGFOOD.md`、`docs/PATCHES.md` 里的个人绝对路径
      改写成相对路径或 `<profile>` 占位（`PATCHES.md` 是用户机器上的第三方补丁，发布仓库里应改成
      可选的“已知问题与上游补丁建议”，不指向作者本机路径）。
- [ ] **社区文件**：`CONTRIBUTING.md`、Issue/PR 模板（可选）、`SECURITY.md`（可选）。

## 不在 1.0 范围（后续版本）

- 面板内上传附件/图片（见 `docs/BACKLOG.md` 4.5；依赖模型多模态能力，需要先探测 provider 支持）。
- advisory 自动评估开关（manual / on-open / background）。
- “决定附言”（拒绝/允许时附一句原因给执行 AI）。
- 真机 iPhone 键盘 / safe-area 回归、Firefox 兼容。

## 发布步骤（建议）

1. 完成上面“还需要”的项；`npm test && npm run check` 全绿。
2. `npm version <x.y.z>` + 更新 CHANGELOG。
3. `npm publish --access public`（或先 `npm pack` 本地安装验证）。
4. GitHub Release 附 `docs/assets/` 截图与 CHANGELOG。
5. 在 README 顶部写清“DSH 版本范围 / 可选插件 / 安全默认值 / 数据路径”，避免用户踩坑。
