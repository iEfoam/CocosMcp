# 路线图阶段实现与使用说明

这是路线图的持续实现记录，**不是整份路线图完成声明**。P0 保持现有实现；P1、P2、P3 部分入口已有代码，P4 已开始图形设备只读查询，P5 已有构建产物检查，设备与交付流程仍未实施。下文原始实现细节以 Creator 3.8.8 为准；后续 2.4.15 已独立适配 UI、资源、动画、预览、媒体和物理等子集，当前范围见 [版本矩阵](version-support.md)，不能继续将整批入口视为 2.x 一律不支持。默认工具列表包含 `cocos_ui_build`；其余通过能力搜索和 `cocos_capability_execute` 调用，或在 all-tools 模式访问。

## 已实现入口

| 范围 | 可调用能力 | 当前边界 |
|---|---|---|
| UI | `ui.plan`、`ui.build`、`ui.diff`、`ui.apply`、`ui.inspect_layout`、`ui.validate_interaction` | 创建新树、最多 200 节点/16 层；已有树按显式映射更新字段；布局/交互为静态检查 |
| 纹理 | `texture.inspect`、`texture.plan_import`、`texture.apply_import`、`texture.restore_import` | 已有 image/texture 的采样、Mipmap、寻址和各向异性；不改压缩或色彩空间 |
| 字体 | `font.inspect` | 字体类型、当前场景引用、位图字体字形表；动态字体覆盖返回 unknown |
| 动画剪辑 | `animation.clip.create`、`animation.clip.inspect`、`animation.clip.sample` | position/scale/eulerAngles、线性/常量曲线；采样不改变节点、不派发事件 |
| 动画编辑 | `animation.clip.read/patch/restore` | 已有 VectorTrack 关键帧；哈希和 UUID 守卫、备份；拒绝外部资源引用 |
| 动画运行 | `runtime.animation.state/play/pause/resume/stop/seek/blend` | 真实 Animation 组件；返回前后状态，帧和事件另行验收 |
| 预览验收 | `preview.resize/input` | MCP 自有窗口尺寸、点击、滚轮和截图；不自动判定业务成功 |
| 物理查询 | `runtime.physics2d.inspect/raycast`、`runtime.physics3d.inspect/raycast` | 世界状态和射线查询；不修改模拟 |
| 媒体 | `runtime.audio.state/play/pause/stop/seek`、`runtime.video.state/play/pause/stop/seek`、`runtime.webview.inspect` | 原生组件控制；WebView 只读；不宣称平台播放验收 |
| 运行时资源 | `runtime.asset.load/preload/inspect/release`、`runtime.bundle.inspect` | 本地完整 UUID；工具引用生命周期；Bundle 只读查询 |

历史批次先增加 29 个入口、再增加 10 个，从 169 增至 179，这是当时数据；2026-09-18 全局目录为 285 个入口，独立服务工具另计，统计口径见版本矩阵。模块仍为 partial；源码测试证据不替代 Creator、GPU、真机和保存重开结果。

## Creator 2.4.15 后续实现

2.4.15 使用 Node 映射 UITransform/UIOpacity、curveData、独立 AssetDB 和材质/Box2D API。已有结构计划、引用守卫、控件真实输入、资源趋势、Tween/骨骼生命周期、Camera 像素及接触清理；完整状态见 [台账](creator2-expansion-tracker.md)。下文 VectorTrack、UI_2D、3D raycast、font.inspect 等细节仍限对应 3.x 实现。

## 声明式 UI

输入格式：

```json
{
  "parentId": "现有 Canvas 或 UI 容器的节点 UUID",
  "document": {
    "version": 1,
    "root": {
      "key": "title",
      "name": "Title",
      "components": [
        { "type": "cc.UITransform", "properties": { "contentSize": { "width": 400, "height": 80 } } },
        { "type": "cc.Label", "properties": { "string": "Hello Cocos", "fontSize": 32 } }
      ]
    }
  }
}
```

先调用 `ui.plan`，然后将原参数与返回的 `planHash` 一起传给 `ui.build`。计划绑定场景指纹、文档、父节点、资源信息和版本，任何变化都需要重读计划。父节点下已有同名根节点时拒绝，不覆盖、不随机改名、不自动重试。

支持 UITransform、Canvas、Sprite、Label、Button、Layout、Widget、ScrollView、Mask、Toggle、EditBox、PageView、RichText；每个类型仅接受 Schema 列出的字段。所有节点自动具有一个 UITransform 和 UI_2D 层。资源用 `{ "assetUuid": "..." }`，同文档节点引用用 `{ "nodeKey": "content" }`。ScrollView 内容必须是后代节点。Canvas 不自动生成 Camera；建议在已有可见 UI 相机和 Canvas 下构建。

Button 的持久化事件格式：

```json
{
  "type": "cc.Button",
  "properties": {
    "clickEvents": [{ "componentId": "当前场景已存在的脚本组件 UUID", "handler": "onClick", "customEventData": "start" }]
  }
}
```

规划时检查目标组件和方法存在；只绑定，不执行项目代码。返回 `rows` 保存 key→nodeId 映射；后续布局/交互工具传返回的 `rootId`。`needsSave` 提示用户显式保存；不会自动保存脏场景。

失败包括 `completed`、`pending` 和 `rollback`。只有当前本批子树与最后确认的序列化快照一致才删除；若第一个原生创建请求结果不确定、用户插入子节点或中间操作改变了未确认状态，保留现场。不要根据失败响应盲目重跑整个 build。

样例见 [menu.json](../examples/ui/menu.json)。其中按钮没有业务事件，静态检查会报告 `NO_PERSISTED_CLICK_HANDLER`；按实际工程组件绑定后再做运行验证。`OUTSIDE_PARENT` 可能是滚动内容的预期行为，必须由 Agent 根据用途判断。

## 纹理导入与恢复

先 `texture.plan_import`：

```json
{
  "url": "db://assets/Textures/panel.png",
  "settings": { "minfilter": "linear", "magfilter": "linear", "mipfilter": "none", "wrapModeS": "clamp-to-edge", "wrapModeT": "clamp-to-edge" }
}
```

多纹理子资源时传 `textureUuid` 精确选择。应用传相同参数加 `planHash`。导入前将元数据备份到当前工程 `.codex-work/cache/texture-backups/`；写入前二次检查，保存/重导入均走 AssetDB，读回验证 UUID 和请求字段。

失败不会盲目恢复：先 `texture.inspect` 查询当前 `expectedHash`，再调用 `texture.restore_import`，传同一 `url`、返回的 `backupId` 和当前哈希。源文件变化、备份资源不一致或过期哈希都会拒绝。恢复读回与备份不一致时报告不确定结果，不宣称恢复成功。源文件上限 64 MiB。

## 动画与字体

`animation.clip.create` 参数为 `url`（`.anim`）、`rootId`（轨道路径相对根节点）、`document`。样例见 [move.json](../examples/animation/move.json)。轨道路径必须逐级唯一，关键帧严格递增且不超过 duration；最多 64 轨道、4000 帧、600 秒。创建使用本机 `cc.AnimationClip`、`cc.animation.VectorTrack`、`TrackPath`、`RealCurve.assignSorted` 和编辑器序列化，写入复用 `asset.create` 的目录策略，不拼私有资源格式。

返回实际资源 URL/UUID，使用该 UUID 调用 inspect/sample。`sample` 的 `time` 返回原生曲线求值，没有动画姿态、循环事件或保存重开验证含义。patch 已提供；暂不提供重定向、事件轨道和动画图。

`font.inspect` 参数为 `uuid` 和可选 `sampleText`。位图字体返回逐字符结果与缺字；空白字符跳过，Unicode 使用 code point。TTF/系统字体不会凭空判断缺字；`glyphCoverage=unknown` 时不能将空 missing 数组理解为全部支持。

## 运行时资源

开发桥连接后，`runtime.asset.load` 接受完整 AssetDB UUID，可选 timeoutMs（100–30000，默认 10000）。成功返回专用 `handle`、阶段 loaded 和 `bound=false`；preload 仅 downloaded-not-parsed，不取得引用。

每次 load 增加一份原生 addRef；release 只对该 handle 执行 decRef(false)。重复加载获得不同句柄，共享资源仍由游戏/引擎管理。断线或切场景失效全部句柄、归还引用并拒绝挂起请求；迟到回调不能重新取得引用。最多 128 个已持有及挂起请求。超时不能保证引擎网络任务立即取消。

不开放任意 URL、远程路径和强制 releaseAsset；引擎缓存是否回收不由这些工具证明。Bundle 查询不提供卸载；加载/卸载需进一步建立场景与依赖引用守卫。

## 验证与继续实施

本批提供 Schema、服务/适配器测试、协议工具列表回归及本地构建。引擎 API 来源已核对本机 Creator 3.8.8 的 UITransform、Button/EventHandler、Texture Inspector、AnimationClip/VectorTrack/TrackPath/RealCurve、BitmapFont 和 Asset 引用计数源码。

没有将新增入口标为 editor-verified/runtime-verified。已知测试工程的登记进程均已退出，本批未启动、安装或重新加载 Creator。Native/GPU 验收仍需可用的测试实例。

待完成的阶段出口：

1. P1：原生创建读回、保存重开 UUID/事件、按钮实际点击、滚动可达、多分辨率、新增控件的完整交互检查与 PageView 页面管理、UI 结构增删改、纹理压缩/颜色空间、字体制作。
2. P2：剪辑事件/重定向、运行控制的真实帧验收、粒子/TileMap/相机灯光、模型完整流程及每方向错误恢复样例。
3. P3：Bundle load/unload、媒体平台验收、物理配置与输入序列/调度专用工作流、真实帧和断线验收。
4. P4：图形后端真实验收、动画图、骨骼插件、Terrain、烘焙、管线/GPU 资源；P5：设备、原生桥、热更新、XR、引擎定制。
5. 横向：能力包权限与依赖管理、版本化文档和迁移查询。

这些未实施工作仍保留在路线图中，没有用泛型调用或空壳工具标为完成。

## 本轮新增接口的使用与恢复边界

### UI 原位更新

`ui.diff` 接受 `rootId`、`document` 和 build 返回的 `mapping: [{key,nodeId}]`。每个文档节点必须显式映射到原子树内的唯一节点。返回字段变更 `rows`、结构限制 `blocked` 和 `planHash`；`ui.apply` 传相同参数及哈希。已有 UUID 与未声明字段保留；不增加、删除或重挂节点/组件。场景版本或子树变化需要重新 diff。

组件引用使用 `{nodeKey, componentType: "cc.Label"}`，引用组件必须在文档声明。Toggle 不开放会派发事件的 isChecked 写入；RichText 禁止内联 click/on 回调，事件必须通过显式事件字段绑定。PageView 当前仅配置，不自动维护页面列表。中途失败仅在子树指纹仍匹配时补偿已确认字段，否则保留现场并返回 pending。

### 剪辑修改

先 `animation.clip.read` 取得 `sourceHash`，再 patch：`{url, expectedHash: sourceHash, patches: [{trackIndex: 0, keys: [...]}]}`。keys 结构与创建文档相同。原生反序列化独立剪辑，仅替换指定三维 VectorTrack 的关键帧；遇到外部 UUID 引用直接拒绝，避免重新序列化丢失依赖。备份保存于测试工程 `.codex-work/cache/animation-backups/`。

restore 传 `{url, expectedHash: 当前 sourceHash, backupId}`；备份绑定资源 URL/UUID。AssetDB 写入后核对 UUID、文件哈希并执行原生查询。写入结果不确定时返回备份标识，必须先重新读取，禁止自动重试。动画运行控制返回 before/after；seek 设置时间，不额外执行 sample 触发重复事件；已派发的游戏事件不可回滚。

### 物理、媒体与预览

2D raycast 传世界坐标 `start/end`，3D 传 `origin/direction`，可设 `maxDistance`；结果立即复制，按距离排序并标明截断。引擎模块不存在时明确拒绝，不将空结果当作无碰撞。查询不主动推进物理帧。

音视频入口传 `componentId`，seek 额外传 `time`，必须已知有效 duration。返回状态不保证浏览器自动播放策略允许实际播放；断线不停止游戏借用的媒体。WebView 不导航、不执行页面代码、不暴露含凭据 URL。

preview.resize 传 width/height（256–2048）；preview.input 传 action=click/wheel 与内容区左上角 DIP 坐标 x/y，滚轮可传 deltaX/deltaY。发送前确认目标场景；会显示并聚焦自有窗口，随后截取绘制帧。该聚焦要求来自 [Electron sendInputEvent](https://www.electronjs.org/docs/latest/api/web-contents)，尺寸使用 [BrowserWindow 内容尺寸接口](https://www.electronjs.org/docs/latest/api/browser-window)。截图与 sent 只证明输入流程，业务回调与滚动可达性需单独断言；失败可能已有副作用，不重发输入。

### 可执行预览验收脚本

构建后运行 `node scripts/project-env.mjs node .codex-work/build/ui-preview-smoke.mjs <仓库内测试工程路径> <fixture.json>`。测试工程必须是当前仓库的子目录，且已打开指定场景的 MCP 预览。脚本不会启动 Creator、切换场景或写入 assets；报告与截图放当前仓库 `.codex-work/logs/ui-preview/`，结束后尝试恢复原内容尺寸。fixture 示例：

```json
{
  "sceneId": "专用测试场景的 UUID",
  "viewports": [
    {"width": 640, "height": 480},
    {"width": 1024, "height": 768, "input": {"action": "click", "x": 512, "y": 384}}
  ]
}
```

包含 input 就会实际点击，必须使用无外部业务副作用的专用测试场景。成功状态是 `capture-passed`，不把截图生成冒充按钮回调、保存重开或布局通过；本轮只完成脚本编译，尚未在原生预览执行。

## 后续优化：UI、粒子、图形设备与断线收敛

- `ui.validate_interaction` 新增 Toggle/checkEvents、EditBox 各事件与 Label 引用、PageView 页面列表/直属 content 关系/重复项、RichText 内联回调提示。失效脚本类 ID 返回诊断而非导致整次查询异常；不调用业务方法，不把无持久化事件当作无行为。
- `runtime.particle2d.state/restart/stop_emitting`：2D restart 对应 resetSystem，会杀死现有粒子再重启；stop_emitting 对应 stopSystem，存活粒子自然结束。autoRemoveOnFinish=true 拒绝修改，避免间接销毁节点。
- `runtime.particle3d.state/play/pause/stop/stop_emitting`：分别调用 ParticleSystem 公共接口。stop 清空和重置模拟；不承诺可恢复粒子轨迹。两种粒子工具都传 componentId、验证真实组件类型，修改要求 active/enabled，返回 before/after 和 frameVerified=false。没有通用暂停 2D 的空壳入口。
- `runtime.graphics.inspect`：查询当前 director.root.device 的后端、厂商、设备能力、Feature 和引擎计数。memory 只表示引擎统计的 Buffer/Texture 分配，driverTotalBytes=null；drawCalls/triangles 未与目标帧同步，不宣称 GPU 帧性能验收。
- `runtime.graphics.formats`：传 `{"formats":["RGBA8","RGBA16F"]}`，最多 64 个不重复的真实 gfx.Format 名称。先验证全部名称，再调用 getFormatFeatures，返回 flags/supportedUsages。不会分配 GPU 对象；UNKNOWN/COUNT/非法名称拒绝。
- 运行时断线现在同时释放受控资源引用、清理 Shader 预览与材质覆盖、取消事件订阅、清空事件和旧句柄。清理异常按 scope 保留在 runtime.query.cleanupErrors，不能因一个模块异常跳过后续清理。借用的游戏节点、粒子和媒体不会因断线被销毁或重置。通用 runtime.create 对象的自动销毁策略仍未覆盖，不宣称所有任意对象已回收。

原生 API 已依据本机 Creator 3.8.8 引擎的 gfx/base/device.ts、gfx/base/define.ts、particle/particle-system.ts、particle-2d/particle-system-2d.ts 及 UI 源码核对。适配器测试使用替身，不是 GPU/编辑器实测。本轮检查的测试工程历史实例 PID 全部已退出，未自动启动或重装 Creator。

阶段状态：P1/P2/P3 均仍为 partial；P4 已有图形设备只读实现，仍为 partial；P5 已有构建产物检查，设备与交付流程仍未实施。粒子配置曲线、真实帧恢复、UI 保存重开、Bundle 卸载守卫、渲染资源创建与设备交付仍需后续实现及验收。

## P5 产物检查与本轮修复

新增独立服务工具 `cocos_build_artifacts`（归属 F47），参数为 projectId、jobId、entryPaths。只接受该工程已成功完成的构建任务，从 `.codex-work/build/creator/<jobId>/` 推导固定输出目录，不信任历史记录中的任意 outputPath。

示例：`{"projectId":"工程ID","jobId":"构建任务UUID","entryPaths":["game/index.html"]}`。入口按实际产物填写；不会猜测 Android/iOS 包路径或架构。返回完整文件 rows（path/bytes/sha256）、入口存在性、totalBytes 与 manifestHash；入口缺失或空文件返回 incomplete。files-verified 只表示文件检查通过，architecture=unverified、installVerified=false、launchVerified=false。

检查限制：最多 10000 个文件、2 GiB 总量、32 层目录；拒绝符号链接、特殊文件、路径穿越和未完成任务。逐文件读前读后核对文件身份、大小和修改标记，再重新扫描目录，检测变化时拒绝结果。它不是构建锁，也不能保证检查结束后产物不再变化；交付前需再次核对清单。不会执行构建产物、安装设备或上传发布。

本轮还修复两项边界：

- UI 持久化 EventHandler 使用节点加组件类型定位，而不是组件 UUID。同节点有多个同类型脚本时，绑定现在在写入前以 AMBIGUOUS_TARGET 拒绝，防止回调误绑。
- 运行时订阅上限为 128（包括清理失败记录）。断线先使回调代际失效；原生 off 抛错时旧回调不再写入事件队列，并保留记录供下次清理重试。on 部分成功后抛错也会尝试补偿，失败回调保持失活，不盲目重订阅。

P5 当前只完成产物文件检查；SDK/设备发现、签名检查、安装启动、热更新、真机与跨平台验收仍未完成。独立服务工具单独计数，不将它伪装为 Creator 场景操作。

## Creator 3.8.8 原生验收记录

已获授权使用 `CocosMcp-UI-Test-3.8.8`：备份并安装扩展、启动编辑器、创建独立测试场景；每次测试结束恢复原场景。本次成功报告位于仓库 `.codex-work/logs/native-roadmap-9a564907-6322-47e7-8586-7dc7f5a79ae3.json`，包含源码指纹、安装构建 ID、逐项结果和截图路径。

已实际通过：ui.plan/build/diff/apply，保存重开后的节点 UUID 与声明属性一致；ui.validate_interaction 调用；目标预览场景连接；800×600 DIP 内容尺寸（Retina 截图为 1600×1200）；graphics.inspect/formats；physics2d/physics3d.inspect。图形后端返回 WEBGL / ANGLE Metal Renderer: Apple M1 Pro；物理查询返回启用状态与重力，不代表碰撞和射线验收。

原生测试发现并修复：

1. Label 原生排版异步更新 UITransform，导致 UI 子树保护误判。现在写操作检查点前用 Label.updateRenderData(true) 完成派生更新；创建时先配置渲染组件，再应用显式 UITransform。没有跳过并发守卫。固定尺寸样例使用 overflow=1（CLAMP）；默认 NONE 会随文本自动改变尺寸。
2. cc 模块命名空间提供 VERSION，旧全局提供 ENGINE_VERSION。运行时版本识别与连接注册统一优先 VERSION，保留旧字段兼容；不再误拒绝实际 3.8.8。

限制：截图中仍有 Cocos 启动页，不能据此声明 UI 视觉正确；没有验证真实点击回调、滚动可达性、粒子画面、音视频进度或物理接触。Xcode devicectl 在恢复服务访问后返回 No devices found；未安装真机、未签名或发布。测试脚本为 `scripts/roadmap-native-smoke.ts`，失败现场和报告保留，不清理无关资产。

## Web 预览诊断优化

新增 preview.logs：独立 error/unhandledrejection 和资源错误监听、结构化原始堆栈、网络失败/HTTP 错误诊断、工程日志持久化及会话游标分页。原生测试发现 Electron 首次导航前 CDP 命令会挂起，已改为先创建 about:blank 目标，再注入下次导航监听，最后加载项目。Creator 3.8.8 受控四类错误测试、分页及持久化均通过；详细参数、保留上限和缺口见 feature-reference.md。此实现仅覆盖 MCP 自有预览，不自动接管独立浏览器。
