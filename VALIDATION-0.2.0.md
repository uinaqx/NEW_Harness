# 验证报告

本文件逐项记录验收结果，并严格区分 **通过 / 失败 / 未执行**。
凡使用本地模拟模型服务（`testing/mock-provider.ts`）的测试，**都不能替代真实模型验收**。

- 产品版本：0.2.0
- 执行引擎：OpenCode **1.18.31**（固定版本，见 `vendor/opencode/PIN.json`）
- 验证环境：Windows 11，中文用户名与含空格路径
- 报告时间：2026-09-21

---

## 0. 结论速览

| 范围 | 状态 | 证据 |
| --- | --- | --- |
| 阶段 1：引擎固定版本与最小接入 | **通过 21/21** | `testing/phase1-validate.ts` → `phase1-report.json` |
| 阶段 2：统一引擎适配层 | **通过** | `testing/integration-harness.ts`（46/46） |
| 阶段 3：模型设置与凭证管理 | **通过（模拟端点）** | 同上 |
| 阶段 4：进程生命周期与本地通信 | **通过** | 集成 46/46 + `testing/verify-shell-lifecycle.ts`（12/12） |
| 阶段 5：事件驱动画布与授权 | **后端侧通过**；界面交互项见第 5 节 | 同上 |
| 阶段 6：会话、差异与旧数据 | **差异/历史通过**；迁移路径见第 5 节 | 同上 |
| 阶段 7：Windows 构建与交付 | **通过（构建）**；安装验收见第 6 节 | `scripts/build.mjs` → `delivery/` |
| 真实模型验收（两类协议） | **未执行** | 无可用凭证，见第 4 节 |
| 安装包实际安装验收 | **未执行** | 见第 6、8 节 |

**最重要的一句话**：当前执行链已完全由 OpenCode 承担，旧手写 Agent 循环
（`agent.ts` / `llm.ts` / `tools.ts` / `approvals.ts`）已从生产路径移除；
但**真实模型**与**安装包实际安装**两项验收需要额外条件，本报告不把它们写成通过。

复现全部自动化验证：

```bash
cd harness
bun run verify:phase1       # 21/21
bun run verify:integration  # 46/46
bun testing/verify-shell-lifecycle.ts   # 12/12（需先 bun run build）
```

---

## 1. 阶段 1：引擎固定版本与最小接入

脚本：`bun testing/phase1-validate.ts`（本地模拟 OpenAI 兼容服务）
报告：`testing/phase1-report.json`

| # | 验证项 | 结果 |
| --- | --- | --- |
| 1 | 启动握手：从 stdout 解析出实际监听地址 | 通过 |
| 2 | 仅监听 `127.0.0.1` | 通过 |
| 3 | 端口为动态分配（非 4096 回落值） | 通过 |
| 4 | `path.get()` 回报的工作目录等于请求的工作区 | 通过 |
| 5 | 自定义 OpenAI 兼容 Provider 注册成功 | 通过 |
| 6 | 在指定工作区创建会话 | 通过 |
| 7 | `edit` 权限请求送达并被「允许本次」 | 通过 |
| 8 | 批准后 write 工具真的写出了文件 | 通过 |
| 9 | `bash` 权限请求送达并被「拒绝」 | 通过 |
| 10 | 拒绝的决定交回引擎，工具以 error 结束（未伪造结果） | 通过 |
| 11 | 最终助手文本返回 | 通过 |
| 12 | 观察到增量文本（流式） | 通过 |
| 13 | 取消进行中的回合，且不挂死 | 通过 |
| 14 | 完整消息历史可读回（9 条） | 通过 |
| 15 | `session.diff` 能报告该回合的文件变更 | 通过 |
| 16 | 工具 part 携带 filepath / diff 元数据 | 通过 |
| 17 | 观察到 `session.diff` 事件 | 通过 |
| 18 | 观察到 `message.part.updated` 增量事件 | 通过 |
| 19 | 观察到会话生命周期（status / idle） | 通过 |
| 20 | 断开后重新订阅仍能收到事件（23 条） | 通过 |
| 21 | 引擎重启后会话仍在 | 通过 |

### 实测到的引擎行为（实现依据；与 SDK 类型定义不一致处一律以实测为准）

- `opencode serve --port=0` **不会**使用临时端口，会回落到 4096 → Harness 自行预留空闲端口后显式传入。
- 启动握手 = stdout 的 `opencode server listening on http://127.0.0.1:<port>`。
- 认证为 **HTTP Basic**：用户名 `OPENCODE_SERVER_USERNAME`（默认 `opencode`）、密码 `OPENCODE_SERVER_PASSWORD`；
  未设置时引擎打印 `server is unsecured` 并完全放行。SSE `/event` 同样需要该头。
  Harness 使用**随机的用户名 + 随机的密码**。
- 运行时事件名与 SDK 类型定义存在差异（原始样例见 `testing/opencode-event-samples.json`）：
  `permission.asked`（类型定义写作 `permission.updated`）、`message.part.delta`（类型定义未列出）、
  `server.heartbeat`、`file.edited`、`file.watcher.updated`，以及噪声事件
  `plugin.added`（单次运行 45 条）、`catalog.updated`、`reference.updated`、`integration.updated`。
- 工具非零退出码**不体现在** `state.status`（仍为 `completed`），只在 `state.metadata.exit` 中。
- `GET /session/{id}/diff` 不带 `messageID` 返回 `[]`，必须按「用户消息回合」传 `messageID`。

---

## 2. 端到端集成（真实后端子进程 + WS 协议 + 模拟模型）

脚本：`bun testing/integration-harness.ts`（**46/46 通过**）
方式：以子进程启动真实后端（独立数据目录），用与 webview **完全相同**的 WebSocket 协议驱动。

### 2.1 启动、身份与本地通信

| 验证项 | 结果 |
| --- | --- |
| `/health` 返回 ok | 通过 |
| `/health` 的实例 ID 与握手文件一致（版本 + 实例身份校验） | 通过 |
| 端口为动态分配（非 3126 / 4096） | 通过 |
| 未携带一次性令牌的 WebSocket 被拒绝 | 通过 |
| 携带令牌后可完成命令往返 | 通过 |
| 应用上报固定的引擎版本 1.18.31 | 通过 |
| 凭证由操作系统保护（DPAPI 可用） | 通过 |
| 引擎运行在回环动态端口，且运行副本哈希与 PIN 一致 | 通过 |
| 诊断信息可读取（实例、二进制路径、哈希与日志尾部） | 通过 |
| 应用退出后握手文件变为陈旧（端口已死，身份探测会拒绝） | 通过 |
| 引擎子进程随后端一起退出（无残留守护进程） | 通过 |

### 2.2 设置与凭证

| 验证项 | 结果 |
| --- | --- |
| 保存设置并规范化 Base URL（去掉多余尾部斜杠，保留路径前缀） | 通过 |
| 保存响应只返回掩码，不返回 Key | 通过 |
| 重新读取设置只返回「是否已配置」+ 掩码 | 通过 |
| 「测试连接」向端点发出真实最小请求（无工具调用） | 通过 |
| 端点不可达时归类为**网络失败**（而非泛化错误） | 通过 |
| `app-settings.json` 中不含 Key | 通过 |
| `credentials.bin` 中不含 Key 明文（DPAPI 密文） | 通过 |
| 数据目录**全量扫描**：无任何文件包含测试 Key | 通过 |
| 设置与 Key 在应用重启后仍有效 | 通过 |

### 2.3 执行、画布与授权

| 验证项 | 结果 |
| --- | --- |
| write 工具请求授权并能被「允许本次」 | 通过 |
| 批准后文件真的被创建 | 通过 |
| 画布收到 tool-start / tool-end chunk，节点 ID 为引擎的稳定 callID | 通过 |
| 文本以增量方式流式送达 | 通过 |
| 用量（usage）上报 | 通过 |
| bash 请求授权并被「拒绝」 | 通过 |
| 拒绝后节点以失败结束，并携带引擎给出的原因 | 通过 |
| 同一会话内再次 `edit` 仍会请求授权（可允许） | 通过 |
| 非零退出码（`exit 7`）被判为失败并带上退出码 | 通过 |
| 历史中工具输出被压缩成一行摘要，正文不淹没对话 | 通过 |
| 已保存的工具节点可回读用于查看 | 通过 |

### 2.4 会话、并发与取消

| 验证项 | 结果 |
| --- | --- |
| 创建会话（显式传递工作区） | 通过 |
| 运行中的会话禁止删除 | 通过 |
| 应用内第二个并发任务被拒绝 | 通过 |
| 停止任务：调用引擎取消接口并收到确认 | 通过 |
| 停止后会话回到 idle | 通过 |
| 空闲会话可正常删除并从列表消失 | 通过 |
| 应用完全重启后会话、transcript、设置与 Key 仍在 | 通过 |
| 有凭证时启动会自动把引擎拉起 | 通过 |

### 2.5 配置热更新语义

| 验证项 | 结果 |
| --- | --- |
| 运行期间保存配置**不打断**当前任务（引擎实例保持不变） | 通过 |
| 配置变更在**下一轮**通过重启引擎生效 | 通过 |

---

## 3. 桌面外壳生命周期（阶段 4 重点项）

脚本：`bun testing/verify-shell-lifecycle.ts`（**12/12 通过**）
报告：`testing/shell-lifecycle-report.json`
方式：运行**构建产物** `harness-shell.exe`（headless，独立数据目录），随后**强制结束**外壳
（模拟任务管理器结束进程，不触发任何优雅退出逻辑），再检查残留进程。

| # | 验证项 | 结果 |
| --- | --- | --- |
| 1 | 记录已存在的 Harness 进程（旧版本残留不参与判定） | 通过 |
| 2 | 在隔离数据目录中写入 DPAPI 保护的凭证（触发引擎启动） | 通过 |
| 3 | 外壳发布后端端点（`runtime.json`） | 通过 |
| 4 | `/health` 的实例 ID 与握手一致 | 通过 |
| 5 | **外壳在开窗前已校验版本 + 实例身份**（日志 `handshake verified`） | 通过 |
| 6 | 后端被放入 **kill-on-close Job Object** | 通过 |
| 7 | 外壳把随包分发的引擎路径显式传给后端 | 通过 |
| 8 | 后端启动了属于自己的引擎子进程 | 通过 |
| 9 | 运行中的引擎使用 **Harness 自有进程名**（`harness-engine.exe`，绝不涉及用户自装的 `opencode.exe`） | 通过 |
| 10 | **强制结束后壳后无任何 Harness 子进程残留** | 通过 |
| 11 | 程序目录中的 `opencode/opencode.exe` 未被运行中的应用锁定 | 通过 |
| 12 | 后端日志记录了引擎状态 | 通过 |

> 附带发现：测试开始时机器上存在 **2026-09-17 启动的旧版本（0.1.x）残留进程**
> （`harness-shell.exe` + `harness-backend.exe`，来自旧行为「关闭窗口只是隐藏」）。
> 新版本的关闭即退出、Job Object 回收，以及安装器 hook 的按名清理，正是为消除这类残留而做。

---

## 4. 真实模型验收 —— **未执行**

计划要求 OpenAI-compatible 与 Anthropic-compatible **各完成一次**真实模型验收
（打开临时项目 → 读文件 → 请求修改授权 → 修改文件 → 请求执行授权 → 执行测试并判断退出码 →
最终回复 → 展示差异 → 重启应用恢复历史），另测错误 Key、拒绝授权、模型不存在、命令失败、用户停止、网络中断。

**本机没有任何可用的模型凭证，因此该项未执行。**

已用本地模拟服务覆盖：流式响应、工具调用、授权允许/拒绝、非零退出码判定、取消、错误分类、
历史重建、差异、重启恢复、并发与删除规则。
**无法**用模拟服务覆盖：真实服务端鉴权与限流行为、真实模型的工具调用质量、
真实端点对 Chat Completions 与 Messages 两种协议的兼容差异、真实错误体（401/404/400/429）的具体文本。

复现命令（填好凭证后）：设置页填写协议 / Base URL / 模型 / API Key → 测试连接 → 按上述 9 步走一遍临时项目。

---

## 5. 未执行或未完全验证的项

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 真实模型验收（两类协议） | **未执行** | 无凭证（第 4 节） |
| 安装包在干净机器上安装 / 覆盖升级 / 中文路径安装 / 无开发环境启动 / WebView2 引导 | **未执行** | 第 6、8 节 |
| 人为占用端口 | **未构造** | 设计上由「预留端口 + 实例身份校验」覆盖；未实测 |
| 引擎在空闲态崩溃后的有限重启 | **未构造** | 已实现（最多 3 次、忙碌时不重启）；实测到的是「后端崩溃 → 外壳有限重启」与「陈旧握手不可信」 |
| 主题在「运行中 / 授权中 / 查看差异时」切换 | **未手工验证** | 逻辑上主题只改 CSS 变量，不触及订阅与节点 |
| 减少动态效果（`prefers-reduced-motion`） | **未手工验证** | 媒体查询已覆盖两份样式表 |
| 画布按真实窗口宽度淘汰 + 关闭被淘汰节点详情 | **逻辑实现，未按真实宽度验收** | `pruneExecutionMessages(…, capacity, protectedIds)` 不淘汰执行中 / 等待授权节点；节点消失时清空详情 |
| SSE 在**回合进行中**断线后的补齐 | **未构造该场景** | 已实现 `resync()`；实测覆盖了「空闲后重订阅仍收事件」 |
| 旧数据迁移（明文 Key → DPAPI、旧会话只读归档） | **未用真实旧数据验证** | 实现见 `backend/src/legacy.ts`；自动化测试使用独立数据目录，只覆盖「无旧数据」分支 |
| 日志脱敏覆盖度 | **抽样验证** | 已校验数据目录内不含测试 Key；未穷尽所有日志路径 |
| 单实例「重复启动聚焦已有窗口」 | **未验证** | 已接入 `tauri-plugin-single-instance`，需要交互式桌面验证 |
| 提取出的后端「版本 + 哈希」校验（计划要求） | **未完成** | 现为「版本 + 字节数」；原因与修复方案见第 7 节第 9 条 |

---

## 6. 构建与安装包

构建命令：`bun run build`（`scripts/build.mjs`）

| 构建要求 | 状态 |
| --- | --- |
| 去除个人机器绝对路径 | 通过（脚本内无机器相关硬编码；非 ASCII 的 Bun 路径由脚本自动绕开） |
| 去除 Windows 不兼容的 `env -u NODE_OPTIONS` | 通过（改用 Node/Bun API 清理目录） |
| 跨平台化：不依赖特定 shell | 通过（全部调用经 `Bun.spawnSync(argv)`，不经过 cmd/sh；Tauri CLI 由 `node + @tauri-apps/cli/tauri.js` 解析，可用 `HARNESS_TAURI_CLI` / `HARNESS_NODE` 覆盖） |
| 固定版本与哈希校验后再打包 | 通过（构建前校验引擎 SHA-256，不符即中止） |
| 引擎二进制更新按版本 + 哈希 | 通过（大小与 SHA-256 双重校验，不符则拒绝启动；结果按版本/大小/mtime 缓存） |
| 释放出的后端二进制按版本 + 哈希 | **部分**：现为「版本 + 字节数」，计划要求的哈希未落地，见第 7 节第 9 条 |
| 不覆盖正在运行的二进制 | 通过（引擎副本与后端释放均先写临时名再重命名，占用时给出明确错误而不是继续） |
| 安装包包含后端与引擎，不依赖用户预装 | 通过（后端内嵌进外壳；引擎作为资源随包分发） |
| 声明并处理 WebView2 依赖 | 通过（`webviewInstallMode: downloadBootstrapper, silent`） |
| 生产启动不临时下载依赖 | 通过（后端与引擎均在包内；仅 WebView2 缺失时联网获取运行时） |
| 安装包附带第三方许可证与固定版本记录 | 通过（`THIRD-PARTY-NOTICES.md`、`opencode/LICENSE`、`opencode/PIN.json`） |
| 覆盖升级前先退出本应用及其子进程 | 通过（NSIS `NSIS_HOOK_PREINSTALL` 按**精确进程名**结束 `harness-shell.exe` / `harness-backend.exe` / `harness-engine.exe`，先杀外壳以阻止其重启后端） |
| 文件被占用时中止并明确提示 | 通过（hook 对 `harness-shell.exe` 与 `opencode\opencode.exe` 做**独占打开**校验，仍被占用即 `Abort` 并弹窗；日志写 `%TEMP%\harness-install-hook.log`） |
| 不按全局进程名批量杀进程 | 通过（只匹配 Harness 自有进程名，**不包含** `opencode.exe`，以免影响用户自装的 OpenCode） |

构建产物（`delivery/`）：

| 文件 | 说明 |
| --- | --- |
| `Harness_0.2.0_x64-setup.exe` | NSIS 安装包（含后端 + 引擎 + 文档） |
| `Harness-0.2.0-source.tar.gz` | **权威源码快照**（107 项，含 `vendor/opencode/PIN.json`） |
| `HARNESS.md` / `UPSTREAM.md` / `VALIDATION.md` / `THIRD-PARTY-NOTICES.md` | 交付文档 |
| `SHA256SUMS.txt` + `DELIVERY-NOTES.txt` | 摘要清单与交付说明（含每个文件的 SHA-256） |

⚠️ **两点需要人工处理**（均由本机文件被独占锁定导致，不是源码问题）：

1. `delivery/Harness-0.2.0-source.zip` 是**早期一次运行的陈旧快照**（缺少 `vendor/opencode/PIN.json`）。
   它在构建机上既删不掉也改不了（文件被以无共享写方式占用），**发布前请手动删除**，以 `Harness-0.2.0-source.tar.gz` 为准。
2. `delivery/SHA256SUMS.txt` 是在锁定发生前生成的，因此它列出的是那个陈旧的 `.zip`。
    `DELIVERY-NOTES.txt` 里给出了**当前全部文件的正确摘要**，请以它为准；重新跑一次
   `bun scripts/build.mjs --delivery-only` 即可自动纠正清单（届时清单会取最新快照）。

本次交付的安装包：

- SHA-256：`9e3789a551bf2a6b7ad5f76371f15d7a5c0ed4aec93b09984931de40f0f4be46`（71,223,906 字节）
- 由当次完整构建产出，其中的外壳可执行文件
  `harness-shell.exe` = 117,577,216 字节 / SHA-256 `e7d1feca798286d2a3cefd89…`，
  **正是第 3 节外壳生命周期验证所测的同一个二进制**。
- 该次构建之后仅修改过构建脚本与文档（应用源码未变），因此安装包与源码快照一致。

### 构建期的环境限制（如实记录）

在同一会话中对安装包做**再次**完整构建时，遇到宿主机层面无法绕过的文件权限限制：

```
error: failed to open: ...\shell\src-tauri\target\release\.cargo-build-lock   拒绝访问 (os error 5)
error: failed to remove ...\release\deps\*.rcgu.o                            拒绝访问 (os error 5)
```

- 这三个 0 字节的 cargo 锁文件（2026-09-17 由完整权限进程创建）被 ACL 设为
  `CodexSandboxUsers:(I)(RX)`，当前构建身份既不能写、也不能删、也不能重命名；
  连带把 `target` 目录整体重命名同样被拒。
- 换到全新目录（`HARNESS_CARGO_TARGET_DIR`）后，受限身份**创建**得了文件但**删除**不了自己刚生成的临时目标文件，
  cargo 因此失败；由此确认这是构建身份的权限问题，而不是源码或构建脚本的问题。
- 影响范围：只影响本次会话的重复打包，**不影响交付产物**（交付产物来自当次成功构建），
  也不影响用户在本机自行构建（用户身份对该目录有完全控制权）。

复现用户侧构建（预期正常）：

```bash
cd harness
bun install && bun scripts/fetch-opencode.mjs
bun run build          # 或 HARNESS_CARGO_TARGET_DIR=<可写目录> bun scripts/build.mjs
```

安装包内文件清单（由生成的 `installer.nsi` 核对）：
`harness-shell.exe`、`opencode/{opencode.exe, PIN.json, LICENSE}`、`HARNESS.md`、`THIRD-PARTY-NOTICES.md`。

---

## 7. 已知限制（含复现步骤）

1. **引擎的权限询问并非每次命令都会触发。**
   实测矩阵（`bun testing/probe-permissions.ts`）：
   - `write` 工具 → 询问（permission=edit）
   - `bash echo ...` → 询问（permission=bash）
   - 同一会话内第二条 `bash exit 7` → **未询问**，直接执行
   - 同一会话内第二次 `edit` → 询问
   - 两次不同的 `echo` 命令 → 两次都询问

   即是否询问由引擎自身的权限判定决定；Harness **不做二次拦截**（避免形成两套授权系统，
   也避免伪造工具结果）。界面始终按引擎的原生权限机制展示与回复。
   **影响**：若要求「每条命令都必须确认」，当前版本不满足。

2. **差异依赖 git。** 工作区不是 git 仓库时引擎可能返回空差异，界面显示「无文本差异可展示」。
   复现：在非 git 目录创建会话 → 修改文件 → 打开差异面板。

3. **`session.diff` 必须带 `messageID`**，否则引擎返回 `[]`；Harness 已按回合遍历补齐。

4. **非零退出码不体现在工具状态里**（引擎报 `completed` + `metadata.exit=7`），
   Harness 据退出码判定失败；若引擎将来改为在 `state.status` 体现，判定依然成立。

5. **配置变更需要重启引擎**（引擎在 spawn 时固定 Provider 模型表），因此被**推迟到当前回合结束**：
   运行中改配置 → 不打断 → 下一轮生效。代价是本回合内不会立刻生效。

6. **引擎会读取用户目录下的外部技能**。Harness 已设置
   `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`、`OPENCODE_DISABLE_EXTERNAL_SKILLS=1`、`OPENCODE_DISABLE_SHARE=1`
   （三个变量名已确认存在于固定版本二进制内）。宿主环境若有损坏的技能文件，仍可能出现非致命
   `session.error`；Harness 将其识别为「与本轮无关」并只记入诊断。

7. **安装包体积较大**（后端可执行文件 + 180 MB 引擎），安装与首次启动的解压需要一点时间。

8. **旧版本残留进程**：0.1.x 的「关闭窗口只是隐藏」会留下常驻进程；0.2.0 关闭即退出，
   安装器的 PREINSTALL hook 也会在升级前按名清理。若手动升级遇到「文件被占用」，安装器会明确中止。

9. **外壳判定「释放出的后端是否需要更新」用的是 `版本 + 字节数`，尚未升级为哈希。**
   计划要求「使用版本及哈希确认二进制；删除按文件大小判断的逻辑」。
   现状：`shell/src-tauri/src/main.rs` 的 `materialize_backend()` 写入
   `harness-backend.stamp.json = {version, size}`，三者中任一不符即重新释放；嵌入的字节与随包内容在构建期同源，
   所以「版本 + 大小」足以覆盖换版本与写入损坏两种情形，但**不覆盖被替换成同尺寸文件**的情形。
   计划中的哈希校验因本次会话无法重新编译外壳（见第 6 节的环境限制）未能落地。
   后续修复：在 `main.rs` 内实现 FNV-1a 64 位（无需新增 crate）对 `BACKEND_BYTES` 与磁盘文件各算一次并写入 stamp，
   或在 `build.rs` 里用 `sha2` 生成编译期常量。**该项未完成，需在能正常构建的环境补齐。**

10. **后端只在存在凭证时才启动引擎**（无 Key 时静默不启动，界面显示「引擎未就绪」）。
    这是有意行为，但自动化验证需要预置一份 DPAPI 凭证才能覆盖引擎路径（`testing/verify-shell-lifecycle.ts` 已如此处理）。

---

## 8. 安装验收记录

> 状态：**未执行**。

理由与前置条件：需要以管理员身份在**非沙箱**环境运行安装包并实际安装到系统目录，
这会修改本机状态（注册表、程序文件、可能安装 WebView2），因此本报告不擅自执行，也不标注为通过。

待补清单（安装后逐项勾选，全部完成后本节才可写「通过」）：

- [ ] 首次安装（管理员）成功，开始菜单/卸载项正确
- [ ] 未预装 Bun / Node / OpenCode 时可正常启动
- [ ] 未预装 WebView2 时引导安装成功
- [ ] 中文用户名 + 中文路径 + 含空格路径下安装与运行正常
- [ ] 应用**运行期间**再次运行安装包：安装器能结束应用并可继续安装
- [ ] 人为占用关键文件时：安装器**中止并提示**，不忽略继续
- [ ] 关闭应用后无 `harness-shell.exe` / `harness-backend.exe` / `harness-engine.exe` 残留
- [ ] 保存配置后立即使用成功；重启后仍有效
- [ ] 日志与历史文件中不含测试 Key
- [ ] 覆盖升级后核对实际运行版本（关于页/诊断面板显示的引擎版本）
