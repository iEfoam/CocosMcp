# 按 Creator 版本划分的支持范围

更新日期：2026-09-18。源码基线：`8eba7a5`；本文基于本地能力目录、版本适配器和已有验收报告，不表示 GitHub Release、已安装扩展或正在运行的实例已同步。

## 统计口径

| 范围 | 当前源码登记 | 含义 |
| --- | --- | --- |
| 全局目录 | 285 个能力入口、54 个功能模块 | 入口有处理器不代表完整模块完成；独立服务工具另计 |
| Creator 2.4.15 编辑器 | 最多 112 个入口 | 55 个基础、45 个精确版本场景、9 个受控预览、3 个宿主条件入口；宿主须提供对应 API |
| Creator 2.4.15 运行时 | 99 个显式入口 | 需要连接开发预览，具体模块、组件及原生状态仍须满足条件 |
| Creator 3 | 246 个目录条目包含大版本 3 | 多数新增适配锁定 3.8.8；不是 246 个均已原生验收或当前可用 |

计数来源为 `packages/capability-catalog/src/operations.ts`、`creator2-support.ts` 及 `packages/creator2-adapter/src/index.ts`。2.4.15 的上限为 211 个显式入口；同名跨版本操作不可相加为不同功能。“50/246”是早期环境与目录快照，不是当前 2.4.15 的能力上限。

默认 `tools/list` 只注册常用独立工具；长尾使用 `cocos_capability_search/describe/execute`，或启动 `--all-tools`。查询 `cocos_coverage`、实例暴露列表、前置条件和验证证据后判断可用性，不按客户端显示的工具数量推断引擎覆盖率。

## Creator 2.4.15

| 功能域 | 当前实现 | 已有原生验收范围与边界 |
| --- | --- | --- |
| 编辑器基础 | 场景、节点、组件、Prefab、选择集、Undo/Redo、配置、桥接日志 | 保存重开、Prefab 应用/还原/解绑等基础路径；设置写入并未逐项验收 |
| 资源 | AssetDB CRUD、目录复用、整理计划、依赖/使用者、Texture/SpriteFrame 导入与恢复 | UUID 保留、导入设置恢复；字符串动态加载和二进制依赖不能保证完整扫描 |
| 声明式 UI | `ui.plan/build/diff/apply`；Node 映射 UITransform/UIOpacity；`ui.structure.plan/apply` | 创建/移动/排序/删除及组件变更、单次 Undo/Redo、保存重开、引用删除守卫；Prefab 实例差异待补 |
| 引用审计 | `scene.references`、`asset.references.audit`、事件目标/组件/方法检查 | 当前序列化引用与保存的 fire/prefab/anim/mtl UUID 存在性；注册不等于可加载，历史 null 和字符串路径不作推断 |
| 控件 | `runtime.control.inspect/scroll/page/slider/toggle/text` | ScrollView、PageView、Slider、Toggle、EditBox 真实输入与事件；程序化赋值本身不等于用户输入 |
| 预览与运行时 | 自有窗口、连接、截图、输入、尺寸、日志、对象句柄、事件、暂停恢复、帧采样 | 独立工程 Web 预览；不包含真机、独立浏览器、断点或单步调试 |
| 资源生命周期 | 加载/预加载/释放、Bundle 查询、`runtime.resources.snapshot/diff/trend` | 自有引用增减、连续切场景快照与同实例趋势；加载轨迹及长期泄漏归因待补 |
| 动画与 Tween | curveData 剪辑创建/读取/采样/修改/恢复；动画控制；`runtime.tween.plan/start` | 有界顺序/并行/重复、取消、业务 Action 共存、断连/切场景/销毁；非完整缓动组合或通用 Animation 混合 |
| Spine | 基础播放/皮肤/附件、details、事件 trace、实时 mix inspect/update | 实时/共享/私有缓存边界；实时事件负载、缓存回调恢复、动画对混合时间及生命周期；复杂视觉结果未全面覆盖 |
| DragonBones | 基础播放、details、事件 trace、实时 fade | 三种缓存模式；帧/声音负载、六类淡出规则、业务事件共存与生命周期；声音事件不等于音频播放 |
| TiledMap | 图层/对象组、区域 GID/翻转、运行时 plan/apply | 正交与等距地图、旧计划拒绝及恢复；不写回 TMX/TSX |
| 普通碰撞 | 矩阵/边界、有限帧 trace 与异步 trace_start | Circle/Box/Polygon、允许/禁止组、业务回调共存、取消与断连 |
| Box2D | 查询、刚体 force/impulse、八类关节检查、接触 trace_start | 刚体单位、DistanceJoint 运动约束、Box 四阶段与 sensor、取消/断连/切场景清理；其他七类关节和其他接触形状未逐项原生覆盖 |
| Camera / RenderTexture | 状态、掩码、2D/3D 坐标变换、2D 离屏像素采样 | 透视/正交及局部视口坐标往返；Graphics/Mask 像素、原纹理恢复、自有 GPU 对象删除；3D 模型像素与一般遮挡诊断待补 |
| Shader / 材质 | Effect 源码读写/备份、材质创建/复制/属性/宏/绑定、运行时覆盖恢复 | 连续修改与恢复；不提供 Creator 3 原生编译器、变体编译和等价 gfx 管线状态写入 |
| 媒体与渲染诊断 | Audio/Video 控制、WebView 只读、粒子状态/重启/停止、Graphics/UI/Label/图集诊断 | 基础调用及状态检查；完整媒体体验、粒子编辑、字体缺字渲染、精确合批归因未完成 |
| 编辑器视图 / 构建 | view.query 与部分 view.set；CLI 构建任务 | focus/grid 尚不开放；Web Desktop 实测失败，见下方未完成项 |

长任务使用 `runtime.task.poll/stop`，最多 4 个运行任务、保留 8 个、每任务 30 秒截止；碰撞/骨骼/接触事件限制帧数和事件数并报告 dropped。切场景或断连使旧任务 ID 失效。不同任务的取消并不取消业务监听、Action 或其他任务。

Spine 缓存事件只支持 start/complete/end；DragonBones 缓存只支持 start/loopComplete/complete，缺少负载时明确返回空值。缓存模式不伪造实时姿态/轨道。Box2D 接触点为世界像素，冲量归一到 Box2D 原生单位；零接触点的法线为 null。FrameSession 超时返回 gamePaused/directorPaused/timeoutMs，不自动恢复用户暂停的游戏。

## Creator 3.8.8

| 功能域 | 当前实现 | 验证边界 |
| --- | --- | --- |
| 编辑器与资源 | 场景/节点/组件/Prefab/选择、AssetDB、目录整理、配置/消息、console.query | 按具体入口的报告与原生 API 前置条件判断；任意消息/项目代码需要显式授权 |
| UI / 2D | 声明式 UI、纹理/SpriteFrame、原生动画轨道、UI/Label/图集/合批候选诊断、Tilemap/Spine/物理工具 | 有菜单真实输入、多尺寸截图、导入恢复等记录；真实 Spine/TMX 专项不能借用 2.4.15 的报告 |
| 游戏生产模板 | 13 种可编辑组件、UI 树、角色/摇杆、虚拟列表、镜头/视差、对白、对象池等 | 生成组件类型检查、部分编译挂载与预览；并非所有模板完整玩法均验收；没有 2.x 等价模板交付 |
| Shader / 场景生产 | 原生 Effect 编译、依赖指纹、材质与宏变体、RenderTexture 预览、几何体/阵列/渲染配置 | 有编译/恢复/截图记录；整帧 profile 不是单 Shader GPU 时间或真机性能证明 |
| 引擎扩展 | 路径、调试绘制、排序、探针、动画图、IK、CCT、后处理/蒙皮诊断 | 有路径/保存重开、绘制像素、IK/Rest、Bullet 路线记录；后处理 Pass 不可用和蒙皮递归编译缺陷仍保留 |
| 运行时 / 工作流 | 对象/事件/资源、暂停恢复、媒体、预览输入/日志、性能预算、结果引用与有界等待、构建任务 | 开发 Web 预览与已有记录；平台 SDK、生产、真机及商店交付单独验收 |

2.4.15 专属的 `ui.structure.*`、`scene.references`、`asset.references.audit`、`runtime.control.*`、`runtime.resources.snapshot/diff/trend`、`runtime.tween.*`、`runtime.task.*`、骨骼 details/mix/fade/trace、专属 Camera/关节/接触入口，不因 3.x 功能更多就自动宣称 3.8.8 同名可用。3.x 的原生轨道、UITransform、PhysicsSystem2D 与 2.x API 也不能互换。

## 其他版本与平台

其他 2.x / 3.x 版本可能暴露基础接口，但没有本轮精确版本认证；包声明的 editor 范围不表示全部能力通过。原生记录基于 macOS / Apple Silicon；Windows、Intel Mac、Linux 原生 Creator、移动设备、小游戏和各平台 SDK 未由这些报告统一认证。

菜单统一为“关于 CocosMCP → 打开控制中心 → 检查更新”。关于页展示本地版本/构建/项目资料，更新页用于查询及显式安装；桥接启停在控制中心。桥接运行、MCP 服务运行、游戏运行时已连接是三个独立状态。

## 当前验收与待完成

最近代码回归：249 项自动测试、类型检查和构建通过（2026-09-18，`8eba7a5`）。修改扩展 README 模板也会改变构建源码指纹，重新构建/测试才能得到新指纹下的自动证据；本文引用的原生报告不会因此自动升级成 current-source。

2.4.15 的 16 个领域及后续新增范围仍全部保留，见 [完整验收台账](creator2-expansion-tracker.md)。尚未完成的主要项包括 Prefab 实例差异/修复、加载轨迹、图片字体图集质量、TMX 持久化、其他关节、2.x 模板、材质管线、编辑器 focus/grid、单步/Scheduler、对象池、粒子/MotionStreak 与多分辨率布局专项。现有只读诊断不能代替这些完整工作流。

2.4.15 Web Desktop 构建已有失败证据：`exportSimpleProject` 未定义；安装包 FBX 转换器另报 `spawn Unknown system error -86`。插件构建成功不等于游戏构建成功。未修改 Creator 安装包，未证明这两个环境问题已经修复。

本轮第二轮扩展只在仓库独立工程验收，未同步 Texas。报告与截图位于忽略的 `.codex-work/`，不随 Git 提交：

- [2.4.15 适配及复现](creator2-implementation.md)、[逐项验收台账](creator2-expansion-tracker.md)。
- [3.8.8 2D 交付记录](2d-implementation.md)、[引擎扩展记录](engine-feature-expansion.md)、[Shader 指南](shader-development.md)。
- [验证口径与证据指纹](capability-verification.md)、[完整规划](capability-roadmap.md)。
