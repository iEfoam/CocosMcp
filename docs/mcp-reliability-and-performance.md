# MCP 预览可靠性与性能工作流

## 安装、预览与审计优化（2026-10-08）

源码实现、自动化桩测试、原生 Creator 验收及真实业务验收分别记录。本节不提升历史原生报告的适用范围。最新源码 333 项自动测试通过；原生 Creator 2 为 14/14、Creator 3 为 12/14，两个未通过项不借用此前源码的全通过结论。精确指纹、CP-001～013 对照及完整调用方式见 [预览验收指南](preview-acceptance.md)。

### 完整包和旧版本升级

Creator 2/3 必需文件均包含 `dist/runtime.js`；构建写入 `package.json.fileHashes`。本地安装在备份旧目录前及 staging 复制后分别检查必需文件，拒绝缺失、空文件、符号链接及摘要不一致。GitHub 更新保留固定来源、下载包 SHA-256、白名单和整目录备份替换，同版本也检查运行文件。旧包缺摘要时为 unknown。

`editor.status.extension` 和控制中心返回 runningBuildId、installedBuildId、reloadRequired、integrity.health 及逐文件 rows。面板轮询复查文件元信息，发生变化才重算摘要；安装/更新执行完整摘要检查。磁盘健康不能证明已经重载或 runtime 握手成功。

Creator 2 旧更新器的七文件白名单不能接收新完整包。首次升级使用已有本地安装器或同版本 ZIP 整目录安装，保留 `backupPath` 后重载；回滚恢复整个旧目录。不能继续发布缺 runtime 的七文件包，也不能手工混入未知版本 runtime。详见 [打包说明](extension-packaging.md)。

### 场景、帧和截图

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

operations.jsonl 同时记录编辑器、runtime、失败及权限拒绝的开始/终态、UTC 时间、耗时、context、effect 和副作用状态。请求仅存 SHA-256 指纹；源码、响应正文、密码、token、签名和图片 Base64 不写入通用账本。开始/终态是两条事件，不等同于两次工具执行。

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

`scripts/open-creator.mjs` 优先核对本工程的存活编辑器及认证 bridge.identity；已有实例直接复用。Creator 3 沿用固定 `.codex-work/cache/creator-home`，首次缺凭据时只复用本机原生会话文件，目录权限 0700、文件 0600，已有工程凭据不覆盖。Creator 2 沿用已登录 Dashboard 的工程入口；直接启动无法继承认证时明确拒绝，不再另开登录窗口。日志和返回值不包含会话密钥。凭据过期或被官方撤销仍需用户正常更新。

发现编辑器时同时核对认证身份和进程，不只依赖历史 PID 存活；系统 PID 复用不能制造假多实例。启动器扫描全部有效候选后优先复用已认证实例。旧桥接缺少身份入口时，使用原有认证 describe 检查版本和能力，保持旧版发现兼容；真实多个编辑器仍须明确 instanceId。

## 服务可靠性与面板优化（2026-09-22）

- 显式 operationId 的指纹、执行中请求、成功结果和错误统一保存在最多 2048 条记录中。确认终态保留 30 分钟（单调时钟计时），容量压力下先淘汰终态；相同 ID / 参数共享请求与结果，不同参数返回 OPERATION_CONFLICT。已确认失败在保留期内也返回原错误。
- 执行中和 OUTCOME_UNKNOWN 不自动过期或淘汰。全部记录均受保护时，新请求返回 RESOURCE_BUSY。编辑器操作可通过 cocos_operation_query 向最初实例读取账本，确认终态后恢复正常保留策略；查询失败或 NOT_FOUND 不解除保护。运行时未知操作尚无自动对账机制，需人工核对运行状态。内存记录不跨服务重启，不能把 TTL 当成重复写入许可。
- 每个工程保持串行执行，最多等待 128 个请求，排队超过 30 秒返回 TIMEOUT；尚未执行的取消立即移除并释放容量。执行后的取消由桥接报告是否结果未知；不会以超时为由提前释放正在执行的写任务。不同工程相互独立，状态查询沿用队列外通道。
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
