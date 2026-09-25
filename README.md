# 某科学的Agent（OpenCode 引擎版）

本地个人使用的 Windows 桌面编码助手。**任务由 OpenCode 引擎执行**，Harness 负责桌面生命周期、
配置与凭证保护、中文界面、执行画布、授权展示与文件差异。

0.4.0 增加无需项目的 Chat 纯对话模式，与按项目组织的 Work 模式并列；Chat 对话显示在侧栏底部，不开放本地文件和工具。可保存多份 API 配置，每份可有多个模型，在输入框右下角切换。应用名称与图标已更新，内置技能列表改用矢量图案。Work 模式沿用项目分组、同目录多对话、执行画布与 20 个内置 Agent Skills。对话支持右键重命名、置顶和删除，深浅主题可随时切换。

## 下载与使用

Windows 安装包位于 [Releases](https://github.com/uinaqx/NEW_Harness/releases)。下载 `某科学的Agent_0.4.0_x64-setup.exe` 并运行；不需要另外安装 OpenCode、Bun 或 Node。首次启动后，打开左下角「设置」，添加具名 API 配置，选择 OpenAI-compatible Chat Completions 或 Anthropic Messages，填写 Base URL、模型 ID 和 API Key，并单独执行「测试连接」。每个配置可填写多个模型 ID（每行一个）；Key 使用 Windows DPAPI 加密保存。

- **Work：** 点「Work 新对话」或在项目下添加对话，在输入框选择访问位置与模型后发送任务。可查看工具执行画布、授权请求与文件差异；修改文件和执行命令默认询问。
- **Chat：** 点「Chat 开聊」直接发送消息，不需要工作区；它不提供本地文件、命令或技能工具。Chat 对话排列在项目列表下方。
- 两种模式均可在输入框右下角切换已保存的 API 与模型。对话可重命名、置顶、删除；深色和浅色主题可随时切换。

当前仅提供 Windows x64 安装包。0.4.0 的自动化验收包括 OpenCode 基础链路 21/21、模拟模型集成 67/67、安装版生命周期 13/13，以及运行中覆盖安装。窗口内逐项视觉点击因本机自动化服务故障尚未完成；两类协议的真实模型闭环在 0.2.1 执行过，0.4.0 未重跑。详见 [`VALIDATION.md`](./VALIDATION.md)。

应用显示名称与安装目录为“某科学的Agent”。为保留既有设置与对话，数据仍在 `%LOCALAPPDATA%\Harness\data`；旧版 `Harness` 安装项可能并存，清理前请先备份该目录。

- 使用说明（安装 / 配置 / 数据位置 / 排障 / 构建）：[`HARNESS.md`](./HARNESS.md)
- 上游来源、固定版本与校验值：[`UPSTREAM.md`](./UPSTREAM.md)
- 第三方组件与许可证：[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)
- 验证报告（逐项通过 / 失败 / 未执行）：[`VALIDATION.md`](./VALIDATION.md)

## 目录结构

```
harness/
  shared/types.ts         前后端共享契约（含引擎与设置的应用层类型）
  backend/                Bun 后端（零运行时依赖，编译为单文件可执行）
    src/
      index.ts            入口：数据目录 → 迁移 → 设置/凭证 → HTTP+WS → 引擎
      config.ts           路径、常量、应用标识
      network-proxy.ts    读取 Windows 系统代理供模型连接与引擎子进程使用
      secrets.ts          DPAPI 凭证存储（bun:ffi → crypt32.dll）
      app-settings.ts     非敏感设置
      runtime.ts          启动握手（端口 + 一次性令牌 + 实例 ID）
      sessions.ts         Harness 会话索引（不复制消息库）
      legacy.ts           旧数据一次性迁移（只读归档 + 明文 Key 迁入 DPAPI）
      server.ts           仅回环 + 动态端口 + `/health` 身份校验 + 令牌校验
      transport.ts        WS 命令协议（保留旧命令名，新增引擎/设置/差异命令）
      engine/             唯一知道 OpenCode 存在的层
        binary.ts         定位 + 版本/哈希校验 + 运行副本 staging
        process.ts        子进程生命周期（动态端口、随机凭证、代际守卫、有限重启）
        client.ts         SDK 唯一调用点（超时、工作区、错误分类）
        normalize.ts      引擎事件 → 应用事件（以实测事件名为准）
        provider.ts       生成 OPENCODE_CONFIG_CONTENT（凭证不落盘）
        errors.ts         错误分类（Key/模型/协议/网络/超时）
        index.ts          适配层门面（计划里的 9 项应用层能力）
  webview/                React 界面（Bun 自带打包器，无 vite 依赖）
  shell/                  Tauri 外壳（Job Object、握手校验、端点注入、单实例）
    nsis/installer-hooks.nsh   安装器 hook（按名清理 + 独占打开校验）
  testing/                模拟端到端、安装器、生命周期与真实模型验收脚本
  scripts/                拉取固定引擎、构建、源码快照
  vendor/opencode/        固定版本的引擎与 SDK（git 忽略，由脚本拉取）
  vendor/skills/          固定提交来源的 20 个 Agent Skills（随安装包分发）
```

## 开发

```bash
bun install
bun scripts/fetch-opencode.mjs        # 拉取并校验固定版本引擎

# 后端（HARNESS_DEV=1 允许开发前端通过 dev-only 端点取令牌）
cd backend && HARNESS_DEV=1 bun run src/index.ts

# 前端
cd webview && bun run dev             # http://127.0.0.1:3125
```

## 构建与验证

```bash
bun run build              # 前端 + 后端 + 外壳 + NSIS 安装包 + delivery/
bun run build:backend-only # 跳过安装器
bun run package:source     # 源码快照
bun run verify             # 阶段1 + 端到端（模拟模型服务）
bun testing/verify-shell-lifecycle.ts   # 外壳生命周期（需先 build）
```

## 设计要点（与旧版的区别）

- 旧版手写 Agent 循环（`agent.ts` / `llm.ts` / `tools.ts` / `approvals.ts`）已删除，
  生产路径不再有第二套执行系统。
- 后端不再固定端口：动态端口 + 启动握手 + 一次性令牌，前端端点由外壳注入。
- **API Key 不落明文**：DPAPI 加密存储，经子进程环境变量传给引擎，不写配置文件。
- 引擎以 `harness-engine.exe` 的固定名从数据目录运行，安装目录不被锁定。
- 关闭窗口即退出；应用、后端与引擎整棵树由 Job Object 保证一起回收。
