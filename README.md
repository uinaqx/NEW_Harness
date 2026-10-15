<p align="center">
  <img src="./shell/src-tauri/icons/128x128.png" width="72" height="72" alt="某科学的Agent Logo" />
</p>

<h1 align="center">某科学的Agent</h1>

<p align="center"><strong>用实时画布看清 AI 的行动，让角色主题融入每一次对话。</strong></p>

<p align="center">
  <a href="https://github.com/uinaqx/NEW_Harness/releases/tag/v1.0.4">下载 Windows 版</a> ·
  <a href="#实时执行画布">执行画布</a> ·
  <a href="#角色主题">角色主题</a> ·
  <a href="./HARNESS.md">使用说明</a>
</p>

某科学的Agent是一款面向本地个人使用的 Windows 桌面 AI 助手，基于 OpenCode 引擎运行，支持自填 API 和模型。**实时执行画布**与**角色主题**是它的两项核心特色：前者展示任务如何一步步完成，后者让界面外观和 AI 的对话语气拥有一致的角色风格。

当前发行版本为 **[1.0.4](https://github.com/uinaqx/NEW_Harness/releases/tag/v1.0.4)**，提供 Windows x64 安装包。

## 实时执行画布

读取文件、修改代码、执行命令、等待授权——每一步都在画布中占据一行，附上简洁的中文说明。你可以看到 AI 正在处理什么对象、采取什么动作，以及这一步的执行状态。

执行过程示意：

```text
01  thinking   定位页面脚本入口             已结束
 ├─ 02  read   读取入口和事件处理   读取 147 行
 ├─ 03  edit   修复键盘控制逻辑       +49 −0
 └─ 04  bash   运行交互回归测试       执行中
```

- **步骤来自真实执行事件。** 展示工具名称、中文意图、状态和耗时；读取与编辑步骤附实际行数或增删统计。
- **按需查看细节。** 点击步骤查看参数、输出和结果。模型返回的思考内容默认隐藏，可在思考步骤详情中手动展开。
- **随进展自动更新。** 主轨迹最多展示六步，较早的已结束步骤进入顶部紧凑区，并按空间压缩成图标；执行中或等待授权的步骤保留在主轨迹。
- **聊天保持正常排列。** 画布紧接最新消息展开，消息始终从顶部向下排列。默认跟随最新进展，也可以自由滚动回看；切换对话后，正在执行的画布状态仍会保留。
- **结果与画布同步交接。** 任务结束时，最终回复与文件改动合集一同显示，画布同时开始收起。

对话区用于展示反馈与结果，工具执行和思考步骤集中在画布中。

## 角色主题

主题同时改变**配色、图案、AI 头像和系统提示中的角色人设**。选择主题后，AI 会按对应角色的语气交流；深色与浅色模式可以独立切换。

| 主题 | 视觉风格 | 对话风格 |
| --- | --- | --- |
| <img src="./shell/src-tauri/icons/32x32.png" width="32" height="32" alt="经典主题" /> **经典** | 黑白与中性色，保持简洁 | 通用助手风格，支持自定义头像 |
| <img src="./webview/src/assets/theme/fairy-avatar.png" width="32" height="32" alt="Fairy 头像" /> **Fairy · 绝区零** | 深蓝灰与冰蓝线条，搭配 Fairy 头像和界面标记 | 冷静、简洁，称用户为“主人” |
| <img src="./webview/src/assets/theme/klee-character-icon.png" width="32" height="32" alt="可莉头像" /> **可莉 · 原神** | 石墨灰或暖白底色，点缀柔和珊瑚色与嘟嘟可图案 | 活泼、亲切，称用户为“荣誉骑士”或“旅行者” |

深色模式保留黑灰或深蓝底色，用主题色点缀组件、线条和图标；浅色模式采用柔和配色。任务执行期间也可以切换主题，保留当前对话与任务状态。

在 **设置 → 外观** 中选择主题、字体和字号，在 **设置 → 个人** 中选择用户及通用助手的头像，支持预设图标、图片上传和范围裁剪。角色主题使用各自的 AI 头像。

角色素材的来源及权利记录见 [主题素材说明](./webview/src/assets/theme/SOURCES.md)，第三方组件信息见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

## 交付结果，可以直接查看

任务完成后，回复下方会汇总本轮修改的文件、增删行数、任务耗时和 Token 用量。

- 点击文件名查看内容，通过差异面板检查具体改动。
- 在文件预览中，一键打开文件或所在文件夹；HTML / SVG 支持在应用内预览成品。
- 非 Git 项目的成功创建、编辑与补丁操作，也可从工具记录恢复本轮文件合集；缺少可验证的原文或补丁时，明确标注行数未提供。
- 最终回复默认简洁说明结果与验证情况，完整源码可按需索取。

## 其他能力

| 能力 | 用途 |
| --- | --- |
| 多 API 与模型配置 | 支持 OpenAI-compatible Chat Completions、Anthropic Messages；每份配置填写一个模型，在输入框右下角切换 |
| 20 个内置技能 | 包含前端设计、头脑风暴、调试、网页测试等，可在输入框 `+` 菜单中选择 |
| 项目与对话管理 | 同一目录下建立多个对话，支持对话重命名、置顶、删除及项目图标选择 |
| 文件附件 | 拖入文件供模型分析，发送前可移除；支持 DOCX、文本、代码和常见图片格式 |
| 操作授权 | 输入框左下角选择批准规则，支持查看授权请求、允许、拒绝和停止任务 |
| 个人使用概览 | 每日、每周和累计 Token 活动图，以及技能、模型、任务耗时和用量明细表 |
| 本地凭证保护 | API Key 使用 Windows DPAPI 加密保存；无需 Codex 或 Cline 账户 |

统计来自当前保留的本机会话，Token 用量以模型服务返回的数据为准。各技能的来源、固定版本与许可证记录在 [技能清单](./vendor/skills/MANIFEST.json) 中。

## 开始使用

1. 下载并运行 [Windows x64 安装包](https://github.com/uinaqx/NEW_Harness/releases/download/v1.0.4/New-Harness_1.0.4_x64-setup.exe)。安装包内置 OpenCode 引擎，无需另外安装 OpenCode、Bun 或 Node。
2. 打开 **设置 → 配置**，填写协议、Base URL、模型 ID 和 API Key，分别执行“保存配置”和“测试连接”。可以添加多份配置。
3. 在 **设置 → 外观** 中选择角色主题及深浅模式。
4. 在输入框选择模型并发送消息。处理项目任务时使用 Work，选择项目目录；只需对话时使用 Chat，无需工作区，上传附件作为只读内容供模型分析。

新版可以覆盖安装，会话与配置保存在 `%LOCALAPPDATA%\Harness\data`。完整配置、授权规则、数据位置与排障方法见 [使用说明](./HARNESS.md)。

## 本地构建

开发环境需要 Bun、Node.js，以及 Rust / Tauri 的 Windows 构建依赖，详细步骤见 [HARNESS.md](./HARNESS.md)。在本仓库根目录执行：

```powershell
bun install
bun run fetch:engine       # 拉取并校验固定版本的 OpenCode 引擎
bun run build              # 构建前端、后端、桌面外壳和 Windows 安装包
```

常用验证命令：

```powershell
bun run typecheck
bun test backend/src webview/src
bun run verify             # 引擎基础与模拟模型集成验证
```

前端位于 `webview/`，引擎适配及本地服务位于 `backend/`，桌面外壳位于 `shell/`；共享类型、构建脚本和验证工具分别位于 `shared/`、`scripts/` 与 `testing/`。

## 文档与来源

- [使用说明](./HARNESS.md)：安装、模型配置、功能操作与排障。
- [上游来源](./UPSTREAM.md)：OpenCode 固定版本与校验记录。
- [第三方组件与许可证](./THIRD-PARTY-NOTICES.md)：组件和内置技能的来源说明。
- [主题素材说明](./webview/src/assets/theme/SOURCES.md)：角色图片的来源及权利记录。
- [验证报告](./VALIDATION.md)：已完成的检查、验证范围与已知限制。
- [版本发布](https://github.com/uinaqx/NEW_Harness/releases)：安装包、源码快照及 SHA-256 校验文件。
