# 第三方组件与许可证

Harness 安装包内分发下列第三方组件。每个组件均保留其原始许可证文本。

## OpenCode（执行引擎，随安装包分发）

- 版本：`1.18.31`
- 分发形式：`opencode/opencode.exe`（Pebble 单文件可执行程序，Bun 编译产物）
- 许可证：**MIT License**
- 版权：Copyright (c) 2025 opencode
- 许可证原文：安装目录下的 `opencode/LICENSE`，或 `harness/vendor/opencode/LICENSE`
- 来源与校验值：见 `UPSTREAM.md` 与安装目录下的 `opencode/PIN.json`

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## @opencode-ai/sdk（编译进 Harness 后端）

- 版本：`1.18.31`
- 分发形式：**以源码形式内联进 `harness-backend.exe`**（构建期打包，不作为独立文件分发）
- 许可证：MIT。源码路径 `harness/vendor/opencode/sdk/`

## 内置 Agent Skills（随安装包分发）

- 11 个技能来自 [anthropics/skills](https://github.com/anthropics/skills)，固定提交 `34040c9c568585f6929bedeaad110ad08f079624`，各目录内保留原始 `LICENSE.txt`（Apache-2.0）。
- 9 个技能来自 [obra/superpowers](https://github.com/obra/superpowers)，固定提交 `5bf4e78011075bcfc0dc295f0724994cd123ee71`，原始 MIT 许可证保存在 `skills/SUPERPOWERS-LICENSE`。
- 完整技能清单、来源和各 `SKILL.md` 的 SHA-256 见 `skills/MANIFEST.json`（源码对应 `harness/vendor/skills/`）。
- 技能为可按需加载的指令与辅助资源；部分技能所述脚本需要额外工具，Harness 不会自动安装或运行这些工具。

## React / React DOM（UI）

- 版本：`^19.0.0`
- 许可证：MIT。以打包后的产物形式包含在 `webview/dist`，并内联进 Harness 后端二进制。

## lucide-react（图标）

- 版本：`^1`
- 许可证：ISC。以打包后的产物形式包含。

## Tauri（桌面外壳）

- 版本：`2.x`（构建时实测 crate 2.x / CLI 2.11）
- 许可证：Apache-2.0 / MIT 双许可
- 分发形式：静态链接进 `harness-shell.exe`，其完整许可证随 Rust 依赖树以源码形式提供（`Cargo.lock` 记录精确版本）。

## Bun（后端运行时）

- 用途：构建期编译 `harness-backend.exe`；运行期不需要用户安装
- 许可证：MIT。后端产物由 Bun 编译为独立可执行文件，运行时不加载 Bun 运行时。

## WebView2（Windows 运行时依赖）

- 用途：Tauri 在 Windows 上使用系统 WebView2 渲染界面
- 分发方式：安装包内置 **Microsoft WebView2 引导程序**，目标机器缺失时自动安装
- 许可证：Microsoft 软件许可条款（由 Microsoft 提供，随引导程序分发）

## Cline（不含运行时依赖）

Harness 仓库包含一份 Cline 源码快照（Apache-2.0，见仓库根 `LICENSE`），
但 Harness 应用本身不链接、不加载 Cline 的任何代码，仅在视觉上参考了其「执行画布」交互。
