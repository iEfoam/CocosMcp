# MCP 预览可靠性与性能工作流

## 安装、预览与审计优化（2026-10-08）

源码实现、自动化桩测试、原生 Creator 验收及真实业务验收分别记录。本节不提升历史原生报告的适用范围。最新源码 333 项自动测试通过；原生 Creator 2 为 14/14、Creator 3 为 12/14，两个未通过项不借用此前源码的全通过结论。精确指纹、CP-001～013 对照及完整调用方式见 [预览验收指南](preview-acceptance.md)。

### 完整包和旧版本升级

Creator 2/3 必需文件均包含 `dist/runtime.js`；构建写入 `package.json.fileHashes`。本地安装在备份旧目录前及 staging 复制后分别检查必需文件，拒绝缺失、空文件、符号链接及摘要不一致。GitHub 更新保留固定来源、下载包 SHA-256、白名单和整目录备份替换，同版本也检查运行文件。旧包缺摘要时为 unknown。

`editor.status.extension` 和控制中心返回 runningBuildId、installedBuildId、reloadRequired、integrity.health 及逐文件 rows。面板轮询复查文件元信息，发生变化才重算摘要；安装/更新执行完整摘要检查。磁盘健康不能证明已经重载或 runtime 握手成功。

Creator 2 旧更新器的七文件白名单不能接收新完整包。首次升级使用已有本地安装器或同版本 ZIP 整目录安装，保留 `backupPath` 后重载；回滚恢复整个旧目录。不能继续发布缺 runtime 的七文件包，也不能手工混入未知版本 runtime。详见 [打包说明](extension-packaging.md)。

### 场景、帧和截图

`preview.capture` 的共享输出契约要求截图 ID、UTC 捕获时间、来源、正整数尺寸、PNG data URL 和图片摘要/字节数。内嵌预览另外要求 `frameBinding=draw-observed-before-composite`、`exactPixelFrameIndex=null` 和明确的 stale 状态；业务与布局验证字段必须为 false。外部浏览器只承担其截图与会话证据，不要求提供原生 AFTER_DRAW 绑定。该契约校验返回结构，不能代替像素内容、实际布局或真实交互验收。

preview.status/capture 区分 launchSceneId、currentSceneId 和 sceneGeneration。合法切场景后继续截图、连接 runtime；严格检查使用 expectedSceneId / expectedGeneration。generation 属于各自会话，不能跨预览和 runtime 直接比较。原生场景事件使旧对象句柄、任务和订阅失效。

截图提供 captureId、UTC capturedAt、SHA-256、PNG 实际尺寸、Canvas 几何和帧证据。窗口合成截图记录绘制前后的计数，exactPixelFrameIndex 保持未知，不声称像素恰好来自某一个计数的帧。runtime.capture 在 AFTER_DRAW 回调内同步读图，避免 await 后 WebGL 缓冲已清空；不默认改变 preserveDrawingBuffer。

像素采样仅标记单色、全透明等现象，合法黑背景不判失败。图片非空、实际绘制和布局正确是独立结论。默认等待新帧；frameMode=lastFrame 仅返回当前 generation 已捕获的图片，明确 stale=true，不恢复暂停。

MCP 默认使用 ImageContent，文本和 structuredContent 不重复 Base64，覆盖 capture/resize/input 和 viewport 批次。旧客户端可显式传 imageDelivery=legacy-json 保留 structuredContent.dataUrl；无需客户端能访问服务端本地路径。

### 输入、坐标与窗口恢复

输入依次执行身份检查、聚焦自有窗口、有界等待帧、发送事件、截取下一帧。仅显式 allowResume=true 才调用公开 game.resume。发送前帧失败返回 inputSent=false；发送后失败返回 OUTCOME_UNKNOWN、inputSent、sentEvents、确认事件和尝试事件。首个发送调用发生异常且未确认投递时 inputSent=null，不能断言没有发出；先核查实际状态，不自动重放。

默认 coordinateSpace=window-css 保留窗口内容左上坐标；canvas-css 相对 Canvas 左上；design-top-left 根据实际引擎 scale、viewport 和缓冲尺寸换算，不假定项目使用拉伸适配，公开数据不足时拒绝换算。image-pixels 必须传当前 captureId，根据该 PNG 和窗口内容尺寸换算，不只依赖 DPR；区域外坐标拒绝。聚焦后首帧重新换算坐标；参考图片的窗口尺寸、Canvas 几何或适配数据变化时拒绝旧截图坐标。

start/resize 以及 validate_viewports.rows 支持方向约束。横屏参考尺寸为 568×320、844×390、1280×720、1920×1080。批次结束仅在会话、场景 generation 及最后修改尺寸仍相同时恢复；其他任务改过尺寸则保留现场。截图仍需独立 UI 断言或视觉审查。

### 刷新、就绪和诊断

embedded 刷新使用自身窗口及 CDP 导航/脚本字节观测，无需 Chrome 连接器；external-browser 使用显式配置的工程浏览器连接器。刷新绑定 target、session 和 URL；导入、编译及加载后复查源码摘要。仅本次原生导航正确 frame 的实际加载字节匹配原生产物且绘制就绪时才 completed，缺证据仍 unknown。不以 revision 回显证明成功。

Creator 3.8.8 等待 programming 原生完成信号并核对源映射及 chunk；Creator 2.4.15 等待 ProjectCompiler Promise，核对 bundle 字节、源映射及实际匿名 eval 模块。普通业务脚本和网络正文不作为诊断采集目标。非脚本只采用 AssetDB 原生 library/subAssets 清单和 UUID 文件身份，核对同源 Bundle 的实际响应字节；清单缺失、未加载的子资源、未知 importer、插件脚本和未覆盖的传递依赖明确 unknown。预览场景快照与磁盘导入产物不相同时，也不能报告加载版本已证明。

受控 Creator 3 页面使用原生 autoReload=false；Creator 2 仅拦截自有窗口的自动导航，显式刷新仍可执行。刷新取证期间暂时禁用该窗口的网络缓存，结束后恢复；不修改工程全局设置。刷新后必须沿用 preview.runtime.connect 返回的新 runtimeInstanceId，旧连接可能在 30 秒失联保留期内仍存在，不能按最新实例猜测目标。

preview.runtime.connect 为业务中性别名，保留 shader.preview.connect；握手报告 runtime 源码指纹与 runtimeSourceConsistency。preview.wait 在 100..30000 ms 内同时检查 sceneId、afterFrameIndex 和 uiChecks，不接受任意表达式，不默认 resume。

就绪分开报告页面、引擎、启动场景、当前场景绘制、runtime 注册和业务状态，业务默认 unknown。console fallback 补齐有界 debug/info 采集，保留脱敏和不采集 HTTP/WS 内容的默认策略。诊断区分明确 CORS、连接拒绝、HTTP 状态及 WS 错误；URL 未声明用途时，不猜测它属于预览、网关还是业务连接层。

Creator 2 embedded 通过原生 stashed-scene 快照及自有调试器的有限请求拦截预览当前场景，保留全局 start-scene。external-browser 不能执行这项自有窗口拦截，配置与当前场景不一致时明确拒绝。场景 UUID 切换通过公开 AssetManager.loadAny 和 Director.runSceneImmediate；director.loadScene 的名称参数不能直接当作 UUID 使用。

Creator 3 的 `prefab.instantiate` 显式保留原生预制体关联并核对资产 UUID；创建后无法确认关联时返回 OUTCOME_UNKNOWN，不自动再建一棵树。原生编辑器禁止在普通场景中删除资产所属子节点：先保存场景，通过 `prefab.open` 进入资源编辑模式，修改后 `scene.save`，再回原场景。模式与资产身份通过原生上下文核对，包装场景 UUID 与资产 UUID 分开处理。

### 审计和恢复

审计同时记录编辑器、runtime、失败及权限拒绝的开始/终态、UTC 时间、耗时、context、effect 和副作用状态。请求仅存 SHA-256 指纹；源码、响应正文、密码、token、签名和图片 Base64 不写入通用账本。开始/终态是两条事件，不等同于两次工具执行。

新审计写入 `.codex-work/logs/cocos-mcp/operations/`，单个写入器按 UTC 日期或 4 MiB 分段，每条元信息最多 64 KiB。分段时间是文件分配时间，事件时间仍取 `startedAt`；筛选使用事件 UTC 时间的 `[from,to)`，不按文件名猜测事件日期。旧 `operations.jsonl` 保留原位并优先读取，不迁移或删除。

`operation.audit.query` 新增 `nextPageCursor`，下页作为 `pageCursor` 传回，直接定位分段和字节偏移。保留旧整数 `cursor`/`nextCursor`，但旧游标仍需要从头计数；两种输入游标不能同时传。文件被替换、截短或移走会报 `STALE_REVISION`，非法偏移报 `INVALID_ARGUMENT`。游标不是日志订阅或跨进程一致性快照：并发写入可能落在已读分段，完整导出需待相关写入结束后重新查询。同一写入器内保持顺序，不宣称多进程事件按时间全局排序。

轮转只限制单文件大小，不限制历史总占用；不会删除恢复账本、未知结果、幂等标记或历史日志。恢复证据不能按审计 TTL 淘汰。任何历史清理仍须先盘点精确路径并获得授权。

编辑器桥接的新成功普通读操作只持久化参数指纹、`completed` 状态及 `resultRetention=not-retained-read`，不复制查询返回值或 revision。原调用仍获得完整结果；再次直接提交相同 ID、相同参数时重新执行读取并重新校验 revision，可能得到新的查询结果。应用层仍可在自身有界内存缓存有效期间返回缓存。操作查询会明确返回“结果未保留”标记，不将缺失结果当作 null 成功结果恢复。

参数指纹保留，因此同 ID 改参或换成写操作仍然冲突。旧完整读账本保持原样重放；写操作、pending、failed、unknown 的恢复语义不变，不按 TTL 删除。该策略限制新成功读记录的载荷大小，不限制操作 ID 总数，也不宣称历史总空间有界；失败诊断与历史清理仍遵循上述保留规则。

指定 operationId 的非只读操作在发送前创建排他持久化恢复记录。当前进程复用原去重结果；服务重启后 cocos_operation_query 可查恢复元信息，不保存完整响应，不自动重放。相同 ID 参数变化拒绝；已完成但内存响应已丢失时返回 OUTCOME_UNKNOWN，先确认实际状态，再决定是否创建新操作。审计失败单独警告，不使已执行成功变为可重试失败。

自动化覆盖同版本缺文件/混包修复、旧包受控安装及目录回滚、场景往返/同 UUID 替换、帧内读图、输入前后失败、embedded 刷新字节证明、坐标/窗口冲突、脱敏和重启防重放。当前原生验收范围与逐项结果见本次执行报告；源码和桩测试不能提升为所有设备、GPU、真实业务或外部连接器均已验证。

### 视图、语义交互、验收配方和夹具

`preview.presets` 列出四种横屏参考尺寸。`runtime.view.inspect` 返回公开视图数据与 viewHash；`configure` 必须传 expectedHash，仅接受有限尺寸和五种原生策略；`restore` 必须传本会话 restoreId。恢复核对几何、策略对象身份和公开 setter 变更记录，拒绝覆盖中途变更。缺少可观测公开 API 时拒绝配置，不读取私有策略字段。

`runtime.ui.select` 对 nodeId/name/path 使用 AND 匹配，要求唯一；返回 active、文本、按钮状态、公开相机投影、Canvas 区域、裁切与原生命中候选。`runtime.ui.check` 使用 rows 执行存在/不存在、count、文本、可选节点、可见和裁切断言。Creator 2 Mask 的有效性不能从公开接口证明时，点击保守拒绝。

`runtime.ui.click` 绑定所选 runtime 与自有预览，发送原生鼠标事件并轮询 after 断言。命中候选与后态不等于真实事件接收者证明，actualReceiverVerified 保持 false。发出输入后后态无法证明返回 OUTCOME_UNKNOWN，禁止重放。业务结果也不会根据文字变化自动宣布成功。

`fixture.plan/create/status/cleanup` 复用 ui.plan/build，声明合成 document、父节点、期限及精确 allowedOrigins，默认拒绝业务网络。Creator 自身预览来源和本机受控 gateway 按需放行。创建记录先保存根节点，再保存原生序列化快照、父位置及存活引用。清理只移除这棵树；用户修改、父位置变化、外部引用或指纹冲突均保留现场。创建中断和清理结果未知不自动重放，重启后查询记录再核对原生状态。

`acceptance.plan/run/status/cancel` 复用现有工作流和结果引用，配方分 fixture/live，最多 50 步。执行前使用 planHash 确认范围；输入步骤必须显式 allowInputs=true。证据包包含 runId、输入摘要、工具/引擎版本、源码指纹、rows、原图 SHA-256 与路径、脱敏结果及清理状态。取消只停止后续步骤；原生操作可能继续，证据和原 ID 保留。服务重启后的 running 为 unknown，不自动续跑。

`preview.regression` 只重复 resize、refresh、wait、runtime.scene.load，最多 10 轮、每轮 8 步。生命周期采样绑定当前自有预览 runtime，按第一轮预热后的基准检查句柄、订阅、任务、帧等待、资产引用/加载及资源数量；比较同一次导航内的帧推进，报告 P50/P95 墙钟延迟。GPU 内存不可取得时明确 unknown，不把这些有限指标等同于全部泄漏检查。

示例参数（通过实际能力 schema 校验后交给 cocos_capability_execute，外层需添加 projectId/instanceId）：

```json
{"capabilityId":"runtime.ui.click","runtimeInstanceId":"<preview.runtime.connect 返回值>","params":{"selector":{"name":"Action","path":"Canvas/RoadmapFixture/Action"},"after":[{"selector":{"name":"Action"},"text":"Clicked"}],"timeoutMs":5000}}
```

```json
{"capabilityId":"preview.regression","params":{"cycles":3,"rows":[{"capabilityId":"preview.resize","params":{"preset":"landscape-844"}},{"capabilityId":"preview.resize","params":{"preset":"landscape-1280"}}]}}
```

### 沿用本地登录会话

`scripts/open-creator.mjs` 使用 `CreatorLauncher` 优先核对工程、版本与认证 `bridge.identity`，将原生 `loginState` 与桥接身份分开；优先唯一已登录实例，多实例显式选择，未登录或未知实例保留现场。Creator 3 使用固定 `.codex-work/cache/creator-home`，同账号更新会话采用工程内互斥、备份和内容守卫刷新，跨账号、活动窗口及无效旧 profile 不自动覆盖。`launch.json` 在派发前记录原尝试；未知结果、仍在启动或同凭据未确认登录时禁止重复启动。晚到的已登录桥接可以核对 PID 后将原尝试标记 ready。文件权限 0600，目录 0700；不输出会话密钥，不自动清理备份或残留锁。Creator 2 使用已登录 Dashboard，直接启动提前拒绝。原生 API 不可用时返回 unknown；没有更新会话的过期/撤销凭据仍需用户正常登录。具体状态和恢复边界见使用指南。

发现编辑器时同时核对认证身份和进程，不只依赖历史 PID 存活；系统 PID 复用不能制造假多实例。启动器扫描全部有效候选后优先复用已认证实例。旧桥接缺少身份入口时，使用原有认证 describe 检查版本和能力，保持旧版发现兼容；真实多个编辑器仍须明确 instanceId。

## 服务可靠性与面板优化（2026-09-22）

- 显式 operationId 的指纹、执行中请求、成功结果和错误统一保存在最多 2048 条记录中。确认终态保留 30 分钟（单调时钟计时），容量压力下先淘汰终态；相同 ID / 参数共享请求与结果，不同参数返回 OPERATION_CONFLICT。已确认失败在保留期内也返回原错误。
- 执行中和 OUTCOME_UNKNOWN 不自动过期或淘汰。全部记录均受保护时，新请求返回 RESOURCE_BUSY。编辑器操作可通过 cocos_operation_query 向最初实例读取账本，确认终态后恢复正常保留策略；查询失败或 NOT_FOUND 不解除保护。运行时未知操作尚无自动对账机制，需人工核对运行状态。内存记录不跨服务重启，不能把 TTL 当成重复写入许可。
- 每个工程保持串行执行，最多等待 128 个请求，排队超过 30 秒返回 TIMEOUT；尚未执行的取消立即移除并释放容量。执行后的取消由桥接报告是否结果未知；不会以超时为由提前释放正在执行的写任务。不同工程相互独立。
- 独立控制通道采用明确白名单：桥接身份/原子账本，以及 `console.query`、`preview.refresh.status`、`preview.refresh.cancel`；后面三个同时绕过应用层和桥接层队列，仍执行认证、实例/能力和参数守卫。普通场景读写继续串行，`preview.status` 会异步检查窗口并更新观测状态，因此没有因 read 标签而开放并发。刷新取消仅停止后续阶段，`nativePending=true` 表示原生导入仍可能完成，不代表回滚副作用。
- 控制通道回归将一次写入保持五秒：身份、控制台和刷新取消在 500 ms 测试预算内返回，来自应用及直达桥接的后续写入均继续等待；未认证取消被拒绝。取消后的已派发导入仍完成一次，编译不再执行。该测试驱动实际应用/桥接队列和 PreviewRefresh 状态机，原生导入由夹具模拟，不冒充真实 Creator 验收。
- 工作流 JSON 使用同目录临时文件、fsync 和原子发布，首次创建保留排他语义。成功步骤的检查点失败会停止工作流并返回 OUTCOME_UNKNOWN，附已完成步骤；未知结果不会因 continueOnError 继续。该机制保证读者不会看到半份 JSON，不等价于数据库事务或断电持久性承诺。
- 编辑器已确认成功后，应用审计日志写入失败改为成功响应中的 warnings/AUDIT_WRITE_FAILED；不会把已完成操作变成普通失败。桥接响应体中断或格式无效返回 OUTCOME_UNKNOWN。
- 工作流延迟参数校验复用最多 128 个 AJV 编译结果，缓存键包括能力、排序后的字段和 schema；淘汰时同时释放 AJV 内部缓存。绑定后的最终参数仍完整验证。
- Creator 2 / 3 共用面板按节点增量更新，保留输入、焦点和滚动；日志使用进程 epoch 与递增游标，只传新增记录，仍保留最近 5000 条。主进程重启后重置日志，兼容旧主进程完整快照。隐藏面板暂停每 5 秒轮询，恢复可见后在下一轮刷新。

新增自动化用例验证取消、容量、过期、对账、原子读取、审计失败、DOM 身份、日志截断与缓存释放边界；面板使用 DOM 仿真环境，不能替代真实 Creator 2 / 3 的原生交互验收。

## 历史预览问题与验证

本次修复针对 Creator 3.8.8 火焰示例暴露的实际问题。原方案的体积采样成本属于特效实现问题，不能归因为 MCP 协议吞吐。性能采样仍是整帧墙钟时间，不是独立 Shader 的 GPU 时间。

## 2026-09-18 Creator 2.4.15 补充

后文保留 3.8.8 火焰样例的历史性能数据。2.4.15 独立验证了控件真实输入，以及碰撞/Tween/骨骼/Box 接触任务的取消和部分断连/切场景路径；各功能边界见 [版本矩阵](version-support.md) 和 [台账](creator2-expansion-tracker.md)，不能泛化为全部工具。

FrameSession 等待单帧超过 2000 ms 返回 CONTEXT_UNAVAILABLE，附 timeoutMs、gamePaused、directorPaused；无法读取时为 null，不自动 resume。2.4.15 原生暂停测试确认超时后仍暂停。一次现场 gamePaused=true 不足以推断窗口事件来源或解释所有历史超时。

异步任务通过 runtime.task.poll/stop 查询取消，30 秒截止、最多 4 个运行任务与 8 个保留记录；检查 dropped。清理失败保持 OUTCOME_UNKNOWN，不因取消而改为成功。2.x 专属任务不自动在 3.x 开放。

## 纹理与运行实例

- 材质纹理引用按公开的 `Texture2D`、`TextureCube`、`RenderTexture` 类型校验，兼容可用的 `TextureBase`，不再要求 `cc.TextureBase` 必须导出。`ImageAsset` 仍不能直接作为 sampler 纹理。
- 网关列表与执行使用相同的 30 秒存活判断。失效会话清理时，未回复操作返回 `OUTCOME_UNKNOWN`，不会自动重发写操作。
- 多个有效运行实例继续返回 `AMBIGUOUS_TARGET`。使用 `shader.preview.connect` 返回的 `runtimeInstanceId` 选择目标，不按“最新实例”猜测。
- `preview.stop` 会尝试断开运行桥，异常退出仍由过期清理兜底。回复必须属于发出命令的会话，其他会话不能完成该操作。
- 预览连接与截图等待实际引擎模块和场景就绪，兼容 Creator 的异步 `System.resolve()`；旧网关失联时，断开等待有明确上限。

## 首次键盘输入

`preview.input` 新增可选 `focusTarget: "game-canvas" | "window"`。键盘默认聚焦游戏 Canvas，其余输入默认沿用窗口焦点。

DOM 聚焦不合成业务点击。返回的 `focus` 包含焦点结果、Canvas CSS 矩形和 DPR；键盘输入的 `inputEvents` 为实际捕获的 DOM 事件。`businessOutcomeVerified` 仍为 `false`，调用者应通过运行状态回读确认暂停、攻击等业务结果。

## 有依赖的工作流

`cocos_workflow_plan` 和 `cocos_workflow_execute` 的步骤支持：

- `paramRefs`：将先前成功步骤的结果绑定到当前参数的顶层字段。
- `runtimeRef`：从先前步骤读取运行实例 ID，与显式 `runtimeInstanceId` 互斥。
- `waitFor`：仅对只读能力进行有界轮询。结果路径必须存在，值以 JSON 精确比较；不自动重试接口错误。

引用的 `step` 从 0 开始，`path` 相对于能力的 `result`，而不是执行响应外壳。禁止前向引用、原型路径、未知参数及同时提供参数值和该参数的引用。规划会标记 `deferredValidation`，绑定后的完整参数仍须在执行前通过能力 schema 校验。

```json
{
  "projectId": "<project-id>",
  "steps": [
    {"capabilityId": "shader.preview.connect", "params": {}},
    {
      "capabilityId": "runtime.get",
      "params": {"target": "component:<controller-id>", "path": "paused"},
      "runtimeRef": {"step": 0, "path": "runtimeInstanceId"},
      "waitFor": {"path": "value", "equals": false, "timeoutMs": 3000, "intervalMs": 100}
    }
  ]
}
```

例如先执行 `asset.location`，后续步骤可用 `paramRefs: {"url":{"step":0,"path":"url"}}` 复用实际资源路径。资源导入就绪可通过只读 `asset.info` 的实际返回路径设置等待条件。默认等待 10 秒、间隔 200 ms，上限 30 秒；单次请求受同一截止时间约束。轮询不会命中 `operationId` 的历史结果缓存。

执行前持久化当前步骤及操作 ID。失败时保留成功步骤、失败操作 ID 和恢复提示。同一 `workflowId` 不得重复执行或覆盖历史状态。恢复时先调用 `cocos_workflow_status` / `cocos_operation_query` 并核对资源，再创建只包含剩余步骤的新工作流；不要重放状态未知的写操作。这里没有通用事务回滚或自动续跑。

## 性能预算

### 构建历史持久化

临时目录使用当前进程持有的所有权凭据，标记包含任务 ID、PID、用途、UTC 创建/结束时间和保留原因。测试入口与 Creator 构建入口已接入：仅成功、同一目录身份/标记且 `lsof` 没有观察到打开引用时，回收本次可再生文件。检查工具缺失、超时或警告时保留；失败、取消、未知或被替换目录保留。历史标记和复用的 PID 不能生成清理授权，外部不能用旧 JSON 恢复一次清理凭据。

Creator 构建成功后只回收临时 CLI 配置副本；复现所需配置保存在 `.codex-work/logs/builds/<jobId>.config.json`，构建产物、日志、账号目录和历史完整记录继续保留。清理失败不改变已确认的构建结果。普通命令入口仅尝试回收自己创建的空目录，无法判定用途的非空目录继续保留。

执行 `node scripts/project-env.mjs node scripts/storage-inventory.mjs` 生成只读 JSON/Markdown 清单，列出路径、逻辑/分配字节、任务/PID/用途/时间、观察状态和保留理由；不会跟随符号链接，也没有历史删除入口。扫描预算耗尽或读失败标记不完整，PID 存在仅是观察结果，不能证明进程身份。最新本机快照位于 `.codex-work/artifacts/storage-inventory/2026-10-29T11-43-44-195Z/REPORT.md`：673 个条目、91985 个文件系统条目被检查，没有不完整行。逻辑大小约 tmp 6.629 GiB、build 2.206 GiB，主要是既有临时/构建内容；本次保留并复用现有资源，没有清理历史。大小之和不能换算为可释放物理空间。

构建状态按任务写入 `.codex-work/cache/cocos-mcp/build-history/<UUID 前两位>/<jobId>.json` 小索引。完整记录位于 `.codex-work/logs/build-history/<jobId>/<SHA256>.json`；索引不保存大错误正文，分别校验摘要和完整记录摘要。先持久化完整记录，再原子提交引用，同一任务的写入按调用顺序串行。提交前失败只留下未引用记录，提交后失去确认则以重启后的索引为准，不能推断写入没有发生。

旧 `build-jobs.json` 保持原位、原内容并兼容读取；同任务的新索引优先。新写入不再扩张这个 16 MiB / 10000 条的旧文件，也不会重写其他任务。启动加载任务摘要，查询详情才读取完整记录；历史大错误不会因查询永久加入内存索引。列表仍兼容原返回格式，完整结果可能较大，当前不是无限容量或分页接口。

运行中任务重启后仍按派发标记转为失败或未知，活跃 PID、未知恢复状态、operationId 和请求摘要持续保留。已完成操作可重放，换参数仍冲突，不会再次启动 Creator。完整记录、未引用记录和旧索引均属于恢复/审计材料，本次不按 TTL 删除。旧版本服务不认识新索引，因此带活动或未知构建时不得直接回退旧服务；应先用新版完成状态核对和恢复。

自动回归包含超过 16 MiB 的分离历史、旧文件不变、单任务更新隔离、提交前后故障、同任务并发顺序、内容/索引损坏、重启防重放及服务活动 PID 保护。这些使用独立文件夹和模拟构建进程，不等同于 Creator 原生构建验收。

### 请求阶段计时与发现基准

操作返回的 `timings` 区分 `queue`、`editor-discovery`、`editor-rpc`、`runtime-dispatch`、`evidence-write` 和审计阶段；每行包含阶段名、毫秒耗时和调用次数，不含请求正文或凭据。终态审计保留写入前的快照，返回值才包含 `audit-terminal`。同操作 ID 的重放结果不是一次新的性能采样。

新桥接额外返回 `nativeTimings`：原生执行前后的 revision、意图/完成账本写入、`native-execution` 和输出校验分别计时。HTTP `Server-Timing` 中的 `cocos-json` 记录原生回复 JSON 编码时间，由客户端归入 `response-serialization`，不包含网络发送或 MCP SDK 最后的线协议编码。`editor-rpc` 包含网络与原生处理，是外层总时段，不能与内层 `nativeTimings` 相加。旧桥接缺少这些可选字段时保持兼容；无效附加计时会被忽略，不会把已确认成功的写入变成未知状态。

统一客户端在标准 MCP `_meta["io.cocos-mcp/client-timings"]` 返回本次调用的阶段行，包括 `workspace-resolution`、`authorization`、`service-connect`、`editor-discovery`、`authorization-recheck`、`editor-selection`、`service-identity`、`backend-rpc`。仅记录本次实际经过的阶段：显式 projectId 不需要重新解析工作区，已认证快照选择也不增加一次发现。工作区解析包含候选路径与准入解析，授权阶段针对选中的工程，服务连接阶段可能包含冷启动；不要将它们当作纯文件 I/O 或纯网络时间。抛出的对象型错误 details 带 `clientTimings`，原有非对象 details 保持原形。后端正文、图片、业务错误以及已有 `_meta` 不被改写，计时不在请求之间共享。

自动工程连接复用本次已认证候选来选择实例，后端执行仍独立核验身份。并发发现只共享在途认证，不缓存终态；显式实例按第一方桥接的 instanceId.json 规则直接读取目标，不枚举无关描述符；文件名不能代替内部身份、工程、PID、端点和实时认证检查。

可从仓库根复现实例发现基准：

```sh
node scripts/project-env.mjs node --input-type=module -e 'import {build} from "esbuild"; await build({entryPoints:["scripts/discovery-benchmark.ts"],outfile:".codex-work/build/benchmarks/discovery.mjs",bundle:true,platform:"node",format:"esm",target:"node24"});'
node scripts/project-env.mjs node .codex-work/build/benchmarks/discovery.mjs
```

脚本使用真实回环 HTTP 和合成身份，包含 16 份描述符（8 个有效、8 个失效 PID 身份），每个回复注入 3 ms 延迟。2026-10-29 macOS ARM64 / Node 24.21.0 的结果如下；不代表 Creator 原生执行性能：

| 场景 | 样本数 | P50 / P95（ms） | 每组调用 / 认证次数 |
| --- | --- | --- | --- |
| 首次完整发现 | 1 | 42.00 / 42.00 | 1 / 16 |
| 后续完整发现 | 10 | 21.05 / 23.65 | 1 / 16 |
| 并发完整发现 | 10 | 21.32 / 22.99 | 10 / 16 |
| 显式实例 | 10 | 4.23 / 4.57 | 1 / 1 |

所有组的认证并发不超过 4；多实例歧义拒绝，身份失效后重新认证并拒绝旧实例。报告保存在 `.codex-work/artifacts/discovery-benchmark/2026-10-29T11-18-49-087Z/REPORT.json`；重新运行使用独立时间目录。成功后仅清理本次合成 fixture，失败时保留诊断现场。这里的“后续”指本机文件/HTTP 热身，认证本身未缓存，也不是与历史源码的耗时对照。

### 资源扫描与摘要预算

资源整理将范围内候选枚举与可复用类型目录查找分开。目录查找优先最浅层，范围枚举尊重 `scopeUrl`、`recursive` 和显式 `urls`，受保护目录只返回跳过摘要。单次候选最多 2000 个、扫描条目最多 50000 个，摘要内容总预算 1 GiB；超过预算需要缩小计划，不能省略 `planHash`、UUID 或内容复核。

元数据最多 1 MiB，glTF 依赖检查最多 16 MiB。文件通过同一个打开的句柄每次读取至多 64 KiB，并核对读取前后文件身份、大小、修改时间及最终路径；增长、原位修改、路径替换和元数据变化均拒绝形成可执行计划。glTF 依赖审查的摘要还必须与最终候选摘要相同。检查不能替代跨文件事务，因此 apply 仍重新规划及逐项验证。

复现只读扫描基准：

```sh
node scripts/project-env.mjs node --input-type=module -e 'import {build} from "esbuild"; await build({entryPoints:["scripts/asset-scan-benchmark.ts"],outfile:".codex-work/build/benchmarks/asset-scan.mjs",bundle:true,platform:"node",format:"esm",target:"node24"});'
node scripts/project-env.mjs node .codex-work/build/benchmarks/asset-scan.mjs
```

2026-10-29 macOS ARM64 / Node 24.21.0，存在 5001 个无关文件时，12 个 64 KiB 资源的范围计划 5 次样本 P50/P95 为 19.95/33.71 ms；显式指定一个 128 MiB 资源为 108.55/111.09 ms。范围计划成功，全树递归仍按原契约拒绝超过 2000 个候选。原始报告：`.codex-work/artifacts/asset-scan-benchmark/2026-10-29T11-24-12-055Z/REPORT.json`。这是独立文件系统夹具，不是 Creator 导入或 AssetDB 性能；没有清除系统缓存或与旧实现作耗时对照。RSS 为整个进程的 5 ms 采样值，不能当作硬峰值或单次分配量。成功仅清理本次夹具，失败保留现场。

### Shader 帧性能

```json
{"frames":120,"warmupFrames":10,"maxFrameMs":20}
```

`runtime.shader.profile` 默认预热 10 帧，可设置 1–120 帧，采样 2–300 帧。新增 `estimatedFps`、`p99Ms`、`maxMs`、`viewport`、`budget` 和 `warnings`。

`viewport` 分别记录 Canvas 内部像素尺寸、CSS 尺寸与 DPR；这些值不等于窗口截图尺寸。预算按 P95 判断，同时报告超预算帧数。未提供预算时 `budget=null`；`gpuMs` 仍为 `null`，不模拟不可用的 GPU 计时。

建议先以低复杂度材质测量，再逐步增加层数、粒子或渲染分辨率，并在同一设备、内部渲染尺寸及场景条件下比较。质量档位由效果自身控制，MCP 不会擅自修改画质或场景参数来让测试通过。

## 验证

自动化回归覆盖公开纹理类型、失效实例清理、真实多实例歧义、跨会话回复拒绝、首次按键焦点、结果引用、只读轮询、重复工作流保护、失败检查点与性能预算。原生验证使用已有火焰测试场景，通过标准 MCP 客户端调用。

2026-09-16 本机验收结果：

- `pnpm check`：类型检查、构建和 181 项测试全部通过。
- Creator 3.8.8：纹理通过 `material.update` 保存，`material.query` 回读纹理 UUID 一致，场景重新打开后可连接预览。
- 首次 Space 无需预先点击，收到真实键盘事件，`paused` 状态回读改变，随后恢复。
- MCP 工作流引用连接返回的运行实例 ID，读取等待条件成功；关闭并重启预览后，仅有一个有效运行实例。
- 120 帧、预热 10 帧：均值 16.66 ms、P95 17.80 ms、P99 22.70 ms，20 ms 的 P95 预算通过；4 帧超过 20 ms。
- 采样时内部 Canvas 为 2560×1346，CSS 为 1280×672.76，DPR=2。这是本机当前场景的数据，不是移动设备或独立 GPU 时间验收。

本地完整证据保留在 `.codex-work/logs/fire-fixes-check.log`、`fire-fixes-native.json` 和 `fire-fixes-texture-native.json`，运行日志不纳入提交。
