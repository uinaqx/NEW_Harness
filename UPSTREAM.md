# 上游来源与固定版本

本文件记录 Harness 所依赖的上游项目、精确版本、下载来源、校验值与许可证。
**不存在任何使用浮动 `latest` 的依赖。**

20 个内置 Agent Skills 的固定提交、每个 `SKILL.md` 的 SHA-256 和许可证见 `vendor/skills/MANIFEST.json`；原始许可证随技能目录分发，并汇总于 `THIRD-PARTY-NOTICES.md`。

## 1. OpenCode（执行引擎）

| 项目 | 值 |
| --- | --- |
| 上游项目 | OpenCode |
| 许可证 | MIT（Copyright (c) 2025 opencode） |
| 固定版本 | **1.18.31** |
| 版本通道 | npm |
| 服务端包 | `opencode-windows-x64@1.18.31` |
| 服务端来源 | https://registry.npmjs.org/opencode-windows-x64/-/opencode-windows-x64-1.18.31.tgz |
| tarball SHA-256 | `8a300ee2b3210ccc6894ff27d21bdb0a60ee44107389c49b743b4caed10aa5cf` |
| tarball 大小 | 60,152,538 字节 |
| 二进制路径 | `package/bin/opencode.exe` |
| 二进制大小 | 179,998,248 字节 |
| 二进制 SHA-256 | `0242a0dc705af67c90882b456a36b619883c1c786aad8fe071a1bc64e5d1d440` |
| CLI 包装包 | `opencode-ai@1.18.31`（来源 tarball SHA-256 `b6baa53003cd2e096981474ba9461a33aba2e6948b2b4b08c4aa1a88e6dc1b59`） |
| SDK 包 | `@opencode-ai/sdk@1.18.31`（来源 tarball SHA-256 `0b5cd54941e51cd00c6261c4674a4d9f51a82710ec3ad48be85a9e316bb95000`） |

以上数值由 `vendor/opencode/PIN.json` 保存，并被以下环节强制校验：

- `scripts/fetch-opencode.mjs`：下载后先校验 tarball SHA-256，再校验解出的二进制 SHA-256，不一致立即失败且不覆盖已有的可用副本。
- `backend/src/engine/binary.ts`：启动前后端会对照 PIN 校验二进制大小与 SHA-256；不匹配则拒绝启动引擎并在界面给出明确错误。校验结果按（版本、大小、mtime）缓存，避免每次启动重新哈希 180 MB。
- `scripts/build.mjs`：打包前再次校验，不通过则中止构建。

> 说明：OpenCode 未在二进制内提供版本化的源码提交号（npm 包不含 `gitHead`），
> 因此溯源以“npm 包名 + 精确版本 + tarball/二进制 SHA-256”为准，而不是单一提交哈希。

## 2. 运行环境（不随安装包分发，仅构建时使用）

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| Bun | 1.3.13（开发机实测 1.3.9 亦可） | 包管理、任务运行、后端编译 |
| Node.js | ≥ 22 | 部分脚本与工具链 |
| Rust | ≥ 1.85（实测 1.98.1） | Tauri 外壳编译 |
| Tauri CLI | 2.x（实测 2.11.4 / 2.11.5） | 打包 NSIS 安装包 |

## 3. 前端运行时依赖

| 包 | 版本约束 | 许可证 |
| --- | --- | --- |
| `react` | ^19.0.0 | MIT |
| `react-dom` | ^19.0.0 | MIT |
| `lucide-react` | 1.47.0 | ISC |

锁文件：`harness/bun.lock`。**不提供 npm/yarn/pnpm 锁文件。**

## 4. 与原 Cline fork 的关系

Harness 与仓库根目录的 Cline fork（`apps/examples/desktop-app`、`sdk/`）**相互独立**：

- Harness 不 import 任何 `@cline/*` 包，也不复用其 SDK。
- 唯一继承的视觉资产是「执行画布」的交互与样式思路，代码已在 `harness/webview` 内重写。
- 旧版桌面应用及其 SDK 不属于本次交付范围，也不再修改。

Cline 上游快照的固定提交为 `b675eb6189e81c563d3d21202326057a0fb79279`（导入时间 2026-09-16），
其许可证为 Apache-2.0，见仓库根目录 `LICENSE`。
