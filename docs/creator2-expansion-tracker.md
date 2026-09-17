# Creator 2.4.15 第二轮实施验收清单

目标：实施并验收完整扩展方案。状态只根据当前源码、测试和原生结果推进；不以新增入口数或单元测试替代完整验收。

| 编号 | 范围 | 状态 | 完成证据要求 |
| --- | --- | --- | --- |
| 01 | UI 结构编辑 | 结构核心、直接引用及事件组件依赖删除守卫原生通过 | 增删、层级、顺序、组件、单次 Undo、保存重开、冲突已测；节点/组件及事件处理组件引用已联动；复杂 Prefab 引用差异仍待审计 |
| 02 | 控件操作与交互 | 五类控件核心操作与原生输入验收通过 | ScrollView/PageView/Slider/Toggle/EditBox 状态、真实输入、对应事件及恢复通过；Toggle 禁用/遮挡、取消订阅清理通过 |
| 03 | 场景与 Prefab 审计 | 当前场景显式引用扫描与删除守卫已通过；完整审计待补 | 实例差异、断引、事件、重复组件、带计划修复 |
| 04 | Bundle 与资源生命周期 | 缓存快照、直接依赖、引用差异及连续切场景趋势原生通过；加载轨迹待补 | 依赖、加载轨迹、切场景快照与驻留趋势 |
| 05 | 图片字体图集质量 | 待实施 | 尺寸重复、内存估算、合图、溢出/缺字渲染证据 |
| 06 | TiledMap | 运行时核心及双地图原生验证通过 | 图层对象、区域 GID/翻转、计划应用、正交等距夹具已覆盖；TMX 源文件持久化未实现 |
| 07 | 普通碰撞 | Circle/Box/Polygon、矩阵允许/禁止及业务回调共存原生通过 | 分组矩阵、包围盒、事件且不覆盖业务监听 |
| 08 | 刚体与关节 | 刚体及 DistanceJoint 约束原生通过；其余关节/接触待补 | 类型、施力冲量、接触、锚点与连接、单位 |
| 09 | Tween/Action | 编排、采样、取消、业务 Action 共存及核心生命周期原生通过 | 声明编排、帧采样、所有权与清理 |
| 10 | 骨骼深入诊断 | Spine/DragonBones 结构、缓存边界、混合状态、原生事件及断连/切场景核心验收通过；复杂视觉边界待补 | Spine/DragonBones 骨骼插槽轨道、缓存模式、事件边界 |
| 11 | Camera/RenderTexture | 2D 状态、坐标、掩码、Graphics/Mask 离屏像素与临时对象删除原生通过；多视口等待补 | 坐标、可见性、离屏像素与临时资源释放 |
| 12 | 2.x 游戏组件模板 | 待实施 | 对象池、虚拟列表、跟随、视差、巡逻、对白、UI；编译挂载预览 |
| 13 | 材质管线状态 | 待探针验证 | 2.x 独立状态模型，序列化重导入恢复 |
| 14 | 编辑器视图接口 | 待探针验证 | focus/缩放/grid/Gizmo 原生签名与读回 |
| 15 | 单步执行 | 待探针验证 | 暂停、帧推进、Scheduler/动画/物理时序 |
| 16 | 构建及发布诊断 | 待定位 | exportSimpleProject 与 FBX 环境错误分别定位；真实构建产物 |

当前任务保留上述全部范围。单个探针失败不阻断其他独立项；环境问题只在有复现证据后记录为阻碍。

## 当前证据

- `ui.structure.plan/apply`：2.4.15 专用；批量创建/移动/排序/删除节点，添加/删除组件，保留已有节点 UUID。
- `scripts/creator2-structure-native.ts`：独立工程验证单次 Undo/Redo、保存重开、兄弟顺序、无关节点、删除持久化、过期计划、循环层级、越界根及非法索引。
- 原生报告：`.codex-work/logs/creator2-expansion/ui-structure.json`。
- 完整回归 198 项通过：`.codex-work/logs/creator2-expansion-regression.log`；TypeScript 检查通过。
- 修复 `CocosError.from` 跨 Electron IPC 丢失错误码、详情和消息的问题，保留部分执行上下文。
- 尚未将本轮新增结构功能同步到 Texas；仍在独立工程逐项验收。
- `runtime.tilemap.inspect/query_region/plan/apply` 已接入 2.4.15：地图尺寸/方向/对象组（对象数量有上限）、区域 GID/翻转位/坐标，计划守卫和部分结果报告。
- `scripts/creator2-tilemap-native.ts` 在官方正交 map.tmx 与等距 iso-test.tmx 上验证零坐标、水平翻转、过期计划拒绝、恢复读回；报告 `.codex-work/logs/creator2-expansion/tilemap.json`。
- 修复 2.4.15 瓦片数字坐标 x=0 被原生误判的问题，统一使用 Vec2 重载；运行时网关保留有效协议错误码，未知错误仍归类 RUNTIME_ERROR。

- 新增 `runtime.control.inspect/scroll/page/slider/toggle/text`，隔离在 runtime2 controls 模块；保留 Toggle 分组约束和 EditBox 原生截断，明确区分程序化操作与真实输入。
- 控件单测覆盖分组拒绝、禁用状态、类型不匹配、NaN/Infinity/越界在写入前拒绝；尚未完成原生控件及真实事件/遮挡验收。

- `scripts/creator2-controls-native.ts` 使用独立 `Creator2Controls.fire` 场景：五类控件原生状态读回、文本截断、分页越界、恢复通过；Toggle 真实点击一次事件、禁用/遮挡零事件、移除遮挡恢复点击通过。报告 `.codex-work/logs/creator2-expansion/controls.json`。
- 初次点击验收暴露复用累积场景中多 Canvas 干扰；测试已隔离到专用场景。ScrollView 拖动、PageView 滑动、Slider 拖动、EditBox 键盘及对应事件仍待验收。

- Slider 已补齐原生必需 handle（Button）夹具，真实拖动后 progress 与 slide 事件验证通过；仅设置 progress 的结果不视为输入通过。当前剩余输入覆盖：ScrollView 拖动、PageView 滑动、EditBox 键盘及相关事件。

- 本轮原生验收补齐 ScrollView 拖动/scrolling、PageView 翻页/page-turning、EditBox 真实键盘/text-changed；取消订阅后继续输入有文本变化且无新增订阅记录，所有控件恢复并关闭预览。
- 修复共享预览输入的 keyDown/keyUp 缺少 char 事件：字母、数字、空格发送字符，导航键不发送字符。EditBox 焦点由原生 isFocused 读回证明，未通过修改 string 代替键盘输入。194 项回归、类型检查及构建通过；Creator 3 共享输入行为只有自动测试证据，本轮原生证明限于 2.4.15。
- PageView 测试补齐横向 Layout、内容高度与视口一致；独立测试场景不依赖累积场景中的其他 Canvas。

## 后续方案新增范围（保持纳入完整目标）

- 长任务会话：碰撞已接入可取消 trace_start/task.poll/task.stop，并原生验证后续命令可执行；其余长采样入口待逐项接入。帧数、事件数、超时和场景代际统一约束。
- 临时资源所有权：节点、观察组件、Tween、池、纹理及引用统一记录；正常结束、断连与切场景清理，清理失败可见。
- 能力状态展示：已接线、自动测试、2.4.15 原生验证与当前可用性分别统计，不能混为入口总数。
- 粒子、Graphics、MotionStreak：参数计划恢复、受限绘图及真实帧效果验证，包含持久化和清理。
- 对象池托管与诊断：MCP 所有权、借还、重复归还、reuse/unuse、销毁清理；业务池仅对已注册对象诊断。
- 事件绑定审计与交互追踪：静态绑定审计并入 03，原生输入/事件基础已在 02 验证，最终接收路径诊断仍待补。
- 调度和生命周期诊断：指定对象的调度、暂停、切场景残留及生命周期顺序；与 15 单步验证结合。
- 布局多分辨率诊断：Widget/Layout/SafeArea，等待布局完成后检查裁剪、冲突、安全区和截图；尚未完成。

- `scene.references` 使用 Editor 原生序列化对象表扫描节点/组件/资源引用，返回来源对象和属性路径；不执行脚本 getter。越界引用显式报告，扫描深度/数量超限直接拒绝，不把截断当无引用。
- UI 结构删除扫描整个当前场景，包括 rootId 子树外的引用所有者；plan 返回 blockers，apply 在写入前拒绝存在存活来源的节点/组件引用，解除引用会令旧计划失效。
- `scripts/creator2-references-native.ts` 原生验证 ScrollView.content 节点引用与 Slider.handle 组件引用，冲突无删除、显式解除后新计划可执行、Undo 恢复节点与组件 UUID。报告 `.codex-work/logs/creator2-expansion/references.json`；兼容别名字段逐路径保留。
- 仍未覆盖资源 UUID 的 AssetDB 存在性、事件目标组件/方法依赖、已变为 null 的历史断引、Prefab 实例差异及计划修复，不能将当前场景显式引用扫描称为完整引用安全。

- 事件审计识别原生 cc.ClickEvent，优先解析 _componentId，兼容旧 component 名称；报告缺失目标、缺失类型/组件、重复组件歧义、缺失方法和无法安全读取的 accessor。审计不调用 emit、getter 或业务 handler。
- 事件处理组件作为 event-component 依赖加入 ui.structure 删除计划，即使目标节点未删除也会阻止删除仍被引用的组件。ui.validate_interaction 复用同一实现，避免仅按旧 component 名称判断导致误报。
- 原生引用验收新增：事件绑定后删除组件被拒绝，明确解绑后执行、Undo 恢复；将处理方法改成不存在的方法可检出 EVENT_HANDLER_MISSING，交互检查 valid=false。198 项测试、类型检查及构建通过。完整资源存在性、Prefab 差异和审计修复计划仍待实施。

- `scene.references` 现已调用 AssetDB.assetInfoByUuid 核对已提取资源；新增 `asset.references.audit` 检查保存的 .fire/.prefab/.anim/.mtl 源文件 UUID，独立标记 saved-serialized-source 与 unsavedSceneIncluded=false，避免把加载后 null 误当无断引。
- 资源查询按规范化 UUID 去重，支持压缩 UUID；区分 registered/missing/query-failed，桥接错误不归类缺失资源，查询失败使完整性为 false。AssetDB 注册不代表可加载或可渲染。
- `scripts/creator2-asset-references-native.ts` 验证有效 SpriteFrame 子资源、保存文件中的缺失 UUID，以及通过 AssetDB 显式修正后的无缺失结果；报告 `.codex-work/logs/creator2-expansion/asset-references.json`。内置资源和其他子资源格式尚未逐类原生覆盖。

- 新增 `runtime.rigidbody2d.inspect/force/impulse`，独立 runtime2 模块，明确世界像素坐标和 Creator 2 原生力/冲量单位，不重复做 PTM_RATIO 换算；非动态、未初始化、未启用、非法坐标在副作用前拒绝。
- `scripts/creator2-rigid-body-native.ts` 在独立工程验证原生质量/质心与刚体就绪，冲量速度增量与 impulse/mass 一致，施力后实际帧速度增长、静态刚体拒绝，最后停用自有刚体并关闭预览。报告 `.codex-work/logs/creator2-expansion/rigid-body.json`。
- 验收脚本从原生预览层级重新解析组件 ID，不假定编辑态和运行态组件身份一致。轨迹截图、关节、接触事件仍未完成。

- 新增 `runtime.joint2d.inspect`：连接刚体、局部/世界锚点、原生就绪状态与类型配置；未初始化返回 null 世界锚点并列出原因，不重建关节。
- 2.4.15 原生 Joint.getWorldAnchor 包装器漏传随包 Box2D.GetAnchorA 必需 out 参数；适配层直接读原生约束，显式传出参并乘一次 PTM_RATIO，已有单测覆盖。
- `scripts/creator2-joint-native.ts` 原生验证 DistanceJoint 两端身份、100px 距离约束在冲量后运动中保持、禁用后锚点 null；报告 `.codex-work/logs/creator2-expansion/joint.json`。其他七类关节只已接入检查路径，尚未逐类原生验收；接触追踪仍待补。

- 新增 `runtime.collision2d.inspect/trace`：矩阵、分组、普通碰撞器缓存世界边界；有限帧采样通过自有临时组件接收原生回调，不替换业务方法或碰撞管理器。事件有数量限额和 dropped；finally 停止记录、销毁观察组件、注销临时类型，清理失败返回 OUTCOME_UNKNOWN。
- `scripts/creator2-collision-native.ts` 用原生动画驱动 Circle/Box 分离→重叠→分离，验证 enter/stay/exit 和追踪前后组件数量一致。报告 `.codex-work/logs/creator2-expansion/collision.json`；回调按接收者记录，成对回调不去重。
- 原生运行时轮询串行执行，采样期间后续 MCP 移动命令不会执行；夹具改用原生动画，未改变命令调度架构。多边形、非默认碰撞组及已有业务碰撞回调并行场景仍待原生补验。

- `scripts/creator2-collision-expanded-native.ts` 通过 AssetDB 在复用 Scripts 目录创建业务回调夹具，验证 Circle/Polygon 精确世界 AABB/半径、非默认 groupIndex=1、矩阵允许/禁止组合、追踪期间业务 enter/stay/exit 计数及追踪结束后继续回调。追踪前后组件数量一致，原始运行时分组/矩阵恢复，测试根停用，预览关闭。
- 扩展碰撞报告 `.codex-work/logs/creator2-expansion/collision-expanded.json` 最终 passed=true。期间两次渲染帧采样超时；预览被 finally 关闭，加入失败日志捕获后重跑完整夹具通过，但超时根因尚未复现定位，不宣称长期采样稳定性已验证。

- `runtime.resources.snapshot/diff` 已接线并原生验证：读取 assetManager 缓存、引用计数、直接依赖与已加载 Bundle；资产和依赖数量受限。外部基线检查版本、完整性、重复键、字段及总依赖数量，仅比较定义字段并规范化依赖顺序。
- `scripts/creator2-resources-native.ts` 使用场景已有完整 UUID 资源验证：自有加载引用 +1，释放后恢复原始计数，资源仍由场景持有。报告 `.codex-work/logs/creator2-expansion/resources.json`；结束时关闭预览。206 项自动测试、类型检查及构建通过。
- 资源比较不声称测量显存、完整 JavaScript 引用或自动判定泄漏。加载轨迹及业务场景长期循环验收仍未完成。
- 资源快照新增 runtimeId/snapshotId，inspector 实例维持来源记录；最多保留四份且总计不超过 4M 字符的原始快照。只有内容完整匹配的近期本实例快照返回 sameRuntimeVerified=true；跨实例、修改或过期均显式返回未验证及原因，不将身份标签本身当作来源证明。
- `tests/creator2-resources.test.ts` 覆盖模拟切场景保持身份、独立实例不匹配、基线篡改与淘汰；原生脚本验证同次预览来源匹配，以及真实关闭/重开预览后旧基线不同实例。207 项自动测试、类型检查、构建和 `.codex-work/logs/creator2-expansion/resources.json` 原生验收通过。模拟切场景测试不替代真实场景切换验收。
- 新增 `runtime.resources.trend`：接受按采集顺序排列的 2–4 个近期原生快照 ID，报告各场景缓存数量、Bundle 数量、逐资源 present/refCounts、持续驻留、出现/消失及首尾引用增长。过期、跨实例、重复或逆序 ID 拒绝；不将驻留或增长自动判定为泄漏。
- 原生资源验收已通过 `Director.runSceneImmediate` 从原场景连续切到两个临时运行时场景，验证场景 ID 变化、运行实例身份不变、旧 MCP 资源句柄失效和自有引用归还，并对三份真实快照执行趋势接口。没有写入或替换编辑器场景文件；最终关闭预览。此证据覆盖原生场景切换机制，不代表业务场景加载与长期循环已验收。
- 208 项自动测试、类型检查、构建和资源原生脚本通过；原生报告仍为 `.codex-work/logs/creator2-expansion/resources.json`。首次启动调用因场景 IPC 尚未注册而失败，未启动预览；就绪后重试完整流程通过。

- 新增 `RuntimeTaskSessions` 共用任务管理：每任务独立 FrameSession、30 秒总时限、最多四个并行任务及八条保留记录；停止等待采样 finally，清理失败保留 failed，不标记正常取消。场景/session 清理使任务 ID 失效。
- 新增 `runtime.collision2d.trace_start`、`runtime.task.poll/stop`；进度包括实际完成帧数、受限事件记录和丢弃数量，取消后仍可查询已捕获记录。旧同步 trace 保持兼容。
- `scripts/creator2-task-native.ts` 在独立 2.4.15 工程验证启动立即返回、采样期间后续移动命令生效、enter/stay/exit、取消及重复停止、自有观察组件数量恢复、短任务自然完成。报告 `.codex-work/logs/creator2-expansion/tasks.json` passed=true；预览最终关闭。
- 211 项自动测试、类型检查及构建通过。自动测试覆盖取消隔离、清理异常、销毁失效及任务限额；30 秒超时和采样期间断线/切场景尚未逐项原生验证，其余采样接口也尚未全部迁入任务会话。
- 修复 RuntimeTaskSessions 的截止时间/停止竞争：超时后立即 stop 仍保持 failed；超时清理若返回 OUTCOME_UNKNOWN，保留该清理失败，不被普通超时错误覆盖。新增模拟时钟测试持续完成帧直至 30 秒，分别覆盖清理成功与失败。
- 原生任务验收扩展：将测试预览帧率临时设为 5，实际等待总时限并断言 30 秒错误，随后恢复原帧率及观察组件数量；将测试根注册为跨场景保留节点后启动采样并切换临时场景，断言旧任务失效、节点仍在且组件数恢复；取消保留标记后启动任务并关闭/重开预览，断言旧任务失效且新预览无额外观察组件。
- 213 项自动测试、类型检查、构建与 `.codex-work/logs/creator2-expansion/tasks.json` 原生扩展验收通过。预览重启不等同仅桥接断线，保持预览进程的纯连接中断及其他采样迁移仍待验收。
- `scripts/creator2-disconnect-native.ts` 新增纯连接中断原生验收：仅本机回环代理短暂切断 HTTP 连接，观察到运行时失败重试后恢复转发；不调用重连注入、不重启预览、不重新注册 runtimeInstanceId。运行实例和 sceneId 保持不变，generation 从 1 增至 2，旧任务 STALE_HANDLE，全部节点组件数量恢复，cleanupErrors 为空。
- 纯断线报告 `.codex-work/logs/creator2-expansion/disconnect.json` passed=true；代理、预览和网关最终关闭，测试配置和凭证不进入输出。此项补齐碰撞任务的纯断线验收，其他采样接口迁移仍待推进。
- 新增 `runtime.camera.inspect/convert/culling`：原生相机配置、visibleRect 与渲染目标状态；2D alignWithScreen 坐标转换；分组掩码与原生 containsNode 分别报告。非法/非有限坐标、零缩放及未适配投影在原生调用前拒绝；掩码匹配不代表最终可见。
- 2.4.15 containsNode 使用有符号掩码结果 >0，适配层额外以 !==0 计算高位分组匹配；单测覆盖第 31 组差异，尚未对此组做原生渲染验收。
- `scripts/creator2-camera-native.ts` 验证位移 (120,80) 与 zoomRatio=2 的原生坐标预期及往返误差 <0.001、分组包含/排除、alignWithScreen=false 拒绝；测试根停用且预览关闭。`.codex-work/logs/creator2-expansion/camera.json` passed=true；215 项自动测试、类型检查与构建通过。
- Camera 完整范围继续保留：3D 投影、不同 viewport、遮挡诊断、RenderTexture 离屏像素与临时 GPU 资源释放尚未验收。当前 native-visibleRect 坐标不直接宣称为浏览器 CSS 像素。
- 新增 `runtime.camera.sample_pixels`：限制 1–512 像素尺寸、1–64 个像素位置，2D 屏幕对齐相机手动渲染至临时 RGBA 纹理，返回左下原点的采样结果；恢复原目标和节点变换，finally 调用纹理/FBO 及深度模板缓冲销毁，清理失败 OUTCOME_UNKNOWN。
- 随包源码确认 RenderTexture.destroy 未处理其 `_depthStencilBuffer`；2.4.15 适配额外销毁并清空这一自有缓冲。单测覆盖业务目标恢复、渲染异常清理和越界前置拒绝。
- 原生 Camera 脚本连续三次采样 32x32 离屏清屏结果，每次左下、中心、右上均为精确 RGBA [255,0,0,255]，原目标恢复为 null。217 项自动测试、类型检查、构建及 camera.json 原生流程通过。该证据证明清屏像素与目标恢复，不证明复杂场景像素、模板裁剪或驱动显存无泄漏；GPU 对象销毁目前为源码路径/调用证据，仍需补原生对象存活检查。
- 离屏采样新增 WebGL 对象存活验证：保存自有纹理/FBO/深度模板缓冲原始句柄，渲染后 isTexture/isFramebuffer/isRenderbuffer 全部为 true，销毁后全部为 false 才返回 gpuObjectDeletionVerified=true；上下文丢失不得当成释放成功。清理步骤独立执行，投影恢复失败仍尝试节点变换与 GPU 对象清理。
- 218 项自动测试、类型检查与构建通过；Camera 原生脚本连续三次断言 gpuObjectDeletionVerified=true，RGBA 与目标恢复保持通过。camera.json 提供对象删除证据，不能推断驱动总显存回落、复杂场景正确性或所有 GPU 对象均无泄漏。
- 原生 Camera 验收增加独立 Graphics/Mask 节点：绿色图形在矩形 Mask 内为绿色、外为红色背景；禁用 Mask 后同一外部像素变绿；inverted=true 时内部变红、外部变绿。增加上蓝下绿图形，在较小 y 采样为绿、较大 y 为蓝，验证左下像素原点。
- 采样前将相机绑定到独立 16x16 业务 RenderTexture，采样后核对同一运行时句柄、原尺寸及临时 GPU 删除；随后显式解绑并销毁测试业务纹理。所有新测试根停用，预览关闭。camera.json renderedPixelsVerified=true 的范围为此 Graphics/矩形 Mask 夹具，不泛化为所有场景或 Mask 类型。
- `runtime.camera.convert` 增加 3D 非屏幕对齐投影，要求显式 z；屏幕深度统一为 worldToScreen 对应的 0..1 投影深度。原生透视 screenToWorld 使用线性插值和 NDC 0.9999 参考平面，适配层依据 near/far 补偿后调用，避免直接将投影 z 传回导致错误坐标。
- 原生 Camera 脚本覆盖透视/正交、完整/局部视口、非中心点及近远裁剪附近点，三轴往返误差 <0.01；2D 与离屏 Mask/GPU 删除回归同时通过，camera.json projection3DVerified=true。3D 模型渲染和 3D 离屏像素仍未验证，sample_pixels 仍限 2D。
- 新增 `runtime.tween.plan/start`：to/by/delay/sequence/parallel、有限 repeat 和显式缓动；仅 x/y/angle/scaleX/scaleY/opacity 数值属性，嵌套深度/步骤数/总时长受限，并行写同属性拒绝。同节点最多一个 MCP Tween；通过 task.poll/stop 查询与取消，最多保留 600 帧样本并报告 dropped。
- Tween finally 仅停止自有 Tween，不调用 stopAllActions；取消保留当前值，不回滚业务可能修改的属性。停止失败返回 OUTCOME_UNKNOWN，并保留所有权锁，避免继续在清理不明的节点上启动新任务。
- `scripts/creator2-tween-native.ts` 原生验证并行、顺序、延时、相对变化、重复与 quadOut，最终 x=110/y=40；第二个 Tween 取消后 x 保持不变，同节点独立 rotateBy 业务动作继续改变 angle。夹具最后停止其自有旋转、停用节点并关闭预览；`.codex-work/logs/creator2-expansion/tween.json` passed=true。
- 221 项自动测试、类型检查、构建通过。Tween 专项切场景、纯断线、目标销毁和并发冲突尚未逐项原生验收；不能用碰撞任务的生命周期验收替代这些动作清理证据。
- Tween 专项生命周期已补原生证据：同节点第二个 Tween 任务 RESOURCE_BUSY；取消后可重新取得所有权；持久节点切场景后 x 保持、getNumberOfRunningActions=0、旧任务 STALE_HANDLE；自有运行时节点通过 runtime.release(destroy=true) 销毁后任务 failed/STALE_HANDLE。直接 invoke destroy 被既有权限拒绝，夹具改用正式所有权释放接口，未放宽策略。
- 纯连接中断夹具同时运行碰撞与 Tween，保持运行实例和场景不变；恢复连接后旧 Tween 任务失效、x 不再变化、原生动作数为 0，同节点新 Tween 完成，证明锁已释放。tween.json 与 disconnect.json 原生流程通过；221 项自动测试、类型检查与构建通过。全部缓动曲线、属性组合及超长样本截断仍未逐组合原生覆盖。
- 新增 `runtime.spine.details`：静态骨骼父子关系与 setup、实时姿态矩阵、插槽附件、轨道时间/混合与直接排队动画；限制骨骼/插槽数量和 32 轨道，显式 totals/truncated。骨骼 worldX/worldY 标为骨架坐标，不误称场景世界坐标。
- 缓存模式不调用 findBone/findSlot/getState 读取共享骨架的动态状态，返回 pose/tracks=null 及不可用原因，保留静态结构。状态查询不推进动画，不改写业务监听。
- `scripts/creator2-spine-native.ts` 复用已导入 raptor 资源，验证 realtime→shared cache→private cache→realtime，实时轨道时间推进、缓存状态边界和 limit=1 截断；最终停用节点并关闭预览。`.codex-work/logs/creator2-expansion/spine.json` passed=true；223 项自动测试、类型检查和构建通过。DragonBones 深入查询、混合配置与事件监听边界仍未完成。

- 新增 `runtime.dragonbones.details`：依据当前 ArmatureData 返回骨骼父子关系、初始变换、插槽与显示索引；实时模式读取已求值骨架矩阵和最多 32 个动画状态，数量限制显式返回 totals/truncated。矩阵使用骨架局部坐标，初始旋转/倾斜单位为弧度。
- DragonBones 缓存模式不查询共享 Armature 的实时骨骼、插槽或动画状态，pose/displayIndex/states 返回 null，避免将缓存求值对象当作本组件当前画面。未初始化、类型错误和非法数量提前拒绝。
- `scripts/creator2-dragonbones-native.ts` 复用已有 NewDragonTest 与图集，独立 2.4.15 工程验证 realtime→shared cache→private cache→realtime；实时动画时间推进、缓存边界和截断均通过，最后停用测试节点并关闭预览。原生报告 `.codex-work/logs/creator2-expansion/dragonbones.json` passed=true。
- 本轮 226 项自动测试、类型检查、构建通过；首次沙箱内回归因本机监听 EPERM 失败，允许本机监听后全量通过。未同步 Texas。骨骼混合配置、事件共存/清理及其他扩展域仍保留未完成状态。

- 新增 `runtime.dragonbones.trace_start`，复用 task.poll/stop，限制 1–300 帧及 1–5000 条记录；各任务独立 addEventListener/removeEventListener，不覆盖业务监听。原生池化 EventObject 仅在回调中复制标量，超量记录统计 dropped。
- 缓存模式仅允许 start/loopComplete/complete，原生不提供事件对象时返回 hasNativePayload=false 和空动画字段，不伪造动画状态；中途切换 cache mode 明确失败。取消/失败先关闭记录，再逐项清理监听，清理异常保留 OUTCOME_UNKNOWN。
- `scripts/creator2-dragonbones-events-native.ts` 在独立 2.4.15 工程验证实时/共享/私有缓存各自开始、循环完成、播放完成；验证记录截断、取消后记录不再增长、独立原生订阅仍能收到后续完成事件。报告 `.codex-work/logs/creator2-expansion/dragonbones-events.json` passed=true，预览关闭。
- 229 项自动测试、类型检查和构建通过。事件池回收、缓存限制、业务监听保留、取消、模式冲突与清理失败由自动测试覆盖；帧/声音/混合事件、Spine 事件、追踪中的纯断线/切场景及精确原生监听计数恢复仍需专项验证，不由当前报告推断完成。

- 新增 `runtime.spine.trace_start` 实时事件任务：直接注册 AnimationState 独立监听，不调用组件 set*Listener 覆盖业务回调；复制 TrackEntry/事件标量，记录数量有上限，取消后停止记录。finally 移除自有监听并核对原生 listeners 中不存在，异常保留 OUTCOME_UNKNOWN。
- 中途更换状态对象/缓存模式返回 OPERATION_CONFLICT；目标销毁返回 STALE_HANDLE。Spine 缓存分支只有组件单槽回调，本轮明确拒绝追踪，保留为后续独立适配，不把实时监听 API 标作跨模式支持。
- `scripts/creator2-spine-events-native.ts` 通过 asset.location/AssetDB 在 Scripts 目录创建业务完成回调夹具，独立工程验证 start/interrupt/end/dispose/complete、业务回调继续执行、追踪结束和取消后原生监听器数量恢复、记录截断及缓存模式边界；报告 `.codex-work/logs/creator2-expansion/spine-events.json` passed=true。预览和网关最终关闭。
- 232 项自动测试、类型检查、构建通过；单测另覆盖池化负载复制、注册后抛错的补偿、取消/销毁和清理失败后回调失活。Spine 自定义 event 负载原生验收、缓存模式追踪、两类骨骼混合配置和事件任务断线/切场景仍待完成。

- Spine 缓存事件适配已补：`Creator2SpineCachedEvents` 对原生 start/complete/end 数据槽临时转发，保留原业务回调参数、this、返回值与异常；回调内复制合成动画名和轨道索引，trackTime/loop/payload 置空。非法访问器、非可写槽和非函数回调提前拒绝。
- 缓存模式单组件只允许一个追踪任务，避免包装链互相覆盖。检测缓存模式/监听对象/业务回调改写时报告 OPERATION_CONFLICT；finally 只恢复仍由自己持有的槽，不覆盖业务新回调。清理失败回调停止记录并保留所有权锁，返回 OUTCOME_UNKNOWN。
- `scripts/creator2-spine-cached-events-native.ts` 独立工程验证共享与私有缓存 start/complete/end、合成负载、回调身份恢复、取消后业务继续、同组件并发拒绝、业务改写新回调保留；`.codex-work/logs/creator2-expansion/spine-cached-events.json` passed=true。实时 `spine-events.json` 重新验收通过，两次预览均关闭。
- 235 项自动测试、类型检查及构建通过。缓存模式本身不提供自定义/中断/释放事件，显式拒绝；其余自定义事件原生负载、混合配置、断线/切场景及全部其他扩展域继续保留，不能由本次缓存回调验收推断完成。

- 新增 `scripts/creator2-skeleton-lifecycle-native.ts`：同一预览内同时运行 Spine 实时、Spine 缓存和 DragonBones 事件任务。通过回环代理每轮等待新的失败请求，核对 runtimeInstanceId/sceneId 不变且 generation 增长，证明仅桥接连接中断，不通过重开预览代替。
- 原生夹具核对 Spine 实时 listeners 数量、缓存 complete 回调函数身份、DragonBones 三类事件原生 callbackInfos 数量及业务回调存在；断连和持久节点跨场景后均恢复基线、旧任务 STALE_HANDLE、业务完成/循环计数继续增长，并成功重获追踪所有权。
- 骨骼生命周期模式组合为 Spine shared/DragonBones realtime、Spine private/DragonBones shared、Spine shared/DragonBones private，每组均包含独立 Spine realtime。`.codex-work/logs/creator2-expansion/skeleton-lifecycle.json` passed=true，预览、回环代理与网关最终关闭。235 项自动测试、类型检查及构建通过。
- 夹具修正：DragonBones 无限循环使用 loopComplete 检查业务继续；已有脚本核对内容后复用，避免重复保存触发热重载使编辑态对象失效；每轮断连检查增量请求数；停用之前自有 SkeletonLifecycle 测试根以减少累积干扰。期间发生一次渲染帧等待超时，加入失败日志且隔离旧夹具后完整流程通过，根因未被独立证明，不能据此宣称长期采样无超时。

- 新增 `runtime.spine.mix.inspect/update`：查询动画对有效时长、默认时长和显式覆盖；写入必须携带完整 expected 三字段，旧值漂移拒绝。duration=null 删除显式覆盖恢复 defaultMix 继承，不能用写回当前默认数值冒充恢复。配置仅作用于之后新建的实时轨道，不持久化资源或改写当前轨道。
- 2.4.15 原生使用 from + 点 + to 拼接键；适配检测动画名带点造成的歧义及重复名字，并在任何写入前拒绝。非有限/负数/超 30 秒、动画不存在、缓存模式均拒绝；原生写入异常或读回不符返回 OUTCOME_UNKNOWN 和 before。
- `scripts/creator2-spine-mix-native.ts` 验证 walk→Jump 1.2 秒混合的实际 TrackEntry.mixDuration、mixingFrom、mixTime 推进和过渡完成后前驱清除；同时覆盖旧值冲突、反向动画对不变、原始覆盖恢复与缓存拒绝。`.codex-work/logs/creator2-expansion/spine-mix.json` passed=true，预览关闭。238 项自动测试、类型检查、构建通过。该证据为原生轨道过渡，不宣称视觉插值截图验收或 DragonBones 混合完成。

- 新增 `runtime.dragonbones.fade`：使用原生 Animation.fadeIn，实现 none/sameLayer/sameGroup/sameLayerAndGroup/all/single 六类淡出规则、图层/组及播放次数；非有限/越界、缓存模式、不存在动画和已有状态 >=32 在写入前拒绝。返回前后状态和 selected/reused，不将 Single 复用状态的原配置伪造成新参数。
- 原生 getStates 返回可变内部数组；适配复制数组后再调用 fadeIn，保证 before 和 reused 身份判断正确。写入或读回异常返回 OUTCOME_UNKNOWN；不承诺回滚已推进的业务动画时间线。DragonBones details 增加 fadeTotalTime、原生 fadeProgress 与 effectiveWeight，字段只在实时模式读取。
- `scripts/creator2-dragonbones-fade-native.ts` 经 asset.location/AssetDB 在既有骨骼资源目录创建双动画夹具，第二动画修改骨骼位移；独立工程逐项验证六种规则的淡出目标、淡入进度推进、旧状态移除/保留、Single 复用以及 fadeIn/fadeInComplete/fadeOut/fadeOutComplete 原生事件，缓存模式拒绝。报告 `.codex-work/logs/creator2-expansion/dragonbones-fade.json` passed=true，预览关闭。
- 241 项自动测试、类型检查和构建通过。当前原生证明限于状态、混合进度与事件；复杂分层视觉结果、骨骼 mask/additive 配置及自定义 frame/sound 事件仍未逐项验证，其余原方案域继续保留。

- DragonBones 事件追踪新增 UserData payload，复制 ints/floats/strings，分别最多 8 项、文本最多 256 字符，并返回 truncated；不保留原生池对象引用。自动测试验证回收后原记录不变以及截断标记。
- `scripts/creator2-skeleton-custom-events-native.ts` 经 asset.location/AssetDB 在已有骨骼目录创建事件夹具和配套 Spine atlas（复用原纹理）。原生播放验证 Spine 两帧的默认/覆盖 int、float、string，以及 DragonBones frameEvent/soundEvent 各自名字与三个负载数组。报告 `.codex-work/logs/creator2-expansion/skeleton-custom-events.json` passed=true，预览关闭。
- 242 项自动测试、类型检查及构建通过。源码确认 DragonBones SOUND_EVENT 先分发到骨架，再分发全局管理器；适配仅监听目标组件，因此此项不等价于音频播放验收。原方案其他领域和复杂分层视觉结果仍未完成。
