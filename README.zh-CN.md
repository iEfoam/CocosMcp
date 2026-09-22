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
  <a href="#按-creator-版本支持的功能">版本支持</a> ·
  <a href="#mcp-功能速览">功能速览</a> ·
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

Creator 2.4.15 的新增适配、独立测试工程、原生覆盖结果和未完成项见 [适配与验收记录](docs/creator2-implementation.md)。

## MCP 功能速览

按已实现的 MCP 入口归纳功能，具体支持版本、前置条件和验证等级见下方版本表及[功能介绍](docs/feature-reference.md)。

| 编辑器与资源 | 运行时与交互 | 工作流与诊断 |
| --- | --- | --- |
| **场景管理**<br>创建、打开、保存、场景树 | **对象检查**<br>节点树、属性读写、对象句柄 | **工程与实例**<br>工程列表、编辑器与运行实例 |
| **节点编辑**<br>创建、复制、移动、删除、变换 | **运行控制**<br>暂停、恢复、运行状态 | **能力发现**<br>搜索、参数说明、版本与覆盖查询 |
| **组件编辑**<br>类型查询、添加、配置、重置 | **控件与输入**<br>控件操作、鼠标、键盘、触摸 | **工作流编排**<br>计划校验、顺序执行、结果引用 |
| **资源操作**<br>查询、导入、保存、移动、UUID 转换 | **动画与动作**<br>播放控制、轨道采样、Tween（2.x） | **预览与截图**<br>启停预览、画面截图、多尺寸检查 |
| **资源整理**<br>目录定位、整理预览、按计划搬移 | **骨骼动画**<br>Spine 播放与皮肤、DragonBones（2.x） | **日志诊断**<br>桥接日志、预览日志、控制台（3.x） |
| **预制体**<br>创建、实例化、应用修改、还原 | **地图与物理**<br>瓦片查询与修改、射线与接触查询 | **性能采样**<br>帧时间、P99、帧预算、渲染指标 |
| **UI 搭建**<br>声明式创建、更新、布局与事件检查 | **相机与渲染**<br>坐标转换、可见性、渲染诊断 | **构建任务**<br>启动、状态、日志、列表、取消 |
| **材质与 Shader**<br>属性、宏、源码备份、原生编译（3.x） | **媒体与粒子**<br>音视频播放、粒子状态与基础控制 | **产物核对**<br>构建文件列表、大小、哈希校验 |
| **动画与模板**<br>剪辑编辑、关键帧、组件模板（3.x） | **运行时资源**<br>加载、预加载、引用释放、Bundle 查询 | **状态恢复查询**<br>操作结果、工作流进度、构建任务记录 |
| **场景与引用检查**<br>快照差异、缺失组件、资源依赖 | **事件与任务**<br>事件订阅、有界采样、任务查询与取消 | **视觉与布局检查**<br>UI 几何、越界检查、Shader 预览比较 |

通过 `cocos_capability_search` / `cocos_capability_describe` 查找具体入口，再由 `cocos_capability_execute` 调用；工作流与构建等功能另有专用 MCP 工具。

## 按 Creator 版本支持的功能

当前精确适配基线为 **Creator 2.4.15** 和 **Creator 3.8.8**。下表列出已实现的能力范围；“有原生记录”仅代表对应场景和参数得到验证，不表示整类功能、所有平台或整个引擎已完成验收。其他 2.x / 3.x 版本不自动继承支持。

| 功能 | Creator 2.4.15 | Creator 3.8.8 |
| --- | --- | --- |
| 编辑器与资源 | 场景、节点、组件、Prefab、Undo/Redo、AssetDB、目录整理、依赖/使用者 | 同类基础编辑；另有原生控制台读取、版本匹配的编辑器消息 |
| UI 与引用 | 声明式创建/更新、结构计划/应用、场景及保存文件引用审计、删除守卫 | 声明式创建/更新、布局/事件检查；2.x 专属结构与引用入口不自动通用 |
| 控件与预览 | 五类控件语义操作；真实拖动/点击/输入事件；窗口、截图、日志、尺寸 | 窗口、截图、日志、鼠标/键盘/触摸、多尺寸检查；已有菜单交互记录 |
| 动画与动作 | curveData 编辑恢复；有界 Tween 顺序/并行/重复、取消与生命周期 | 原生轨道及动画控制、动画图观测；不包含 2.x 专属 Tween 任务入口 |
| 骨骼 | Spine / DragonBones 结构、缓存边界、事件任务、实时混合与清理，有原生记录 | Spine 播放/队列/皮肤/附件、轨道采样；不继承 2.x 的缓存/事件/混合专项结论 |
| 2D 地图与物理 | 正交/等距 Tilemap；普通碰撞、刚体施力、关节检查、Box 接触与清理 | Tilemap、物理查询/接触工具；按实际后端验证，3D CCT 有独立路线记录 |
| 相机与渲染 | 2D/3D 坐标、掩码、2D Graphics/Mask 离屏像素及自有 GPU 对象删除 | 几何体/阵列/渲染设置、Shader RenderTexture 预览、调试绘制/排序/探针/IK |
| Shader 与材质 | Effect 源码/备份、材质属性/宏、运行时覆盖恢复；不含 3.x 编译器 | 原生 Effect 编译、依赖指纹、材质实例、宏变体和预览比较 |
| 资源生命周期 | 加载/释放、Bundle 查询、快照/差异/连续切场景趋势 | 加载/释放、Bundle 查询；不宣称同名 2.x 快照/趋势入口可用 |
| 游戏组件模板 | 2.x 模板尚未交付 | 13 种可编辑模板：控制器、镜头、虚拟列表、对白、对象池等；完整玩法未逐项验收 |
| 媒体与诊断 | 音视频、粒子基础控制，UI/Label/图集/Graphics 诊断 | 音视频、粒子及性能/渲染诊断；平台体验和 GPU 性能需独立验证 |
| 工作流与构建 | 本地工作流、CLI 任务；游戏构建存在已记录环境失败 | 本地工作流、CLI 任务与产物检查；签名、真机、SDK 和发布单独验收 |

截至 2026-09-18，2.4.15 显式登记最多 **112 个编辑器入口 + 99 个运行时入口**；3.x 在目录中有 **246 个版本适用条目**。这些是接线/目录计数，不是当前可用数或原生通过数，也不是默认 MCP 工具列表长度。最近代码回归 **249 项通过**；本轮原生扩展在独立 2.4.15 工程验收，尚未同步 Texas。

**仍未完成**：2.4.15 的其他关节、Prefab 差异/修复、图片字体图集质量、加载轨迹、TMX 持久化、2.x 模板、材质管线、视图 focus/grid、单步/Scheduler 等。2.4.15 游戏构建仍有 `exportSimpleProject` 与 FBX 转换器错误；插件构建通过不代表游戏可成功发布。3.8.8 后处理/蒙皮也有明确限制。

详细功能、证据与缺口见[版本支持矩阵](docs/version-support.md)、[2.4.15 适配记录](docs/creator2-implementation.md)和[完整验收台账](docs/creator2-expansion-tracker.md)。

## 核心能力

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

`pnpm check` 按类型检查 → 构建 → 测试 → 构建执行，末次构建嵌入匹配源码的测试证据。项目配置将构建与测试产物统一放在 `.codex-work/` 下。

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

安装器会备份已有同名扩展。在 Creator 中打开工程、加载扩展，通过 **CocosMCP → 打开控制中心** 进入。菜单顺序为 **关于 CocosMCP → 打开控制中心 → 检查更新**，关于和更新有对应页面，桥接启停保留在控制中心内。MCP 服务自动发现受保护的实例描述文件，并按工程、编辑器版本和实例 ID 路由请求。

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

向 `cocos_workflow_plan` 传入如下步骤，并将场景 URL 替换为工程中已有的场景（Creator 3 使用 `.scene`，Creator 2 使用 `.fire`）：

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

步骤支持 `paramRefs` 引用之前的结果、`runtimeRef` 绑定预览运行实例，以及只读 `waitFor` 就绪等待。同一工作流 ID 不可重复执行。帧超时附带游戏/Director 暂停状态，不自动恢复游戏。详见[预览可靠性与性能工作流](docs/mcp-reliability-and-performance.md)。

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

以下详细指南目前使用中文编写。中英文 README 提供一致的版本支持与安装流程。`.codex-work/` 原生报告受 Git 忽略，不随仓库分发；文档提供复现脚本和验证边界。

| 指南 | 内容 |
| --- | --- |
| [版本支持矩阵](docs/version-support.md) · [Creator 2 验收台账](docs/creator2-expansion-tracker.md) | 精确版本功能、原生证据和未完成范围 |
| [使用文档](docs/user-guide.md) | 安装、启动、客户端配置与调用示例 |
| [功能介绍](docs/feature-reference.md) | 按领域划分的能力与版本限制 |
| [2D 开发指南](docs/2d-development.md) · [交付与验证记录](docs/2d-implementation.md) | Creator 3.8.8 SpriteFrame、动画、UI、物理、Spine、Tilemap 与 13 种可编辑玩法模板 |
| [实施与验收指南](docs/implementation-guide.md) | 架构、版本差异、安全与真实环境验收 |
| [场景生产与预览](docs/scene-production.md) | Creator 3.8.8 几何体、阵列、渲染、预览窗口与截图 |
| [Shader 开发指南](docs/shader-development.md) | 原生 Effect 编译、材质与验证边界 |
| [项目资源整理](docs/asset-organization.md) | 目录复用、整理计划与受守卫保护的资源移动 |
| [实施提案](docs/cocos-mcp-proposal.md) · [实施方案](docs/capability-roadmap.md) | 项目范围与分阶段实现规划 |
| [清单说明](docs/capability-verification.md) · [阶段实现说明](docs/roadmap-implementation.md) | 完成度证据、新增能力与示例 |

## 许可证

自有代码采用 **MIT**。Cocos Creator、引擎、Spine、DragonBones、平台 SDK 和其他第三方依赖分别遵循各自许可证。
