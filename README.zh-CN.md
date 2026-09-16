<p align="center">
  <img src="docs/assets/readme-hero.svg" alt="CocosMCP — 连接 AI 与 Cocos Creator" width="100%">
</p>

<h1 align="center">CocosMCP</h1>

<p align="center">
  免费、MIT 授权的 Cocos Creator 2.x / 3.x MCP 实现。<br>
  让 AI 客户端连接编辑器、项目资源与开发运行时。
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#文档导航">文档导航</a> ·
  <a href="#验证与安全边界">验证与安全边界</a>
</p>

<p align="center">
  <img src="docs/assets/codex.svg" width="20" height="20" alt="代码图标">
  <strong>本项目全部由 Codex 实现。</strong><br>
  本项目的全部自有代码均使用 Codex 实现；第三方软件和依赖保留各自的作者归属与许可证。
</p>

---

## 为什么选择 CocosMCP？

通过结构化 MCP 工具操作场景、节点、组件、资源和运行时对象。CocosMCP 在本地运行，无需 CocosMCP 账号，也不设置工具调用配额；AI 客户端自身的使用条件和额度仍然适用。

仓库包含 Creator 2.x / 3.x 独立扩展、独立 MCP 服务、能力目录和开发运行时桥接。已注册操作覆盖 **54 个功能模块**，注册、实现与验证分别统计，不把注册覆盖率当作全部功能已完成。

## 核心能力

| | 领域 | 能做什么 |
| :---: | --- | --- |
| <img src="docs/assets/editor.svg" width="28" height="28" alt="编辑器"> | **编辑器与资源** | 操作场景、节点、组件、预制体、选择集、撤销和日志；资源整理先生成计划，再执行变更。 |
| <img src="docs/assets/runtime.svg" width="28" height="28" alt="运行时"> | **开发运行时** | 通过受策略保护的开发桥接检查对象句柄、使用事件、暂停恢复、截图和查询可用指标。 |
| <img src="docs/assets/workflow.svg" width="28" height="28" alt="工作流"> | **工作流与构建** | 校验多步计划、顺序执行、比较场景快照，并管理 Creator CLI 构建任务。 |
| <img src="docs/assets/shader.svg" width="28" height="28" alt="Shader"> | **Shader 与材质** | Creator 3.8.8 原生 Effect 编译、依赖指纹、哈希守卫编辑、材质实例、宏变体与 RenderTexture 预览。 |

- **本地 MCP 传输**：支持 stdio 与带认证的 Streamable HTTP。
- **可停靠控制中心**：展示工程与编辑器实例、能力、桥接日志和运行时状态，支持桥接启停。面板支持简体中文 / English，默认中文，按工程保存偏好；日志保留原文并支持复制错误。
- **可检查的变更**：`scene.snapshot` 和 `scene.diff` 提供场景基线及递归的 `added`、`removed`、`changed` 路径记录，覆盖节点、组件、属性和数组。
- **可恢复查询的状态**：工作流状态和构建任务索引保存在目标工程 `.codex-work/cache/cocos-mcp/`。服务重启时仍在执行的构建会标记为状态未知失败，避免永久占用工程。
- **操作追踪**：显式 `operationId` 支持进程内幂等复用，通过 `cocos_operation_query` 查询已完成结果；审计日志仅记录操作元信息。
- **源码能力发现**：从 Creator 源码或 ASAR 生成编辑器消息与类型候选目录，或从引擎源码生成 `engine-capabilities.json`。候选能力在单独验证前保持 `source-only`。

版本支持以具体操作为准。调用前检查 `creator2Operations`、`creator3Operations` 与能力验证证据；不支持的版本会在执行前被拒绝。详见[功能介绍](docs/feature-reference.md)与 [Shader 开发指南](docs/shader-development.md)。

## 快速开始

### 1. 安装与构建

准备 **Node.js 24+**、**pnpm 11**（仓库在 `package.json` 中固定具体版本）和一个已有的 Cocos Creator 工程。

```bash
pnpm install
pnpm check
```

`pnpm check` 执行类型检查、构建和测试。项目配置将构建与测试产物统一放在 `.codex-work/` 下。

### 2. 安装编辑器扩展

替换为自己的工程与编辑器路径。以下为 macOS 上 Creator 3.8.8 的示例：

```bash
pnpm start install \
  --project /path/to/my-cocos-project \
  --creator /Applications/Cocos/Creator/3.8.8/CocosCreator.app
```

| 编辑器 | 目标工程中的扩展目录 |
| --- | --- |
| Creator 2.x | `packages/cocos-mcp-creator2/` |
| Creator 3.x | `extensions/cocos-mcp-creator3/` |

安装器会备份已有同名扩展。在 Creator 中打开工程、加载扩展，从编辑器菜单打开 **CocosMCP** 控制中心。MCP 服务自动发现受保护的实例描述文件，并按工程、编辑器版本和实例 ID 路由请求。

### 3. 检查连接并启动 MCP

```bash
# 查看环境、编辑器实例与模块覆盖情况。
pnpm start doctor --project /path/to/my-cocos-project

# 为 MCP 客户端启动 stdio 传输。
pnpm start serve --project /path/to/my-cocos-project

# 或启动本地 Streamable HTTP，自动分配端口。
pnpm start serve --project /path/to/my-cocos-project --transport http --port 0
```

HTTP 仅绑定 `127.0.0.1`，要求 Bearer token，并拒绝非本地 Host/Origin。token 保存在目标工程的 `.codex-work/cache/cocos-mcp/mcp-http-token`。

客户端配置与故障排查见[使用文档](docs/user-guide.md)。

## 规划工作流

向 `cocos_workflow_plan` 传入如下步骤，并将场景 URL 替换为工程中已有的场景：

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

计划阶段校验参数、版本、风险和副作用。计划有效且所需授权已具备后，使用 `cocos_workflow_execute` 执行。默认失败即停，并返回已完成步骤和补偿提示。工作流不提供通用回滚，应根据各项能力的 `rollback` 提示设计补偿步骤。服务重启后可通过 `cocos_workflow_status` 查询已持久化的进度。

## 验证与安全边界

能力的 `verification` 字段表示证据层级：

| 等级 | 证据含义 |
| --- | --- |
| `source-only` | 仅由源码、声明文件或 ASAR 分析发现 |
| `unverified` | 已注册，尚未完成自动化验证 |
| `contract-tested` | 已通过参数与协议契约测试 |
| `adapter-tested` | 已通过模拟编辑器 / 运行时适配器测试 |
| `editor-verified` | 已在真实 Creator 编辑器工程中验证 |
| `runtime-verified` | 已在真实开发运行时验证 |
| `device-verified` | 已在目标设备或平台验证 |

`cocos_coverage` 分别统计 registered、implemented、planned 和 verified 数量。自动化检查覆盖 Schema、路径安全、能力目录和运行时策略。`pnpm check` 通过**不代表** Creator 2.4.15 / 3.8.8 的完整编辑器、真机、平台 SDK 或 GPU 验收通过；这些仍需在对应真实环境中检查。

运行时桥接仅允许回环连接与开发构建。属性路径、方法路径和参数数量经过策略校验，危险宿主入口会被拒绝。项目代码执行和任意编辑器消息调用需要显式启动参数 `--allow-project-code`。

创建资源前先查询 `asset.location` 并复用返回的目录。整理资源时先审查 `asset.organize.plan`，再使用相同参数和 `planHash` 执行；已有资源必须通过 AssetDB 移动以保留元数据。详见[项目资源整理](docs/asset-organization.md)。

## 开发

```bash
# 重新构建服务、扩展与运行时桥接。
pnpm build

# 生成 Creator 编辑器消息与类型候选目录。
pnpm start catalog --project /path/to/project --creator /Applications/Cocos/Creator/3.8.8/CocosCreator.app

# 分析引擎源码并生成 engine-capabilities.json。
pnpm start catalog --project /path/to/project --engine /path/to/cocos-engine
```

构建产物：

```text
.codex-work/build/
├── server/cli.mjs
├── extensions/creator2/
├── extensions/creator3/
└── runtime/
```

## 文档导航

以下详细指南目前使用中文编写。中英文 README 提供一致的项目介绍与安装流程。

| 指南 | 内容 |
| --- | --- |
| [使用文档](docs/user-guide.md) | 安装、启动、客户端配置与调用示例 |
| [功能介绍](docs/feature-reference.md) | 按领域划分的能力与版本限制 |
| [实施与验收指南](docs/implementation-guide.md) | 架构、版本差异、安全与真实环境验收 |
| [场景生产与预览](docs/scene-production.md) | Creator 3.8.8 几何体、阵列、渲染、预览窗口与截图 |
| [Shader 开发指南](docs/shader-development.md) | 原生 Effect 编译、材质与验证边界 |
| [项目资源整理](docs/asset-organization.md) | 目录复用、整理计划与受守卫保护的资源移动 |
| [实施提案](docs/cocos-mcp-proposal.md) · [实施方案](docs/capability-roadmap.md) | 项目范围与分阶段实现规划 |
| [清单说明](docs/capability-verification.md) · [阶段实现说明](docs/roadmap-implementation.md) | 完成度证据、新增能力与示例 |

## 许可证

自有代码采用 **MIT**。Cocos Creator、引擎、Spine、DragonBones、平台 SDK 和其他第三方依赖分别遵循各自许可证。
