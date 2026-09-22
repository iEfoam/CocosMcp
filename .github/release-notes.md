## 安装 / Installation

**推荐：[让 AI 自动下载安装](https://github.com/iEfoam/CocosMcp/blob/main/README.zh-CN.md#让-ai-自动下载安装推荐)** — 直接复制提示词，AI 自动识别工程、从 GitHub 下载、安装、配置并验证连接，无需先手动准备 ZIP 或路径。

**Recommended: [AI-assisted automatic installation](https://github.com/iEfoam/CocosMcp/blob/main/README.md#let-ai-download-and-install-automatically-recommended)** — copy the prompt; let AI discover the project, download from GitHub, install, configure and verify the connection.

以下为手动安装方式 / Manual installation follows.

| Creator | 下载 ZIP / Download | 工程内目录 / Project directory |
| --- | --- | --- |
| 2.x | `cocos-mcp-creator2.zip` | `packages/cocos-mcp-creator2/` |
| 3.x | `cocos-mcp-creator3.zip` | `extensions/cocos-mcp-creator3/` |

1. 准备 Cocos Creator 与 **Node.js 24+**，用同版本 `SHA256SUMS` 核对 ZIP。升级前停止 MCP 服务、关闭 Creator 并备份旧扩展。
2. 将 ZIP 内容解压到对应目录，确保 `package.json` 直接位于该目录内。
3. 在扩展根目录新建 `service-config.json`，设置 `nodeExecutable` 为本机 Node.js 24+ 的绝对路径。**发布 ZIP 不包含这份本机配置。**
4. 打开工程，通过 **CocosMCP → 打开控制中心 → 启动 MCP 服务** 启动服务，再用面板地址及本机 Bearer token 配置 AI 客户端的 Streamable HTTP MCP。

**[完整离线安装步骤](https://github.com/iEfoam/CocosMcp/blob/main/README.zh-CN.md#下载与离线安装) · [复制给 AI 的安装提示词](https://github.com/iEfoam/CocosMcp/blob/main/README.zh-CN.md#让-ai-自动下载安装推荐)**

For offline installation, have Creator and **Node.js 24+** available, verify the ZIP with `SHA256SUMS`, and extract it into the matching project directory above. Back up an existing extension before replacement. Create `service-config.json` beside `package.json`, setting `nodeExecutable` to your local Node executable's absolute path. Load the extension and start MCP from the control center, then configure your AI client's Streamable HTTP connection using the displayed endpoint and local Bearer token.

**[English installation guide](https://github.com/iEfoam/CocosMcp/blob/main/README.md#download-and-offline-installation) · [AI installation prompt](https://github.com/iEfoam/CocosMcp/blob/main/README.md#let-ai-download-and-install-automatically-recommended)**

`*.full.json` and the other Creator JSON bundles are for the plugin updater, not manual editor installation. GitHub's **Source code** archives need compilation. ZIP and update bundles share the same source fingerprint. **Pre-release** builds are development versions and are not installed automatically by the stable updater.
