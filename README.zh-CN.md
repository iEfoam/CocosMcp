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
  <a href="#让-ai-自动下载安装推荐">AI 自动安装</a> ·
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

截至 2026-10-08，全局目录有 **315 个能力入口、54 个模块**；2.4.15 显式接线最多 **123 个编辑器入口 + 106 个运行时入口**，另有 11 个由应用层组合/处理的入口；3.x 有 **276 个适用条目**。这些不是当前可用数、原生通过数或默认工具列表长度。最近回归 **333 项通过**；本轮仅在两版隔离工程安装和原生验收，未更新正式游戏工程。

**仍未完成**：2.4.15 的其他关节、Prefab 差异/修复、图片字体图集质量、加载轨迹、TMX 持久化、2.x 模板、材质管线、视图 focus/grid、单步/Scheduler 等。2.4.15 游戏构建仍有 `exportSimpleProject` 与 FBX 转换器错误；插件构建通过不代表游戏可成功发布。3.8.8 后处理/蒙皮也有明确限制。

详细功能、证据与缺口见[版本支持矩阵](docs/version-support.md)、[2.4.15 适配记录](docs/creator2-implementation.md)和[完整验收台账](docs/creator2-expansion-tracker.md)。

### 预览优化与自动验收（2026-10-08）

CP-001～013 已实现：完整 runtime 包、场景身份/帧截图、先聚焦再输入、横屏/视图恢复、实际加载摘要、分层就绪、脱敏审计、语义点击、验收配方、夹具清理与生命周期回归。此前源码快照两版各通过 14 项合成原生检查；最新快照自动测试 333 项、Creator 2 原生 14/14 通过，Creator 3 为 12/14，隐藏窗口输入后态未知且配方成功断言未通过，当前源码不能标记两版原生全通过。启动器复用本地凭据及已有登录，不再每轮创建登录环境。

Creator 2 场景加载字节证明仍可为 unknown；外部 Chrome MCP 端到端、真机、GPU 内存和真实匹配/扣费尚未验证。操作示例、复现命令及完整边界见 [预览验收指南](docs/preview-acceptance.md)。

## 核心能力

- **本地 MCP 传输**：支持 stdio 与带认证的 Streamable HTTP。
- **可停靠控制中心**：展示工程与编辑器实例、能力、桥接日志和运行时状态，支持桥接启停。面板支持简体中文 / English，默认中文，按工程保存偏好；日志保留原文并支持复制错误。
- **可检查的变更**：`scene.snapshot` 和 `scene.diff` 提供场景基线及递归的 `added`、`removed`、`changed` 路径记录，覆盖节点、组件、属性和数组。
- **可恢复查询的状态**：工作流状态和构建任务索引保存在目标工程 `.codex-work/cache/cocos-mcp/`。服务重启时仍在执行的构建会标记为状态未知失败，避免永久占用工程。
- **操作追踪**：显式 `operationId` 支持进程内幂等复用，通过 `cocos_operation_query` 查询已完成结果；审计日志仅记录操作元信息。
- **源码能力发现**：从 Creator 源码或 ASAR 生成编辑器消息与类型候选目录，或从引擎源码生成 `engine-capabilities.json`。候选能力在单独验证前保持 `source-only`。

版本支持以具体操作为准。调用前检查 `creator2Operations`、`creator3Operations` 与能力验证证据；不支持的版本会在执行前被拒绝。详见[功能介绍](docs/feature-reference.md)与 [Shader 开发指南](docs/shader-development.md)。

## 下载与离线安装

### 让 AI 自动下载安装（推荐）

把下面提示词直接发给**具备联网、本机文件、终端和桌面操作能力的 AI 助手**即可，无需提前下载文件、查找路径或手动填写配置。AI 会从当前工作区和本机环境识别安装目标，完成下载、安装、启动与连接验证。这种方式需要联网；已有 ZIP 的手动离线安装步骤在后面。

<details>
<summary>展开并复制：让 AI 全程下载安装 CocosMCP</summary>

```text
请直接帮我从 GitHub 下载并安装 CocosMCP，让当前 AI 客户端连接我的 Cocos Creator 工程。
仓库：https://github.com/iEfoam/CocosMcp
发布页：https://github.com/iEfoam/CocosMcp/releases

以方便为先，请自己完成环境识别、下载、安装、配置、启动和验证，
不要让我下载文件、填写路径、复制 token、执行命令或按教程逐步点击。
请使用已有工具实际操作，不要只给我安装步骤。

1. 从当前工作区、已打开的 Creator 工程和客户端上下文识别目标工程、
   Creator 精确版本/路径、操作系统/架构、当前 AI 客户端及其 MCP 配置位置。
   优先当前工程，不批量修改其他工程。仅在目标确实存在无法判断的歧义时简短询问。
2. 查询仓库 GitHub Releases（需要时使用 API 并翻页），不要猜测下载地址。
   优先具有完整安装产物的稳定版；没有可用稳定版时选择最新完整开发预发布版并报告。
   从同一个 Release 下载对应 Creator 主版本的 ZIP、SHA256SUMS 和 release-manifest.json，
   保存到工程 .codex-work/downloads/，核验哈希、版本和包内身份；失败时不要安装。
3. 自动查找并验证独立的 Node.js 24+。如缺失，按本机操作系统和架构从 Node.js 官方
   下载当前 24.x LTS 的可用发行包并校验，优先解压到工程 .codex-work/ 下供插件使用，
   避免改动系统 Node 或要求我手动安装；需要系统授权时才请求必要授权。
4. 保留已有 .gitignore 规则并忽略 .codex-work/；暂存和解压仅使用工程内目录，拒绝越界路径。
   自动停止此扩展拥有的 MCP 服务、卸载/重载目标扩展；不强制关闭有未保存内容的编辑器。
   将旧扩展备份到 .codex-work/build/extension-backups/，然后安装 ZIP：
   Creator 2 → packages/cocos-mcp-creator2/，包名必须为 cocos-mcp-creator2；
   Creator 3 → extensions/cocos-mcp-creator3/，包名必须为 cocos-mcp-creator3。
   package.json 应直接位于扩展根目录；不改游戏资源、场景、脚本或其他扩展。
5. 自动写入扩展根目录 service-config.json，将 nodeExecutable 设为验证过的 Node 绝对路径。
   使用发布包内的服务程序，不克隆源码或安装 npm/pnpm 依赖。
6. 使用可用的桌面/编辑器工具打开目标工程、加载扩展，并从 CocosMCP 控制中心启动 MCP 服务。
   自动读取真实 HTTP 地址和本机 Bearer token，备份并合并当前 AI 客户端的 Streamable HTTP MCP 配置；
   保留其他连接，不把 token 输出到对话或提交到 Git，不猜测端口或客户端配置格式。
   根据客户端实际支持的方式自动重载连接，优先使用工程级配置。
7. 实际调用 cocos_projects 和 cocos_instances，确认目标工程和编辑器实例已连接。
   最后只汇报安装版本、工程、验证结果和备份位置。
   若工具权限、客户端能力或未保存内容使某一步无法自动完成，先完成独立步骤，
   只报告具体阻碍及最小必要授权，不把整套安装工作交回给我，也不要声称未验证的连接已成功。
```

</details>

### 手动下载与离线安装

已有构建产物时，无需克隆源码、安装 pnpm 或重新编译。从 [GitHub Releases](https://github.com/iEfoam/CocosMcp/releases) 选择一个版本，在 **Assets** 中下载对应 ZIP 和同版本的 `SHA256SUMS`；也可以把这些文件复制到离线电脑。标记 **Pre-release** 的是开发版，手动选择后安装，不会通过稳定版在线更新自动获取。

| 发布产物 | 用途 |
| --- | --- |
| `cocos-mcp-creator2.zip` / `cocos-mcp-creator3.zip` | **手动安装选择 ZIP**，分别用于 Creator 2 / 3 |
| `SHA256SUMS` / `release-manifest.json` | 文件哈希校验；版本、构建标识和源码指纹核对 |
| `*.full.json` / `cocos-mcp-creator{2,3}.json` | 在线更新完整包 / 必需运行文件包；Creator 2 旧七文件更新器需先整包升级，不是编辑器直接安装包 |
| GitHub 自动附加的 `Source code` | 仓库源码，需要按下方“快速开始”自行构建 |

### 手动安装 ZIP

1. 本机先准备好对应版本的 **Cocos Creator 和 Node.js 24+**。当前适配基线为 2.4.15 / 3.8.8；不要将两个主版本的包混装到同一工程。
2. 用本机 SHA-256 工具核对 ZIP 与同版本 `SHA256SUMS` 中的对应行，例如 macOS/Linux 的 `shasum -a 256 <ZIP路径>` 或 PowerShell 的 `Get-FileHash <ZIP路径> -Algorithm SHA256`。升级前停止此工程的 MCP 服务并关闭 Creator，将旧扩展备份到工程 `.codex-work/build/extension-backups/`。
3. 将 ZIP 内容解压到下表对应目录。**`package.json` 必须直接位于该目录内**，不能多套一层解压文件夹；不要把扩展放进 `assets/`。

| Creator | 工程内安装目录 |
| --- | --- |
| 2.x | `<工程>/packages/cocos-mcp-creator2/` |
| 3.x | `<工程>/extensions/cocos-mcp-creator3/` |

4. 在扩展目录内、与 `package.json` 同级，新建 `service-config.json`。先运行 `node --version` 确认版本，再用 `node -p "process.execPath"` 获取本机 Node 绝对路径，填入以下配置（Windows 路径中的反斜杠须按 JSON 转义）：

```json
{
  "nodeExecutable": "/absolute/path/to/node"
}
```

发布 ZIP 特意不携带这份机器相关配置；这里需要独立安装的 Node.js 24+，不能直接使用 Creator 内置的 Node。离线 ZIP 方式不需要填写源码 `buildRoot`。

5. 打开工程，在扩展管理器确认扩展已加载，然后选择 **CocosMCP → 打开控制中心 → 启动 MCP 服务**。启动会同时连接编辑器桥接；游戏预览和运行时接入仍需另行开启。
6. 在控制中心选择接入方式并复制配置（通用 JSON 模板，按客户端格式调整）：
   - **本机 stdio（推荐）**：客户端通过 Node.js 启动扩展内的 `dist/stdio.mjs`，无需配置 MCP 端口，也无需源码仓库或 pnpm。先停止同工程已有 HTTP 服务。
   - **Streamable HTTP**：先从面板启动服务。首次分配端口后保存并在重启时复用；端口被占用会明确报错，不会自动切换。配置中的 Bearer token 来自工程 `.codex-work/cache/cocos-mcp/mcp-http-token`，含凭证的配置请妥善保管。
   面板识别客户端管理的服务，只显示状态；多个客户端可共享 HTTP 服务。连接后调用 `cocos_projects` 和 `cocos_instances` 验证工程与编辑器实例。

此处“离线”指插件安装不需要联网下载依赖，不代表 AI 模型一定能离线运行。断网时可忽略在线更新检查失败；离线包也包含 stdio 入口；客户端是否在 HTTP 服务恢复后自动重连需单独验证。恢复旧版时先停止服务、关闭 Creator，再用备份替换本次扩展目录。

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

# 或启动本地 Streamable HTTP，首次分配端口，后续复用。
pnpm start serve --project /path/to/my-cocos-project --transport http
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
| [预览验收指南](docs/preview-acceptance.md) · [可靠性说明](docs/mcp-reliability-and-performance.md) · [外部连接器](docs/external-preview.md) | CP-001～013、登录复用、真实输入、配方/夹具、刷新证明与复现 |
| [实施提案](docs/cocos-mcp-proposal.md) · [实施方案](docs/capability-roadmap.md) | 项目范围与分阶段实现规划 |
| [清单说明](docs/capability-verification.md) · [阶段实现说明](docs/roadmap-implementation.md) | 完成度证据、新增能力与示例 |

## 许可证

自有代码采用 **MIT**。Cocos Creator、引擎、Spine、DragonBones、平台 SDK 和其他第三方依赖分别遵循各自许可证。
