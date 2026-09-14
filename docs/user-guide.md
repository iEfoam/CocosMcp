# CocosMCP 使用文档

CocosMCP 是面向 Cocos Creator 2.x 和 3.x 的 MCP 服务。它让 AI 客户端通过结构化工具读取和修改工程、场景、节点、组件、资源，并可连接开发运行时查询对象和调试数据。

本文面向第一次使用 CocosMCP 的用户。实现边界、版本适配和真实验收方法请参阅 [实施与验收指南](./implementation-guide.md)；完整设计范围请参阅 [实施提案](./cocos-mcp-proposal.md)。

## 1. 使用前准备

需要准备：

- Node.js 24 或更高版本。
- pnpm 11。
- Cocos Creator 2.x 或 3.x 编辑器。
- 一个可正常打开的 Cocos Creator 工程。
- 使用 stdio 时，一个支持 MCP 的桌面客户端；使用 HTTP 时，一个能调用 MCP Streamable HTTP 的客户端。

进入项目目录并安装依赖：

```bash
cd /path/to/CocosMcp
pnpm install
pnpm check
```

开发脚本的缓存、临时文件和构建产物写入本仓库的 `.codex-work/`；编辑器连接、工作流、操作日志和 Creator 构建数据写入目标 Cocos 工程的 `.codex-work/`。

## 2. 安装 Creator 扩展

先构建服务和扩展：

```bash
pnpm build
```

然后按编辑器版本安装。下面是 macOS 示例路径：

```bash
# Creator 2.4.x
pnpm start install \
  --project /path/to/my-cocos-project \
  --creator /Applications/Cocos/Creator/2.4.15/CocosCreator.app

# Creator 3.8.x
pnpm start install \
  --project /path/to/my-cocos-project \
  --creator /Applications/Cocos/Creator/3.8.8/CocosCreator.app
```

安装器会自动识别大版本：

| 编辑器 | 安装目录 | 启动方式 |
|---|---|---|
| Creator 2.x | `<project>/packages/cocos-mcp-creator2` | 加载扩展后自动启动，也可使用 `CocosMCP/启动桥接` |
| Creator 3.x | `<project>/extensions/cocos-mcp-creator3` | 加载扩展后自动启动，也可使用 `CocosMCP/启动桥接` |

如果目标目录已经有同名 CocosMCP 扩展，旧目录会备份到工程的 `.codex-work/build/extension-backups/`。不要手动复制 2.x 扩展到 3.x 目录，两个扩展使用不同的 Creator API。

## 3. 打开控制中心

安装扩展并打开工程后，从 Creator 顶部菜单选择 `CocosMCP/打开控制中心`。面板会作为可停靠窗口打开，包含四个页面：

- **总览**：Creator 版本、工程路径、当前窗口的桥接实例、运行时配置和桥接启停。
- **能力**：搜索能力目录，查看模块、操作类型和版本支持状态；“需运行时”表示需连接游戏实例。
- **日志**：显示最近的桥接事件，每 5 秒刷新。接口时间为 UTC，显示转换为设备时区，页脚标注时区名称。
- **运行时**：显示开发运行时配置是否已发现，并提示对象检查、事件、截图和性能能力。

面板通过 Creator 内部消息获取状态，认证 token 保留在扩展主进程；尚未打开场景或停止桥接时也可查看工程信息。能力页面的“可用”表示当前编辑器适配器已暴露且桥接已启动，具体参数和风险仍应通过 `cocos_capability_describe` 查询。运行时配置就绪不表示游戏已连接，实际会话请使用 `runtime.sessions` 查询。

如果提示 `Panel(...) is not defined` 或 `Cannot find module .../dist/panel`，请重新构建并安装插件，再在 Creator 扩展管理器重载该插件。Creator 3.x 使用顶层 `panels.default`，入口必须包含完整的 `dist/panel.cjs` 后缀；面板 ID 是 `cocos-mcp-creator3`。Creator 2.x 使用顶层 `panel` 和 `dist/panel.js`，面板 ID 是 `cocos-mcp-creator2`。

## 4. 检查环境

在打开 Creator 工程后执行：

```bash
pnpm start doctor \
  --project /path/to/my-cocos-project \
  --creator /Applications/Cocos/Creator/3.8.8/CocosCreator.app
```

doctor 会显示 Node 版本、操作系统架构、工程 ID、已发现的编辑器实例、Creator 版本、注册能力数量和覆盖状态。

看到实例之前，请确认：

1. Creator 打开的工程路径与 `--project` 完全相同。
2. 对应扩展已经安装并加载。
3. 3.x 从 `CocosMCP/显示连接状态` 或 `CocosMCP/启动桥接` 启动过桥接；2.x 从菜单启动过桥接或重新加载过扩展。
4. 工程内存在 `.codex-work/cache/cocos-mcp/instances/`，其中的实例进程仍然存活。

## 5. 启动 MCP 服务

### 4.1 stdio 模式

stdio 适合桌面 MCP 客户端。客户端配置的启动命令应等价于：

```bash
pnpm start serve --project /path/to/my-cocos-project
```

如果客户端从其他工作目录启动，请使用 CocosMCP 的绝对路径和工程的绝对路径。一个通用配置示例：

```json
{
  "mcpServers": {
    "cocos": {
      "command": "pnpm",
      "args": [
        "--dir",
        "/path/to/CocosMcp",
        "start",
        "serve",
        "--project",
        "/path/to/my-cocos-project"
      ]
    }
  }
}
```

### 4.2 HTTP 模式

HTTP 模式只监听 `127.0.0.1`：

```bash
pnpm start serve \
  --project /path/to/my-cocos-project \
  --transport http --port 0
```

服务启动后会在终端输出 MCP URL 和 token 文件路径。token 位于：

```text
<project>/.codex-work/cache/cocos-mcp/mcp-http-token
```

客户端请求必须使用：

```http
POST /mcp
Content-Type: application/json
Authorization: Bearer <token>
```

服务会拒绝非本机 Host/Origin、非 JSON 请求、非 POST 请求和超过 8 MiB 的请求体。不要把 token 放入 Git、聊天记录或测试报告。

### 4.3 注册全部独立工具

默认只注册常用能力的独立工具，长尾能力通过 `cocos_capability_execute` 统一调用。需要让客户端看到目录中全部独立工具时：

```bash
pnpm start serve \
  --project /path/to/my-cocos-project \
  --all-tools
```

## 6. 第一次调用

推荐所有客户端遵循以下顺序：

1. 调用 `cocos_projects` 获取工程列表和 `projectId`。
2. 调用 `cocos_instances` 获取编辑器实例和 `instanceId`。
3. 调用 `cocos_capability_search` 搜索能力。
4. 调用 `cocos_capability_describe` 获取参数 Schema、版本、风险和验证状态。
5. 调用 `scene.query` 或 `scene.snapshot` 读取当前状态。
6. 修改操作传入稳定的 `operationId` 和读取到的 `expectedRevision`。
7. 读回节点/组件，调用 `scene.save`，再用 `scene.snapshot` 或 `scene.diff` 验证。

### 5.1 查询场景

```json
{
  "projectId": "<projectId>",
  "capabilityId": "scene.query",
  "params": {}
}
```

### 5.2 创建节点并保存

```json
{
  "projectId": "<projectId>",
  "capabilityId": "node.create",
  "operationId": "create-login-panel-001",
  "expectedRevision": "<scene-revision>",
  "params": {
    "name": "LoginPanel",
    "parentId": "<parent-node-uuid>"
  }
}
```

创建成功后，使用返回的 `nodeId` 调用 `node.query`，确认实际节点存在；再调用 `scene.save`。超时或网络断开时，复用同一个 `operationId` 查询结果，不要立即创建第二个节点。

### 5.3 使用工作流

工作流适合把“打开场景、创建节点、加组件、保存”作为一个可追踪任务：

```json
{
  "projectId": "<projectId>",
  "steps": [
    {
      "capabilityId": "scene.open",
      "params": { "uuid": "db://assets/main.scene" }
    },
    {
      "capabilityId": "node.create",
      "operationId": "workflow-create-node-001",
      "params": { "name": "SettingsPanel" }
    },
    {
      "capabilityId": "scene.save",
      "params": {}
    }
  ]
}
```

先调用 `cocos_workflow_plan`。计划返回 `valid: true` 后，再调用 `cocos_workflow_execute`。默认某一步失败就停止；状态保存在：

```text
<project>/.codex-work/cache/cocos-mcp/workflows/<workflowId>.json
```

服务重启后可调用 `cocos_workflow_status` 查询状态。

## 7. 运行时调试

运行时能力需要开发构建的预览或运行实例。服务启动时会生成：

```text
<project>/.codex-work/cache/cocos-mcp/runtime-<server-pid>.json
```

把 `.codex-work/build/runtime/cocos-mcp.js` 或 `.mjs` 接入开发预览入口，并使用其中的 `projectId`、URL、token 和实际 `cc` 对象调用 `CocosMCP.connect`。连接成功后使用：

- `cocos_runtime_instances`：列出运行实例。
- `runtime.query`、`runtime.hierarchy`：查询运行场景。
- `runtime.inspect`、`runtime.get`、`runtime.set`：检查和修改公开属性。
- `runtime.invoke`：调用公开引擎方法。
- `runtime.subscribe`、`runtime.events`、`runtime.unsubscribe`：订阅和读取事件。
- `runtime.pause`、`runtime.resume`、`runtime.capture`、`runtime.statistics`：调试和采样。

运行时会拒绝私有成员、原型污染路径、宿主进程控制、脚本执行、节点销毁和换父等危险入口。场景切换后旧句柄会失效，收到 `STALE_HANDLE` 时应重新查询对象。

## 8. 构建项目

构建能力通过 MCP 工具执行：

```text
cocos_build_start
cocos_build_status
cocos_build_logs
cocos_build_cancel
cocos_build_list
```

构建必须指定 Creator 可执行文件和平台。构建配置、产物和日志由服务控制：

```text
<project>/.codex-work/tmp/       构建配置临时文件
<project>/.codex-work/build/     构建产物
<project>/.codex-work/logs/      构建日志
```

真实平台构建还要求对应 SDK、证书、设备工具和 Creator GUI。任务状态为 `outcome-unknown` 时，先检查产物和日志，再决定是否重试。

## 9. 常见错误处理

| 错误 | 处理方式 |
|---|---|
| `CONTEXT_UNAVAILABLE` | 打开工程、启动扩展或连接开发运行时 |
| `AMBIGUOUS_TARGET` | 传 `instanceId` 或 `runtimeInstanceId` |
| `STALE_REVISION` | 重新读取 snapshot/revision 后重试 |
| `STALE_HANDLE` | 重新查询节点或运行时对象 |
| `UNSUPPORTED_VERSION` | 查看能力详情中的 `supportedMajors` |
| `UNSUPPORTED_CAPABILITY` | 能力可能是规划中，或当前适配器未暴露 |
| `UNAUTHORIZED` | 检查 `--allow-project-code`；同时确认没有调用危险路径 |
| `PATH_OUTSIDE_PROJECT` | 使用工程内资源 URL 和文件路径 |
| `OPERATION_CONFLICT` | 同一 operationId 必须保持能力和参数不变 |
| `OUTCOME_UNKNOWN` | 先查询操作、场景或构建状态 |
| `VERIFICATION_FAILED` | 保留现场，重新读取并人工检查 |

## 10. 停止服务与清理

在终端按 `Ctrl-C` 停止服务。停止 Creator 扩展桥接后，实例描述文件会被删除；运行时配置也会在服务关闭时删除。清理测试工程时，只删除本次创建的工程目录，不要删除已有项目的 `.codex-work/` 或扩展备份。


## 从控制中心启动 MCP 服务

在“总览”或“运行时”页点击“启动 MCP 服务”，扩展会启动当前工程的本地 HTTP MCP 服务及开发运行时网关，并显示连接地址。客户端需使用工程 `.codex-work/cache/cocos-mcp/mcp-http-token` 中的 Bearer token。此操作不会自动打开游戏预览或接入游戏脚本。

“停止 MCP 服务”仅停止此扩展启动的进程。关闭面板不会停止服务；卸载或重载扩展、退出编辑器会停止服务。若工程已有外部启动的运行时网关，按钮会提示先停止外部服务，避免重复启动。

扩展安装器记录安装时的 Node.js 路径（要求 Node.js 24+），服务程序随扩展打包。更换电脑或 Node.js 路径后，请重新执行扩展安装命令。面板不会显示认证 token 内容。

## 控制中心版本与更新

控制中心从 `iEfoam/CocosMcp` 的最新 GitHub Release 读取版本，打开面板时检查，此后每 5 分钟检查一次。“更新版本”会重新查询最新版本、下载对应 Creator 2/3 扩展包，校验 SHA-256 和文件清单，备份并安装。无须本地源码或 GitHub token，但需要已配置的 Node.js 24+ 和联网。

每次推送到 `main` 会触发 GitHub Actions：按锁文件安装依赖，运行类型检查、构建和测试，通过后发布版本 `0.1.0-build.<流水线编号>.<提交短号>`。无需手动修改版本号；失败的构建不会替换上一可用发布。基础版本从根目录 `package.json` 读取。

底部区分运行中版本、GitHub 最新版本和已安装待重载版本。安装完成后需在扩展管理器中重载并重新启动 MCP 服务，不会自动重启 Creator。下载或校验失败会保留现有扩展。下载和备份保存在工程 `.codex-work/`。
