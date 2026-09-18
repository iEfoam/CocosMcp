# CocosMCP 实施与验收指南

本文是当前仓库的实施手册，面向开发者、扩展维护者和执行验收的团队。它以仓库源码为准，补充 [CocosMCP 实施提案](./cocos-mcp-proposal.md) 中的工程落地细节。文档中的“已实现”表示代码存在对应适配器；只有标记为 `editor-verified` 或 `runtime-verified` 的能力，才表示已经在真实编辑器或开发运行时完成验证。

更新日期：2026-09-18。版本功能以 [支持矩阵](version-support.md) 为总览；2.4.15 的逐项证据和完整缺口见 [验收台账](creator2-expansion-tracker.md)。

## 1. 当前交付边界

CocosMCP 由独立 MCP 服务、Creator 2.x 扩展、Creator 3.x 扩展、编辑器桥接、运行时桥接和能力目录组成。服务端不直接依赖 Creator 的 Electron 全局对象，扩展只负责把版本相关 API 转成稳定的 HTTP RPC；所有写入操作都经过能力 Schema、工程路径和实例校验。

当前仓库已经提供：

- MCP stdio 和仅监听回环地址的 Streamable HTTP 传输。
- Creator 2.x `packages/` 扩展和 Creator 3.x `extensions/` 扩展。
- 工程、编辑器实例、能力搜索/详情/覆盖率查询。
- 场景、节点、组件、资源、预制体、选择集、撤销/重做和场景差异查询。
- Creator 3.x 的编辑器消息、项目设置、场景视图和 AssetDB 适配。
- 开发运行时对象句柄、属性读写、公开方法调用、事件、暂停恢复、截图和基础指标。
- Creator CLI 构建任务、状态、日志、取消、产物目录和持久化任务索引。
- 工作流规划、顺序执行、失败停止、状态持久化及操作幂等记录。
- Creator/引擎源码候选能力目录生成器。

当前不能据代码直接宣称“完成整个 Cocos 引擎”：能力目录中的 54 个模块是工作分解维度，模块下的对象、属性和平台后端仍需逐项适配与验收。`ui.build` 已接入 2.4.15 / 3.8.8 的受守卫创建流程，需先调用 `ui.plan`；2.4.15 已有结构编辑、Undo/Redo、保存重开及真实控件输入验收。资源依赖/使用者也已适配 2.4.15。任意编辑器消息、focus/grid 等限制仍按入口保留，不能把有处理器或个别验收通过当成模块完成。

## 2. 目录与职责

```text
apps/server/                 MCP 服务、CLI、stdio/HTTP 传输
packages/contracts/          JSON、错误码、能力和桥接协议
packages/application/        工程注册、队列、用例编排、工作流和操作查询
packages/capability-catalog/ 能力定义、Schema、版本和验证状态
packages/creator2-adapter/   Creator 2.x 编辑器适配器
packages/creator3-adapter/   Creator 3.x 编辑器适配器和属性序列化
packages/editor-bridge/      编辑器侧回环 RPC、幂等 ledger、路径守卫
packages/runtime3-bridge/    开发运行时控制器和安全策略
packages/runtime2-bridge/    Creator 2.x 运行时控制器入口
packages/native-adapters/    Creator 定位、扩展安装、构建任务
packages/catalog-generator/  ASAR 和 cocos-engine 源码候选目录
extensions/creator2/         2.x 扩展源码和场景脚本
extensions/creator3/         3.x 扩展源码和场景脚本
tests/                       契约和安全回归测试
docs/                        提案、实施、验收文档
```

`ProjectPaths` 是所有文件操作的边界。它将临时、缓存、构建、日志、下载统一映射到工程内 `.codex-work/`，并检查不存在目标的祖先路径和符号链接，防止路径逃逸。扩展实例描述文件、操作 ledger、HTTP token 和工作流状态都属于工程私有数据。

## 3. 环境准备

要求 Node.js 24 或更高版本、pnpm 11，以及本机可启动的 Creator 2.x 或 3.x。建议使用本机安装的 2.4.15 和 3.8.8 作为第一套基线；其他补丁版本必须重新执行能力和回归矩阵。

```bash
cd /path/to/CocosMcp
pnpm install
pnpm check
```

仓库脚本会创建并使用以下目录，不要把缓存指向系统临时目录：

```text
.codex-work/tmp/       临时目录和扩展安装 staging
.codex-work/cache/     pnpm、Node、能力目录、HTTP token、实例状态
.codex-work/build/     服务、扩展、运行时和 Creator 构建产物
.codex-work/logs/      构建日志和操作审计日志
.codex-work/downloads/ 下载的源码或外部资源
```

## 4. 构建与安装扩展

构建命令会同时生成服务、两套扩展和运行时脚本：

```bash
pnpm build
```

产物为：

```text
.codex-work/build/server/cli.mjs
.codex-work/build/extensions/creator2/{package.json,dist/*}
.codex-work/build/extensions/creator3/{package.json,dist/*}
.codex-work/build/runtime/cocos-mcp.js
.codex-work/build/runtime/cocos-mcp.mjs
```

安装时必须指定工程和 Creator 安装目录。安装器会读取编辑器版本，选择对应大版本，并在替换同名扩展前把旧版本备份到工程的 `.codex-work/build/extension-backups/`。

```bash
pnpm start install \
  --project /path/to/cocos-project \
  --creator /Applications/Cocos/Creator/3.8.8/CocosCreator.app
```

安装位置：

| Creator | 扩展位置 | 清单入口 |
|---|---|---|
| 2.x | `<project>/packages/cocos-mcp-creator2` | `main`、`scene-script`、`main-menu` |
| 3.x | `<project>/extensions/cocos-mcp-creator3` | `main`、`contributions.scene`、`contributions.messages` |

两套扩展加载时自动启动桥接；菜单统一为“关于 CocosMCP → 打开控制中心 → 检查更新”。桥接启动/停止移到控制中心，总览显示桥接、MCP 服务与运行时的独立状态。

## 5. 启动服务与连接检查

先用 doctor 检查路径、Node、架构、编辑器版本和实例：

```bash
pnpm start doctor \
  --project /path/to/cocos-project \
  --creator /Applications/Cocos/Creator/3.8.8/CocosCreator.app
```

正常启动 MCP 服务：

```bash
# stdio：供桌面 MCP 客户端使用
pnpm start serve --project /path/to/cocos-project

# HTTP：端口 0 由系统分配，地址和 token 文件路径打印到 stderr
pnpm start serve --project /path/to/cocos-project \
  --transport http --port 0
```

HTTP 服务只绑定 `127.0.0.1`，请求必须满足以下条件：

- `POST /mcp`、`Content-Type: application/json`。
- `Authorization: Bearer <token>`，token 位于 `<project>/.codex-work/cache/cocos-mcp/mcp-http-token`，权限为 0600。
- Host 和 Origin 只能是本机地址。
- 请求体最大 8 MiB。

扩展桥接使用类似的回环 `POST /rpc`，实例描述文件位于：

```text
<project>/.codex-work/cache/cocos-mcp/instances/<instanceId>.json
```

服务发现实例时会校验项目路径、Creator 大版本、PID、回环 endpoint、token 格式和进程是否存在；`cocos_instances` 对外返回时会移除 token。

## 6. 推荐的 MCP 调用顺序

每次修改都应先定位目标，再读取 revision，最后写入并读回：

```text
cocos_projects
  -> cocos_instances
  -> cocos_capability_search / cocos_capability_describe
  -> scene.query 或 scene.snapshot
  -> cocos_capability_execute（operationId + expectedRevision）
  -> scene.query / node.query / component.query
  -> scene.save
  -> scene.snapshot 或 scene.diff
```

能力执行的公共参数如下：

| 参数 | 用途 |
|---|---|
| `projectId` | 服务启动时注册的工程 ID，必填 |
| `instanceId` | 多个 Creator 实例同时打开时指定目标 |
| `runtimeInstanceId` | 运行时能力指定开发运行实例 |
| `operationId` | 修改操作幂等键；重试时必须复用 |
| `expectedRevision` | 写入前的场景版本，防止覆盖其他编辑 |
| `params` | 能力详情返回的 JSON Schema 参数 |

示例（命令行调用）：

```bash
pnpm start call \
  --project /path/to/cocos-project \
  --capability scene.query \
  --params '{}'
```

HTTP/MCP 客户端应优先调用 `cocos_capability_describe` 获取精确 Schema。`--all-tools` 可以注册目录中的独立工具名；默认只注册常用工具，长尾能力统一通过 `cocos_capability_execute` 调用。

## 7. 当前能力矩阵

能力目录按 `module`、`context`、`effect`、`versions`、`supportedMajors`、`implementation` 和 `verification` 描述每项操作。当前已接入的核心操作包括：

| 领域 | 操作示例 | Creator 2.4.15 | Creator 3.8.8 |
|---|---|---:|---:|
| 编辑器状态 | `editor.status`、`selection.query/set` | ✓ | ✓ |
| 场景 | `scene.query/snapshot/diff/hierarchy/open/save/create/close` | ✓ | ✓ |
| 节点 | `node.find/query/create/delete/duplicate/reparent/set/reset` | ✓ | ✓ |
| 组件 | `component.types/add/query/delete/set/reset` | ✓ | ✓ |
| 资源 | `asset.query/info/meta/create/save/import/copy/move/delete/refresh/reimport/set_meta/resolve` | ✓ | ✓ |
| 资源依赖 | `asset.dependencies/users` | ✓；含独立引用审计 | ✓ |
| 预制体 | `prefab.instantiate/create/apply/revert/unlink` | ✓ | ✓ |
| 选择集 | `selection.query/set` | ✓ | ✓ |
| 编辑器消息 | `editor.messages/message` | — | ✓ |
| 项目设置 | `project.settings.get/set` | ✓，要求宿主 setting | ✓ |
| 视图 | `view.query/set/focus` | query、部分 set；focus/grid 不支持 | 按原生端点及参数判断 |
| 预览 | `preview.start/stop/status/capture/input/logs` | MCP 自有窗口 | MCP 自有窗口 |
| 桥接日志与校验 | `logs.query`、`scene.validate` | ✓ | ✓ |
| Creator 控制台 | `console.query`（含 Scene 消息与堆栈） | 未接入 | 仅 3.8.8，要求 `Editor.Logger.query` |
| 声明式 UI | `ui.plan/build/diff/apply`、布局/交互检查 | 已实现；另有结构计划和删除守卫原生记录 | 已实现；已有 UI 创建及真实菜单输入记录，非完整 UI 验收 |
| 运行时 | `runtime.query/hierarchy/types/inspect/get/set/invoke/create/release/subscribe/unsubscribe/events/pause/resume/capture/statistics` | 运行时桥接 | 运行时桥接 |
| 2.x 专属扩展 | 控件、资源趋势、Tween、骨骼事件/混合、Camera、接触任务 | 见 2.4.15 验收台账 | 不自动提供同名接口 |

`cocos_coverage` 会分别报告 registered、implemented、planned、verified 等数量。这个结果是当前仓库实现状态，不等同于 Cocos 引擎 API 覆盖率；引擎源码扫描得到的候选能力必须经过适配、Schema 定义和实际验证后才能进入可执行集合。

## 8. 2.x 与 3.x 适配规则

服务端使用同一能力 ID，版本适配器负责转换底层消息：

- 2.x 通过 `Editor.Scene.callSceneScript`、`Editor.assetdb`、`Editor.Selection` 和 `Editor.Ipc` 工作。
- 3.x 通过 `Editor.Message.request`、场景脚本 `execute-scene-script`、`Editor.Profile`、`Editor.Selection` 和贡献式消息清单工作。
- 2.x 节点承担部分 UI 尺寸、锚点和透明度语义；3.x 通常由 `UITransform`、`UIOpacity` 等组件承担，不能直接复制属性路径。
- 2.x 资源 AssetDB 的回调和同步 API 与 3.x 消息式 AssetDB 不同，适配器必须在边界处统一为 Promise 和 JSON。
- 2.x 预制体序列化、动画和资源格式与 3.x 不同，跨版本工作流应使用能力语义，不能传递另一版本的内部序列化结构。
- 3.x 编辑器消息调用要求 `editorVersion` 精确匹配；内部消息还要求显式启动 `--allow-project-code`。

未被适配器列入 `supportedCapabilities()` 的能力会在执行前返回 `UNSUPPORTED_CAPABILITY` 或 `UNSUPPORTED_VERSION`，不会降级成伪成功。

## 9. 工作流、幂等和并发

推荐先规划再执行：

1. `cocos_workflow_plan` 批量校验 Schema、版本、实现状态、风险、前置条件和副作用。
2. 只有 `valid: true` 的计划才提交 `cocos_workflow_execute`。
3. 工作流按工程串行执行；默认遇到失败即停止，`continueOnError: true` 才会继续。
4. 状态写入 `<project>/.codex-work/cache/cocos-mcp/workflows/<workflowId>.json`，服务重启后可用 `cocos_workflow_status` 查询。
5. 每个修改步骤设置稳定 `operationId`。服务进程内和编辑器 ledger 都会复用已完成结果；参数改变会返回 `OPERATION_CONFLICT`。
6. 超时或断线后先用 `cocos_operation_query` 查询结果。ledger 处于 pending 时返回 `OUTCOME_UNKNOWN`，调用方应先检查编辑器状态。

工程队列保证同一工程的操作顺序；`expectedRevision` 负责防止读取后被其他编辑改变。资源写入、场景修改和项目设置的回滚能力以能力详情中的 `rollback` 为准，工作流不会假装提供全局事务。

### 日志读取与分页

控制中心的“桥接日志”支持级别筛选、每页 20/50/100 条和上一页/下一页，覆盖桥接内存保留的最近 5,000 条事件。第一页每 5 秒刷新；浏览历史页时固定快照，点击“返回最新”或“刷新日志”恢复实时数据。切换级别或每页条数会回到第一页。这些事件不等于 Creator 控制台日志。

Creator 3.8.8 可通过 `cocos_capability_execute` 调用 `console.query`，从原生 `Editor.Logger.query()` 读取编辑器主进程及 Scene 等子进程汇总的控制台消息：

```json
{
  "capabilityId": "console.query",
  "params": { "level": "error", "process": "Scene", "limit": 50 }
}
```

沿用当前工程的 `projectId`/`instanceId`；结果中 `rows` 保留 `message`、`stack`、`process`、归一化 `level` 和原始 `rawLevel`。`log` 归入 `info`，不会根据消息内容将原生日志改判成错误。`contains` 同时匹配消息与堆栈；以 `nextCursor` 作为下次请求的 `cursor`，`hasMore` 表示当前筛选下还有数据。按时间顺序返回，最多保留原生日志末尾 5,000 条，每次最多 500 条；扩展重载后从 `cursor: 0` 重新读取。`occurredAt` 输出 UTC ISO 字符串，无法确定时区的原始时间返回 `null`。

此能力无需已打开场景或运行时连接，不修改控制台级别、不清空日志，也不执行任意编辑器消息。独立浏览器预览的控制台不在此范围；MCP 自有预览仍通过 `preview.status` 返回窗口诊断。Creator 2.x 和其他 3.x 补丁版本未接入该原生读取适配，不能宣称跨版本验证。

## 10. 运行时桥接接入

运行时桥接只允许开发构建和回环 URL。将构建产物 `cocos-mcp.js` 或 `cocos-mcp.mjs` 注入预览入口后，以实际 `cc` 对象连接：

```ts
const connection = await CocosMCP.connect({
  url: 'http://127.0.0.1:<gateway-port>',
  token: '<gateway-token>',
  projectId: '<project-id>',
  cc,
  major: 3,
  development: true,
});
```

服务启动时会把每个工程的运行时连接参数写入 `<project>/.codex-work/cache/cocos-mcp/runtime-<server-pid>.json`，其中包含 `projectId`、回环 URL 和随机 token；文件权限为 0600，服务关闭时删除。不要把该文件提交到版本库或写入测试报告。

运行时对象通过受控句柄传递。场景切换会递增 generation，使旧句柄变成 `STALE_HANDLE`；事件订阅会在场景销毁时清理。属性路径禁止 `__proto__`、`prototype`、`constructor` 和下划线成员；方法路径最多四段、参数最多 32 个，并拒绝 `eval`、宿主进程控制和节点销毁/换父等危险入口。`runtime.release` 只有对桥接创建且拥有的对象才允许 `destroy: true`。

当前 `runtime.statistics` 真实返回节点数、组件数、deltaTime 和 totalFrames；GPU 内存、DrawCall 和三角形明确列为不可用指标，不能在报告中写成已采集。

## 11. 构建任务

MCP 构建工具使用指定 Creator 可执行文件和工程路径，自动生成构建配置到工程 `.codex-work/tmp/`，产物写入 `.codex-work/build/creator/<jobId>/`，日志写入 `.codex-work/logs/builds/<jobId>.log`：

```text
cocos_build_start
  -> cocos_build_status
  -> cocos_build_logs
  -> cocos_build_cancel（仍在运行时）
  -> 检查产物路径和状态
```

构建参数中的 `project`、`projectPath`、`configPath`、`buildPath`、`dest` 和 `platform` 由任务控制，调用方不能覆盖。服务重启时仍在运行的任务会标记为 `outcome-unknown`，避免把未知结果当成功。

真实构建还依赖 Creator GUI、目标平台 SDK、证书和设备工具。没有这些外部条件时只能完成参数和任务状态测试。

## 12. 安全和错误处理

主要错误码及处理建议：

| 错误码 | 典型原因 | 客户端动作 |
|---|---|---|
| `CONTEXT_UNAVAILABLE` | 工程/运行时未就绪，或等待帧超时 | 检查连接与 gamePaused/directorPaused/timeoutMs；不得自动 resume 用户游戏 |
| `AMBIGUOUS_TARGET` | 同工程有多个实例 | 指定 `instanceId` |
| `STALE_REVISION` | 场景已被其他操作修改 | 重新 snapshot 后重试 |
| `STALE_HANDLE` | 场景切换或对象已销毁 | 重新 query 获取句柄 |
| `UNSUPPORTED_VERSION` | 能力不适用于当前大版本或消息版本 | 查询 capability details 和版本矩阵 |
| `UNSUPPORTED_CAPABILITY` | 能力是 planned 或适配器未暴露 | 不重复重试，转人工或补适配 |
| `UNAUTHORIZED` | 外部脚本/内部消息未显式授权，或运行时路径被策略拒绝 | 检查启动参数和能力风险 |
| `PATH_OUTSIDE_PROJECT` | 资源或文件路径越出工程 | 改用工程内路径 |
| `OUTCOME_UNKNOWN` | 操作中断，结果不确定 | 查询 operation、场景和构建状态 |
| `VERIFICATION_FAILED` | 写入后读回不一致 | 保留错误现场，重新读取并人工判断 |

服务不会把项目源码、资源内容或 token 写入通用操作审计日志；日志只记录 operationId、能力、工程、实例、revision 和完成时间。

## 13. 源码目录与能力扩展流程

扫描本机 Creator 或 `cocos-engine` 时，结果只能作为 `source-only` 候选：

```bash
pnpm start catalog --project /path/to/cocos-project \
  --creator /Applications/Cocos/Creator/3.8.8/CocosCreator.app

pnpm start catalog --project /path/to/cocos-project \
  --engine /path/to/cocos-engine
```

生成文件位于工程 `.codex-work/cache/catalog/`，引擎扫描同时生成 `engine.json` 和 `engine-capabilities.json`，记录模块、公开/内部 API、平台条件、废弃标记、源码位置和 fingerprint。新增能力必须按以下顺序进入生产：

1. 从源码确认 API 的版本、模块和平台条件。
2. 在 `packages/capability-catalog/src/operations.ts` 增加稳定能力 ID、Schema、effect、风险和回滚说明。
3. 在 creator2/creator3 或 runtime 适配器中实现，禁止绕过适配器执行任意 eval。
4. 增加契约或适配器测试，错误路径也要验证。
5. 在真实 Creator 工程中执行并读回，更新 verification。
6. 更新本指南的能力矩阵和版本差异。

## 14. 真实验收清单

针对 Creator 2.4.15 和 3.8.8 各准备独立 Golden Project，至少执行：

- `doctor`、实例发现和扩展启动/停止。
- 场景创建、打开、节点创建/重命名/换父、组件添加/属性写入、保存和 snapshot/diff。
- 资源创建、导入、查询、复制、移动、meta 写入和删除，并检查工程文件。
- 预制体实例化、保存、应用、还原和解除关联。
- 多实例指定、revision 冲突、重复 operationId、错误参数和工程外路径。
- Creator 3.x 编辑器消息精确版本校验；Creator 2.x 不支持项返回预期错误。
- 开发预览运行时的 query、hierarchy、inspect、get/set、invoke、事件、暂停恢复、capture、statistics 和 stale handle。
- 构建任务启动、日志、成功/失败/取消、服务重启后的状态恢复。
- 失败工作流的停止位置、持久化状态和补偿提示。

验收结果应分为 `contract-tested`、`adapter-tested`、`editor-verified`、`runtime-verified` 和 `device-verified`，并记录 Creator 版本、macOS 架构、平台 SDK、工程 fingerprint、日志路径和未执行原因。关闭测试前先停止 Creator、MCP 服务和运行时，再只删除本次 Golden Project 目录及其测试报告。

## 15. 常见问题

**看不到实例。**确认 Creator 已打开目标工程，扩展目录位于对应位置，并从控制中心检查/启动桥接；再检查 `.codex-work/cache/cocos-mcp/instances/` 中的 JSON 是否仍对应存活 PID。

**场景修改返回 `STALE_REVISION`。**不要复用旧 snapshot。重新读取 `scene.snapshot`，确认用户没有并行编辑后再提交新的 operationId。

**`editor.message` 被拒绝。**该能力只在 Creator 3.x 暴露，并且 `editorVersion` 必须等于实例描述中的完整版本号；内部消息还需要 `--allow-project-code`。

**运行时只能查询，不能调用。**检查预览是否是 development 构建、URL 是否为回环地址、token 和 projectId 是否匹配。危险方法和私有路径即使在开发构建中也会被策略拒绝。

**构建一直未知。**先读取 `cocos_build_status` 和日志，确认 Creator 是否仍在运行；未知状态下不要重复提交同一构建，先确认产物和编辑器状态。

## 16. 文档维护规则

代码、能力目录和本指南必须一起更新。任何新增能力至少补充版本范围、输入 Schema、effect、前置条件、副作用、风险、回滚提示和验证等级；任何真实编辑器行为变化都要在 2.x/3.x Golden Project 回归后再提升 verification。提案文档保留为设计和调研记录，本指南记录当前可执行事实。

### Creator 3 运行时桥接发布包

Creator 3 更新包必须包含 `dist/runtime.js`，安装校验会拒绝缺少该文件的包。仅支持旧七文件清单的已安装版本不能直接使用面板升级到此版本；首次迁移请从本仓库构建后使用 CLI `install` 更新扩展并重载，之后可使用新版面板更新。两套扩展的当前文件清单统一以 `packages/native-adapters/src/extension-files.json` 为准，Creator 2/3 各自打包相应 runtime.js 和双语资料；旧版精确清单兼容包与 full 包的区别见 [扩展打包](extension-packaging.md)。
