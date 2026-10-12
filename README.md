# 某科学的Agent（OpenCode 引擎版）

本地个人使用的 Windows 桌面编码助手。**任务由 OpenCode 引擎执行**，Harness 负责桌面生命周期、
配置与凭证保护、中文界面、执行画布、授权展示与文件差异。

**1.0 大版本现已发布，发行版本为 [v1.0.4](https://github.com/uinaqx/NEW_Harness/releases/tag/v1.0.4)。** 本次整合已完成本地验收的角色主题、使用统计与执行体验改进。

- **角色主题：**「经典 / Fairy / 可莉」均可独立切换深浅模式，配色、头像、装饰与对话人设同步变化。Fairy 称用户为“主人”，可莉称用户为“荣誉骑士”或“旅行者”。主题切换保留任务与对话状态；素材来源与权利记录见 [`SOURCES.md`](./webview/src/assets/theme/SOURCES.md)。
- **个人使用概览：** 最近一年 Token 活动支持每天、每周和累计视图，并提供实际技能使用、模型用量、Work / Chat 轮次及任务耗时表格。统计来自本机保留的会话。
- **执行画布：** 工具与思考集中展示，每步附中文意图；思考详情默认隐藏。消息从顶部向下排列，画布紧接最新内容，用户可自由回看历史；较早流程按空间压缩为图标。
- **任务交付：** 最终回复、文件改动合集与画布收起同步发生。点击文件名可查看内容、差异和预览；非 Git 项目也可从成功工具记录恢复本轮改动。无法验证行数时明确标注，默认不粘贴整份源码。
- **对话与附件：** 修复持续对话完成后缺失回复、迟到片段重复追加、附件文字混入用户消息等问题。Markdown 正常渲染，附件仍供模型只读分析，Work 和 Chat 的思考展示各自保持默认隐藏或折叠。
- **应用图标：** 默认 Logo 简化为单条轨道和圆形核心，桌面与应用界面保持一致。

## 历史版本

0.9.0 将模型提问改为与主题一致的独立弹窗；Work 思考只在执行画布展示，Chat 思考默认折叠。Chat 首条用户消息成为标题，完成时自动刷新最终回复。项目和 Chat 会话位于同一侧栏滚动列表。上传的未发送附件可移除；DOCX 在本地提取文字后送给模型，避免不支持的媒体类型报错。文件预览的“打开所在文件夹”现在启动可见的资源管理器窗口，步骤意图提示进一步要求写明对象和动作。

0.8.1 为每个版本使用独立的 WebView 缓存，并在侧栏显示当前版本号，方便排查升级后显示旧界面的问题。会话与 API 配置继续保存在原数据目录。若旧版进程仍在运行，先退出它，再从桌面快捷方式启动新版。

0.8.0 在切换对话后保留正在执行的画布，返回时补上期间的步骤。Work 模式的模型在调用工具前给出 5–15 字中文意图，画布直接显示；提问选项纵向排列。项目右键菜单可改名和图标；用户消息及头像显示在右侧，两种头像都可在「个人」页选择预设或上传裁剪。Work 与 Chat 均可拖入文件作为附件；Chat 附件只读。

0.7.0 支持直接在画布回答模型提出的问题，执行中可自由滚动聊天；完整思考默认折叠在画布步骤详情中。较早流程在顶部随宽度压缩成图标，授权模式移到输入框左下角。设置改为「个人 / 配置 / 外观」双栏布局，支持本地 Token 统计及字体调整。项目可选图标；修改文件预览增加系统打开、打开所在文件夹，以及 HTML/SVG 沙箱预览。

0.6.0 将工具步骤与思考集中在底部画布，对话区只保留反馈与结果。主轨迹最多显示六个步骤，较早的已结束步骤按顺序保留在顶部横排；每步附中文说明，read 展示实际阅读行数，edit 展示绿色新增与橙色删除行数。任务结束后显示耗时、Token 用量和本轮文件修改卡片，点击文件名可在右侧直接打开文件内容。

0.4.0 增加无需项目的 Chat 纯对话模式，与按项目组织的 Work 模式并列；Chat 对话显示在侧栏底部，不开放本地文件和工具。可保存多份 API 配置，每份仅配置一个模型，在输入框右下角切换。应用名称与图标已更新，内置技能列表改用矢量图案。Work 模式沿用项目分组、同目录多对话、执行画布与 20 个内置 Agent Skills。对话支持右键重命名、置顶和删除，深浅主题可随时切换。

## 下载与使用

下载 [Windows x64 安装包](https://github.com/uinaqx/NEW_Harness/releases/download/v1.0.4/New-Harness_1.0.4_x64-setup.exe) 并运行，可直接覆盖旧版本，保留原有会话和设置；不需要另外安装 OpenCode、Bun 或 Node。源码快照、SHA-256 校验值和使用说明位于 [v1.0.4 Release](https://github.com/uinaqx/NEW_Harness/releases/tag/v1.0.4)。首次启动后，打开左下角「设置 → 配置」，添加具名 API 配置，选择 OpenAI-compatible Chat Completions 或 Anthropic Messages，填写 Base URL、模型 ID 和 API Key，并单独执行「测试连接」。每个配置仅填写一个模型 ID，其他模型可添加独立配置；Key 使用 Windows DPAPI 加密保存。

- **Work：** 在项目下添加对话，在输入框选择访问位置与模型后发送任务。可查看工具执行画布、授权请求与文件差异；修改文件和执行命令默认询问。
- **Chat：** 在项目列表下方的「聊天」栏目点击加号即可发送消息，不需要工作区；可拖入只读附件，不提供本地文件路径访问、命令或技能工具。
- 两种模式均可在输入框右下角切换已保存的 API 与模型。对话可重命名、置顶、删除；三款角色主题的深色和浅色模式可随时切换。

当前仅提供 Windows x64 安装包。1.0.4 已完成本机覆盖安装、启动及相关交互检查，详细验收范围和已知限制见 [`VALIDATION.md`](./VALIDATION.md)。

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
