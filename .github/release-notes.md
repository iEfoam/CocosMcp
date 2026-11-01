## v0.1.1 正式版 / Stable release

将已交付的可靠性、UI 与 Prefab 优化发布到稳定通道，统一工作区、Creator 2/3 扩展、统一客户端与 MCP 服务版本为 `0.1.1`。本次不新增编辑器功能。

This stable release promotes the delivered reliability, UI and Prefab improvements and aligns the workspace, Creator 2/3 extensions, unified client and MCP server at `0.1.1`. It adds no new editor capabilities.

包含此前 O01–O15 优化及其 UI 编排、样式和 Creator 登录复用依赖：

- 证据导出并发与容量守卫，写后未知结果账本，独立诊断/取消通道，原子恢复日志。
- 输出契约、网关配额、按范围资源扫描、请求阶段计时、日志与构建历史管理。
- Creator 3.8.8 UI 结构计划/执行、Prefab 资源编辑及实例挂载节点/组件覆盖；整组 Undo/Redo 和保存重开。
- Prefab 差异与 guarded apply/restore、缺失脚本保护、UUID/字面路径/动态未知审查。
- 开发/原生/发布构建档位、共享 CI 验证、只读检查与独立发布权限、不可覆盖候选包。

此前源码检查点的自动测试 534/534 通过。历史原生证据包括 Creator 3 UI 15/15、Creator 2 14/14，以及 Creator 3 Prefab 资源/实例专项；各自适用其记录的源码检查点，不表示全部能力均获当前原生验证。此 Release 由 CI 对 `v0.1.1` 发布提交重新进行类型检查、完整测试、构建和打包，并在上传前复核 SHA-256。

Prefab 实例源节点移动/删除需进入资源编辑模式；嵌套实例、压缩嵌套差异、动态字符串引用仍保留明确限制。未部署到用户工程或服务器。详见 [交付清单](https://github.com/iEfoam/CocosMcp/blob/main/docs/optimization-release-20261030.md)。

The earlier source checkpoint passed 534 automated tests. Historical native acceptance is fixture- and source-checkpoint-specific: Creator 3 UI 15/15, Creator 2 14/14, plus focused Creator 3 Prefab asset/instance persistence and Undo/Redo checks. CI independently typechecks, tests, builds and packages the `v0.1.1` commit, then verifies transferred artifact checksums. Nested Prefab overrides and dynamic reference rewriting retain documented limits. No project or server deployment is included.

## 安装 / Installation

**推荐：[让 AI 自动下载安装](https://github.com/iEfoam/CocosMcp/blob/main/README.zh-CN.md#让-ai-自动下载安装推荐)** — 直接复制提示词，AI 自动识别工程、从 GitHub 下载、安装、配置并验证连接，无需先手动准备 ZIP 或路径。

**Recommended: [AI-assisted automatic installation](https://github.com/iEfoam/CocosMcp/blob/main/README.md#let-ai-download-and-install-automatically-recommended)** — copy the prompt; let AI discover the project, download from GitHub, install, configure and verify the connection.

以下为手动安装方式 / Manual installation follows.

| Creator | 下载 ZIP / Download | 工程内目录 / Project directory |
| --- | --- | --- |
| 2.x | `cocos-mcp-creator2.zip` | `packages/cocos-mcp-creator2/` |
| 3.x | `cocos-mcp-creator3.zip` | `extensions/cocos-mcp-creator3/` |

多工程统一 stdio 接入另下载同版本 `cocos-mcp-client.zip`，按[统一客户端指南](https://github.com/iEfoam/CocosMcp/blob/v0.1.1/docs/unified-client.md)安装并授权目标工程。所有 ZIP 均需使用本 Release 的 `SHA256SUMS` 校验。

For unified multi-project stdio, also download this release's `cocos-mcp-client.zip`, follow the [unified client guide](https://github.com/iEfoam/CocosMcp/blob/v0.1.1/docs/unified-client.md), and authorize the target project. Verify every ZIP against this release's `SHA256SUMS`.

1. 准备 Cocos Creator 与 **Node.js 24+**，用同版本 `SHA256SUMS` 核对 ZIP。升级前停止 MCP 服务、关闭 Creator 并备份旧扩展。
2. 将 ZIP 内容解压到对应目录，确保 `package.json` 直接位于该目录内。
3. 在扩展根目录新建 `service-config.json`，设置 `nodeExecutable` 为本机 Node.js 24+ 的绝对路径。**发布 ZIP 不包含这份本机配置。**
4. 打开工程，通过 **CocosMCP → 打开控制中心 → 启动 MCP 服务** 启动服务，再用面板地址及本机 Bearer token 配置 AI 客户端的 Streamable HTTP MCP。

**[完整离线安装步骤](https://github.com/iEfoam/CocosMcp/blob/main/README.zh-CN.md#下载与离线安装) · [复制给 AI 的安装提示词](https://github.com/iEfoam/CocosMcp/blob/main/README.zh-CN.md#让-ai-自动下载安装推荐)**

For offline installation, have Creator and **Node.js 24+** available, verify the ZIP with `SHA256SUMS`, and extract it into the matching project directory above. Back up an existing extension before replacement. Create `service-config.json` beside `package.json`, setting `nodeExecutable` to your local Node executable's absolute path. Load the extension and start MCP from the control center, then configure your AI client's Streamable HTTP connection using the displayed endpoint and local Bearer token.

**[English installation guide](https://github.com/iEfoam/CocosMcp/blob/main/README.md#download-and-offline-installation) · [AI installation prompt](https://github.com/iEfoam/CocosMcp/blob/main/README.md#let-ai-download-and-install-automatically-recommended)**

`*.full.json` and the other Creator JSON bundles are for the plugin updater, not manual editor installation. GitHub's **Source code** archives need compilation. ZIP and update bundles share the same source fingerprint. **Pre-release** builds are development versions and are not installed automatically by the stable updater.
