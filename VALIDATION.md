# 某科学的Agent 0.5.0 验证记录

0.5.0 将 Work 执行画布改为无圆框的逐行轨迹。左侧主线引出每个步骤，工具名称后显示来自真实工具输入的短说明，细线连接状态和耗时，右侧汇合线标明同一轮执行的步骤序列。当前为单 Agent 串行引擎，画布不推断并行任务依赖。

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript 类型检查 | 通过 | `bun run typecheck` |
| 画布逻辑 | 4/4 通过 | `bun test webview/src/lib/execution-window.test.ts`；当前轮过滤、高度容量、运行中/授权节点保护、输入摘要 |
| 前端构建 | 通过 | `cd webview && bun run build` |
| OpenCode 基础链路 | 21/21 通过 | `bun run verify:phase1` |
| 后端与模拟模型集成 | 67/67 通过 | `bun run verify:integration` |
| 画布视觉样例 | 已检查 | 使用真实 React 组件和构建后的 CSS，在本地浏览器渲染深色、浅色、窄窗口样例；调整窄窗口布局后说明文字仍可见 |
| Windows 安装包 | 通过 | `bun run build` 产出 0.5.0 NSIS 安装包；静默安装退出码 0，安装目录中的程序版本为 0.5.0 |
| 安装版生命周期 | 13/13 通过 | `bun testing/verify-shell-lifecycle.ts`；后端身份、引擎就绪、技能注入、强制退出后无残留子进程 |
| 原生窗口内逐项点击 | 未完成 | 本机界面自动化服务仍返回 `nodeRepl.fetch request failed`；浏览器样例不等同于原生窗口点击验收 |
| 两类真实模型 | 本版未重跑 | 参考下方 0.4.0 历史记录 |

---

# 某科学的Agent 0.4.0 历史验证记录

0.4.0 增加 Work / Chat 双模式、具名多 API 配置及每份配置的多模型选择，更新窗口名称、应用图标和技能菜单图案。Chat 无需工作区；引擎请求不提供工具，并对伪造的工具调用做拒绝与界面过滤。

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript 类型检查 | 通过 | `bun run typecheck` |
| OpenCode 基础链路 | 21/21 通过 | `bun run verify:phase1`，固定引擎 1.18.31 |
| 后端与模拟模型集成 | 67/67 通过 | `bun run verify:integration`；覆盖多 API、不同模型、Chat 无项目、无工具、伪造写文件调用不落盘、凭证隔离与重启持久化 |
| 0.4.0 安装包 | 构建并静默安装通过 | `bun run build`；NSIS 退出码 0，安装目录 `%LOCALAPPDATA%\某科学的Agent` |
| 运行中覆盖安装 | 通过 | 修复安装器过早检查文件句柄的问题：预安装钩子先结束该目录的主程序，再等待外壳和引擎文件可独占打开；应用运行中静默覆盖安装退出码 0，安装后无残留进程 |
| 安装版生命周期 | 13/13 通过 | `bun testing/verify-shell-lifecycle.ts`；后端握手、引擎就绪、强制退出后无残留子进程 |
| 窗口名称 | 通过 | 安装后启动 `harness-shell.exe`，窗口标题为“某科学的Agent” |
| 窗口视觉交互 | 未完成 | 本机界面自动化服务返回 `nodeRepl.fetch request failed`，无法逐项点击验证；此项不计为通过 |
| 两类真实模型 | 本版未重跑 | 0.2.1 的双协议真实模型闭环见历史记录；0.4.0 多配置通过模拟模型集成测试 |

内部数据目录继续使用 `%LOCALAPPDATA%\Harness\data`，保留升级前设置与会话；显示名称、安装目录和图标已更新。
旧版 `Harness 0.3.0` 的卸载条目仍在系统中，当前安装不会自动删除它。因为旧安装路径中也有沿用的数据目录，清理旧版前应备份该数据目录。

---

# Harness 0.3.0 历史验证记录

验证日期：2026-09-24。此次版本新增 Codex 风格的项目与多对话侧栏、对话重命名/置顶/删除、在输入区直接选择工作区与模型，以及包含文件、文件夹、目标、计划模式和 20 个预置技能的“+”菜单。技能来源、固定提交和许可证见 `vendor/skills/MANIFEST.json` 与 `THIRD-PARTY-NOTICES.md`。

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| OpenCode 固定版本基础功能 | 21/21 通过 | `bun run verify:phase1` |
| 后端与前端类型检查 | 通过 | `bun run typecheck` |
| 后端集成测试 | 56/56 通过 | `bun run verify:integration`，包括项目分组、同目录多对话、重命名、置顶、计划/目标、会话模型切换、附件路径和预置技能被 OpenCode 原生 `skill` 工具发现 |
| Windows 发行构建 | 通过 | `bun run build` 生成 `Harness_0.3.0_x64-setup.exe` |
| 深浅主题界面 | 通过 | 在隔离数据目录的本地运行环境中检查新对话、项目弹窗、项目下对话、“+”菜单的深浅主题与窄窗口布局 |
| 安装包实际覆盖安装 | 通过 | 当前用户静默覆盖安装退出码 0；`%LOCALAPPDATA%\Harness\skills` 有 20 个技能目录 |
| 安装版启动与进程回收 | 13/13 通过 | `bun testing/verify-shell-lifecycle.ts "$env:LOCALAPPDATA\Harness\harness-shell.exe"`；0.3.0 握手、后端身份、引擎就绪、隔离数据目录技能注入、强制退出回收均通过 |
| 安装版图形界面人工点击 | 未执行 | 自动化已检查启动与资源；图形交互在开发环境实际屏幕检查 |
| 真实模型双协议闭环 | 此版本未重跑 | 0.2.1 的 OpenAI-compatible 与 Anthropic Messages 真实闭环见下方历史记录；0.3.0 新交互由模拟模型集成测试验证 |

本版来源包仅收录构建所需源码、锁定的引擎清单与 20 个有明确许可的技能。安装包内置 OpenCode 可执行文件与技能资源；来源包按 `HARNESS.md` 的步骤恢复锁定版本引擎后重建。安装版进程链与技能注入已经实测；窗口内完整交互和两类真实模型在 0.3.0 尚未重新验收。

---

# Harness 0.2.1 历史验证记录

验证日期：2026-09-23 至 24 日。环境：Windows 11、中文用户名、用户目录下安装。执行引擎为固定版本 OpenCode 1.18.31；版本和上游摘要见 `vendor/opencode/PIN.json`。0.2.0 的历史验证记录保留在 `VALIDATION-0.2.0.md`。

## 结果

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 固定引擎的基础功能 | 21/21 通过 | `bun run verify:phase1` |
| 后端、WebSocket、授权、事件、差异与持久化 | 46/46 通过 | `bun run verify:integration`；本地模拟模型，不能代替真实模型 |
| 外壳强制结束后的子进程回收 | 12/12 通过 | `bun testing/verify-shell-lifecycle.ts` |
| 安装器进程锁定探针 | 6/6 通过 | `testing/verify-installer-hooks.ps1` |
| OpenAI-compatible Chat Completions 真实模型闭环 | 通过 | `testing/real-model-openai-compatible-*.json`（仅本地生成，不打入源码包） |
| Anthropic Messages 真实模型闭环 | 通过 | `testing/real-model-anthropic-*.json`（仅本地生成，不打入源码包） |
| 运行中覆盖安装与重新启动 | 通过 | 安装器退出码 0；安装前主程序与引擎在运行，安装后均退出；再启动健康检查版本 0.2.1、实例 ID 一致 |
| 深浅主题切换与实机视觉检查 | 通过 | 侧栏即时切换；浅色重启保持；历史会话及差异面板在两种主题下可读；设置弹窗内切换不清空表单 |
| 无会话时保存配置 | 通过 | 侧栏“设置”打开独立设置弹窗，“保存配置”可点击并正常关闭，无需先填写工作区 |
| 测试 Key 明文落盘扫描 | 通过 | 退出应用后扫描 Harness 数据目录（包含 SQLite、日志和设置，排除可执行文件），无明文命中 |
| 运行中画布与授权卡片 | 通过 | 真实模型生成 `read` 与 `edit` 节点；`edit` 等待授权时切换主题，节点与授权状态保留；拒绝后节点失败且文件仍是原文；下一轮允许后文件变更，详情展示路径、参数与输出，授权按钮未被详情遮挡 |
| 缺少 WebView2 的全新 Windows 环境 | 未执行 | 本机已有运行时 |

## 真实模型闭环

两类协议分别使用用户提供的测试端点和模型，在临时 git 工作区运行同一验收脚本：

1. 模型读取 README、源文件和测试文件；
2. 请求修改授权，仅允许修改临时项目的 `Add.ps1`；
3. 修复错误后请求命令授权，仅允许 `powershell.exe -NoProfile -File ./test.ps1`；
4. 模型返回最终回复；独立再次运行测试，退出码 0、出现 `HARNESS_TEST_PASSED`；
5. 引擎差异记录显示 `Add.ps1` 变更 1 行。

两次均观察到三个 `read`、一个 `edit`、一个 `bash` 工具步骤；修改和命令各一次授权，最终状态 `completed`。验收脚本只记录协议、模型、步骤名、授权决定与测试摘要，不记录 Key、工具原始输出或完整模型回复。脚本执行前建立临时 git 初始提交，避免无基线时差异为空。

连接测试额外检查：错误 Key 正确归类为 `auth`；不存在的模型归类为 `model-not-found`；把 Chat Completions 指向 Anthropic 端点的空 404 归类为 `protocol-mismatch`。最初实机测试暴露出 Windows 系统代理未传入 Bun，以及引擎重启握手误读旧日志两处问题；均已在源码中修复。修复后两类真实闭环通过。

## 安装与进程

在安装前，`harness-shell.exe` 和 `harness-engine.exe` 正在运行。对 0.2.1 NSIS 包进行静默覆盖安装，安装器退出码 0，安装后无 Harness 进程残留。重新打开已安装应用，后端 `/health` 返回 0.2.1，实例 ID 与 `runtime.json` 一致；OpenCode 报告就绪，旧会话仍以只读归档显示。后端释放采用内容哈希路径，安装目录中的分发引擎文件不会被运行副本占用。

安装器 hook 会先停止本应用的进程，再对即将覆盖的文件做独占打开校验；无法取得独占句柄时会中止，而不是跳过关键文件。它不会按 `opencode.exe` 进程名清理用户自己的 OpenCode 安装。

## 自动化命令

在 `harness/` 内使用 Bun 1.3.13：

```powershell
bun run verify:phase1
bun run verify:integration
bun testing/verify-permissions.ts
bun testing/verify-shell-lifecycle.ts
powershell -NoProfile -File testing/verify-installer-hooks.ps1
bun testing/verify-real-model.ts  # 仅在已安装应用运行且设置页已保存可用凭证时执行
```

`bun run build` 生成前端、后端、Tauri 外壳和 NSIS 安装包；`bun scripts/package-source.mjs` 生成可重建的源码快照；`bun scripts/build.mjs --delivery-only` 刷新文档与 SHA-256 清单。交付物集中在 `delivery/0.2.1/`。

## 限制

- OpenCode 1.18.31 对 `exit` 等部分内置命令不一定弹出 `bash` 授权。实际副作用命令的授权、拒绝与停止已在模拟端到端测试中验证；若未来要求每条命令都强制确认，需要在引擎层补充统一策略。
- 差异依赖 git 基线；非 git 工作区可能无文本差异。
- 外壳运行于用户当前 Windows 会话；本机无法证明缺少 WebView2、Bun、Node 和 OpenCode 的全新机器上的安装行为。
- 真实模型闭环使用临时项目，未对用户实际项目执行修改。
