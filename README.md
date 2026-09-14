# CocosMCP

免费、MIT 授权、无账号和调用配额的 Cocos Creator MCP 实现。当前代码已建立 Creator 2.x／3.x 双扩展、独立 MCP 服务、能力目录、运行时桥接、Creator CLI 构建任务和源码候选目录生成器。

## 当前状态

本仓库完成了第一阶段可执行骨架和核心编辑闭环适配：

- MCP stdio 与本地 Streamable HTTP 服务。
- Creator 2.x `packages/` 扩展和 Creator 3.x `extensions/` 扩展。
- 场景、节点、组件、资源、预制体、选择集、撤销、日志和运行时对象操作入口。
- 已注册操作覆盖提案中的 54 个功能模块；`cocos_coverage` 会分别返回 registered、implemented、planned、verified 数量和各验证等级，不再把工具注册数量当成功能完成度。
- 运行时开发桥接只允许回环地址和开发构建，支持对象句柄、事件、暂停恢复、截图和真实可用指标；属性路径、方法路径和参数数量经过运行时策略校验，危险宿主入口会被拒绝。
- Creator 源码/编辑器 ASAR 候选能力目录生成，结果标记为 `source-only`，不会伪装成运行验证。
- 引擎源码目录分析会生成 `engine-capabilities.json`，记录公开/内部 API、模块、平台条件、废弃标记和源码位置；在当前 `cocos-engine` 快照上已发现 27,611 个源码候选，其中 20,900 个被识别为公开候选，仍需逐项适配和验证。
- 场景支持 `scene.snapshot` 和 `scene.diff`，可在工作流执行前保存基线、比较结构变化并进行回归检查。
- Creator 3.8.8 的 Shader/材质工具：Effect 原生编译、依赖指纹、带哈希守卫的资源编辑、材质实例调参、宏变体和 RenderTexture 预览。使用方式、精确版本与验证边界见 [Shader 开发指南](docs/shader-development.md)。
- Creator CLI 构建任务、状态、日志、取消和产物检查；任务索引持久化在工程 `.codex-work/cache/cocos-mcp/build-jobs.json`，服务重启后可查询，重启时仍在执行的任务会标记为状态未知失败，避免永久占用工程。
- 显式 `operationId` 支持进程内幂等复用，操作完成结果可通过 `cocos_operation_query` 查询；审计日志只记录操作元信息。
- 工作流编排支持 `cocos_workflow_plan` 和 `cocos_workflow_execute`：先批量校验参数、版本、风险和副作用，再按顺序执行多步场景生产流程；默认失败即停，并返回已完成步骤和补偿提示。
- Creator 2.x/3.x 扩展提供可停靠的 CocosMCP 控制中心，展示工程、编辑器实例、能力状态、桥接日志和开发运行时状态，并支持桥接启停。
- 工作流状态会持久化到 `.codex-work/cache/cocos-mcp/workflows/`，可使用 `cocos_workflow_status` 在服务重启后查询进度和失败步骤。
- 能力目录会分别报告 Creator 2.x/3.x 的 `creator2Operations` 和 `creator3Operations`；不支持的版本会在执行前返回版本错误。
- `scene.diff` 返回 `added`、`removed`、`changed` 路径记录，支持节点、组件、属性和数组的递归比较。

完整范围和后续阶段见 [实施提案](docs/cocos-mcp-proposal.md)。

当前代码的安装、能力矩阵、2.x/3.x 差异、运行时桥接、构建任务、安全边界和真实验收步骤见 [实施与验收指南](docs/implementation-guide.md)。

面向日常使用的安装、启动、调用示例见 [使用文档](docs/user-guide.md)；按领域查看能力和版本限制见 [功能介绍](docs/feature-reference.md)。

Creator 3.8.8 的参数化几何体、重复阵列、渲染设置、独立预览窗口和 MCP 图片截图见 [场景生产与预览](docs/scene-production.md)。该模块明确区分已保存配置、实际绘制帧以及需要自定义管线的 AO/物理透射效果。

## 开发

需要 Node.js 24 或更高版本。依赖和所有构建、测试缓存由项目配置放在 `.codex-work/`。

```bash
pnpm install
pnpm check
```

构建产物：

```text
.codex-work/build/server/cli.mjs
.codex-work/build/extensions/creator2/
.codex-work/build/extensions/creator3/
.codex-work/build/runtime/
```

## 命令

```bash
# 查看环境、工程和 54 个模块的覆盖状态
pnpm start doctor --project /path/to/project

# 生成 Creator 3 编辑器消息和类型候选目录
pnpm start catalog --project /path/to/project --creator /Applications/Cocos/Creator/3.8.8/CocosCreator.app

# 分析 cocos-engine 源码并生成 engine-capabilities.json
pnpm start catalog --project /path/to/project --engine /path/to/cocos-engine

# 把对应扩展安装到工程（安装前会备份同名旧扩展）
pnpm start install --project /path/to/project --creator /Applications/Cocos/Creator/3.8.8/CocosCreator.app

# stdio（供 Claude Desktop、Cursor 等客户端）
pnpm start serve --project /path/to/project

# 本地 HTTP；token 会写入工程 .codex-work/cache/cocos-mcp/mcp-http-token
pnpm start serve --project /path/to/project --transport http --port 0
```

HTTP 服务只绑定 `127.0.0.1`，要求 Bearer token，并拒绝非本地 Host/Origin。项目代码或任意编辑器消息调用需要显式启动参数 `--allow-project-code`。

工作流示例：

```json
{
  "projectId": "<project-id>",
  "steps": [
    { "capabilityId": "scene.open", "params": { "uuid": "db://assets/main.scene" } },
    { "capabilityId": "node.create", "params": { "name": "LoginPanel" } },
    { "capabilityId": "scene.save", "params": {} }
  ]
}
```

建议先调用 `cocos_workflow_plan`。只有计划中的每一步参数有效且没有未授权的外部能力时，再调用 `cocos_workflow_execute`。工作流本身不会假装提供通用回滚；每项能力会返回自己的 `rollback` 提示，调用方应据此设计补偿步骤。

## 能力验证等级

能力目录中的 `verification` 字段表示证据层级：

```text
source-only       只由 Creator 源码、声明文件或 ASAR 候选分析得到
unverified        已注册但尚未完成自动化验证
contract-tested   已通过参数和协议契约测试
adapter-tested    已通过模拟编辑器/运行时适配器测试
editor-verified   已在真实 Creator 编辑器工程中验证
runtime-verified  已在真实开发运行时验证
device-verified   已在目标设备或平台验证
```

当前仓库的自动化检查覆盖 Schema、路径安全、能力目录和运行时策略；Creator 2.4.15/3.8.8 的真实编辑器、真机、平台 SDK 和 GPU 指标仍需要在对应环境中建立 Golden Project 后验收，不能仅依据 `pnpm check` 宣称完成。

## Creator 扩展安装

先执行 `pnpm build`，再用 `install` 命令安装构建出的扩展。Creator 2.x 扩展放入项目 `packages/`；Creator 3.x 扩展放入项目 `extensions/`。扩展启动后会在项目内写入受保护的实例描述文件，MCP 服务会自动发现并按项目、编辑器版本和实例 ID 路由请求。

## 许可证

自有代码采用 MIT。Cocos Creator、引擎、Spine、DragonBones、平台 SDK 和其他第三方依赖分别遵循其各自许可证；本项目不改变第三方条款。

资源创建目录规则与项目整理功能：[项目资源整理](docs/asset-organization.md)。
