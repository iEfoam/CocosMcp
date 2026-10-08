# 外部预览、刷新与诊断

## 当前交付边界（2026-10-08）

本次复用 `PreviewService`、`ManagedPreview`、`PreviewDiagnostics`、工程路径策略和现有工作流，不另行启动预览服务或 Chrome 调试服务器。

| 能力 | Creator 2.4.15 | Creator 3.8.8 |
| --- | --- | --- |
| `preview.start` 的 `embedded` 默认值 | 保持兼容 | 保持兼容 |
| `external-browser` 服务发现与连接器协议 | 服务就绪有历史原生记录；Chrome 端到端未验证 | 协议已实现；Chrome 端到端未验证 |
| AssetDB 导入回调、异步状态和取消 | 本轮原生导入/刷新；取消/超时经适配器测试 | 本轮原生导入/刷新；取消/超时经适配器测试 |
| 普通 JS/TS 的原生编译确认 | JS 编译、source map 与实际加载摘要已实测；TS 未单独原生验证 | TS 原生编译、source map/chunk 与实际加载摘要已实测 |
| 图片、Prefab、场景 importer / 加载证据 | 图片/Prefab completed；场景运行层级读回，字节证明不足时 unknown | 图片/Prefab/场景字节匹配 completed |
| HTTP/WS/Console 诊断与脱敏 | 共享实现和自动化测试 | 共享实现和自动化测试 |
| 外部 Chrome 页面控制、加载字节证明、截图 | **依赖外部连接器，当前未配置，也未提供其浏览器驱动实现** | 同左 |
| `runtime.ui.select/check/click` | embedded 唯一节点和真实点击后态实测；Mask 无法证明时拒绝 | embedded 唯一节点和真实点击后态实测 |
| external-browser 输入与运行时连接 | 已有受控客户端协议；依赖连接器驱动，未原生验收 | 同左；不能借用 embedded 的结论 |

当前没有完整外部 Chrome MCP 端到端验收。embedded 两版在独立合成工程通过各 14 项检查，详细结果和复现方式见 [预览验收指南](preview-acceptance.md)。不能把“编译完成”、原生 Electron 检查或 UI 工具取得的 Chrome 图片当作 MCP 外部连接器已加载新代码。

## 外部预览

通过现有 `cocos_execute` 或对应 capability 工具执行：

```json
{
  "capabilityId": "preview.start",
  "params": {
    "target": "external-browser",
    "browser": "chrome",
    "scene": "current",
    "reuseExisting": true
  }
}
```

`scene` 可以省略，或传当前已保存场景的 UUID；不会自动切换或保存场景。服务地址从当前 Creator 实例获取。默认 `target: embedded` 保留旧调用行为。

结果区分 `launchSceneId`、`currentSceneId`、`sceneGeneration` 和 `runtimeInstanceId`，并包含 `target`、`url`、`sceneId`、`sessionId`、`tabId`、`owned`、`connection`、`pageReady`、`gameReady` 和 `status`。`service-ready` 只代表实际预览 HTTP 服务响应成功；`page-opened` 和 `game-ready` 必须由连接器实时证明。没有连接器时不会打开 Electron 窗口冒充 Chrome。

`preview.status`、`preview.stop`、`preview.capture`、`preview.logs` 和新诊断能力接受 `target`。省略时使用最近选择的目标。`start` 省略 target 始终使用兼容默认值 `embedded`。

重复启动同一场景复用会话；已有会话切换场景返回 `RESOURCE_BUSY`。停止外部会话时仅关闭连接器证明是本会话创建的标签页；复用的用户标签页只解除连接。连接中断时停止可能失败，必须先重新确认归属，不能扩大到关闭整个 Chrome。

## 刷新和版本证明

```json
{"capabilityId":"preview.refresh","params":{"urls":["db://assets/Scripts/Example.js"],"timeoutMs":30000,"reload":true}}
```

立即返回刷新 `operationId`，后续执行：

```json
{"capabilityId":"preview.refresh.status","params":{"operationId":"<刷新返回的 ID>"}}
```

这是 capability 参数中的刷新句柄，区别于外层 MCP 请求的幂等 operationId。句柄仅在当前编辑器扩展实例中有效，重载后返回 `NOT_FOUND`。最多保留 100 个刷新记录。

阶段规则：

1. 检查资源路径、符号链接和大小；计算指定文件的 SHA-256。
2. 等待每次 AssetDB `refresh` 的原生回调；再次比较源文件，拒绝导入期间的修改。
3. 2.4.15 在调用 `ProjectCompiler.compileScripts()` **之前**检查 `errorScripts`。原生方法会清除错误，若先调用可能把旧导入文件重新打包成假成功。
4. 2.4.15 等待原生 Promise 后继续核对实际模块 inline source map 的 `sourcesContent` 摘要和产物稳定状态，避免 extern map 已更新而 JS 仍旧的竞态。3.8.8 等待 programming 完成信号，核对 source map/chunk。插件脚本及缺可信 source map 的情况返回 `unknown`。
5. 图片/Prefab/场景采用 AssetDB 原生 library/subAssets 清单及 UUID。普通脚本采用原生 bundle/chunk/模块摘要；所有预期产物的排序清单摘要是 `expectedRevision`，不是时间戳。未知 importer、未加载子资源和未覆盖的传递依赖保持 unknown。
6. 仅在编译完成且 `reload: true` 时重载所选目标。embedded 使用自有窗口和 CDP，不依赖 Chrome；external-browser 调用工程连接器。必须从本次导航正确 frame/loader 实际加载的字节取得摘要，返回新 `navigationId`、清单和绘制就绪状态。仅回显 `loadedRevision`、在 URL 拼接 revision 或注入变量不会被接受。
7. 完成版本匹配且游戏就绪后才返回 `completed`；缺少连接器或无法证明版本时返回 `unknown`，摘要不同则失败。`reload:false` 仍保留编译证据，整个浏览器链路不算完成。

`preview.refresh.cancel` 使用相同刷新句柄。取消和超时阻止后续阶段；不能撤销已经交给 AssetDB 的导入。`nativePending: true` 时禁止开始另一次刷新，防止迟到回调污染后续操作；原生回调返回后会变为 false。不会用固定等待代替原生完成信号。

原生编译器自己的 `library`、`temp/quick-scripts` 是 Creator 内部产物，MCP 不自行搬动这些文件。MCP 的报告、缓存与日志通过 `.codex-work/` 路径策略保存。

## 外部浏览器连接器协议 v1

当前程序化浏览器能力与 Codex UI 浏览器工具是不同边界。UI 工具能打开标签页和截图，但本工程没有可直接调用其 Console/CDP/脚本执行能力的服务端 API。为避免复制浏览器基础设施，这里提供可执行的 HTTP 客户端与接口，浏览器驱动由现有连接器提供。

连接器在本工程写入 `.codex-work/cache/cocos-mcp/browser-connector.json`，权限建议 `0600`：

```json
{
  "protocolVersion": 1,
  "projectPath": "<规范化工程绝对路径>",
  "endpoint": "http://127.0.0.1:<连接器端口>/preview",
  "token": "<至少32字符的随机凭证>"
}
```

这是可选依赖的配置示例，不代表仓库已提供该端点服务。仅允许回环 HTTP，无重定向、URL 凭证和 query。MCP 使用 Bearer 认证，不在参数、结果或日志中暴露 token；请求和响应均核对规范化工程路径。

请求 envelope：

```json
{
  "protocolVersion":1,
  "projectPath":"<工程绝对路径>",
  "method":"start",
  "params":{"sessionId":"<MCP会话ID>","url":"<Creator实际预览URL>","sceneId":"<UUID>","tabId":null,"browser":"chrome","reuseExisting":true,"ownership":"close-only-created-tab"}
}
```

响应 envelope：

```json
{
  "protocolVersion":1,
  "projectPath":"<相同工程绝对路径>",
  "result":{"sessionId":"<相同会话ID>","url":"<实际标签页URL>","tabId":"<实际标签页ID>","owned":false,"connection":"connected","pageOpened":true,"gameReady":false}
}
```

支持的方法与义务：

| 方法 | 连接器必须执行的检查与返回 |
| --- | --- |
| `start` | 按精确项目 URL/scene 复用标签页；同一 sessionId 幂等；只有新建标签页才返回 owned=true；不得使用内置模拟器 |
| `status` | 实时检查浏览器连接、目标标签页、URL 与引擎场景；断连立即返回 disconnected，不复用旧成功快照 |
| `stop` | closeTab=false 只解除采集；closeTab=true 也须复核创建者；返回停止前的会话绑定信息 |
| `reload` | 先监听导航、网络和脚本事件，再刷新；仅采集指定 tab/frame/loader；返回 evidence=`loaded-script-bytes` 或 `loaded-artifact-bytes`、新 navigationId、artifacts 和 gameReady；expectedRevision 回显不是证明 |
| `capture` | 等待目标场景实际绘制；返回工程内相对 path，如 `.codex-work/logs/preview/frame.png`；不得返回系统临时路径 |
| `resize` | 修改指定自有标签页视口，读回实际尺寸/场景/帧；可返回同样受守卫的 PNG 路径，不改变其他标签页 |
| `input` | 发送前核对归属和严格期待，发送真实输入；返回投递证据和后态，响应中断为 OUTCOME_UNKNOWN/inputSent=null，不自动重放 |
| `connect-runtime` | 仅把 MCP 生成的开发桥接与本工程回环网关配置接入当前受控页面，返回实际 runtime 身份，不写正式资源 |
| `logs`, `network`, `websocket` | 返回 rows、nextCursor、hasMore、droppedBefore；按 session 和时间窗口隔离；不收集其他标签页 |

每次调用携带并核对 sessionId、tabId 和精确 URL，严格期待使用 expectedSceneId/expectedGeneration/expectedRuntimeInstanceId；启动 sceneId 与当前场景分开，合法切场景不误判为旧页面。响应须报告实际 currentSceneId、sceneGeneration、frameIndex 和 runtimeInstanceId。浏览器导航到其他工程后拒绝后续操作。broker 请求超时 15 秒、响应上限 8 MiB。连接器必须在副作用之前检查页面归属；MCP 的返回值校验不能补救已经向错误页面发送的动作。

截图只接受工程 `.codex-work/` 内的有限 regular PNG，最大 32 MiB；客户端核验 PNG 签名、IHDR 尺寸和 SHA-256 后交付图片。配置及截图路径仍通过工程 containment/symlink 守卫。external-browser 未提供可强制执行的 fixture 网络隔离，带 fixtureId 的启动会拒绝。

## 诊断、安全和错误契约

`preview.logs` 支持 level、kind、contains、cursor、limit；`preview.network` 和 `preview.websocket` 返回分类记录；`preview.diagnose` 返回关联时间线和 findings。`from`、`to` 接受带时区的 ISO 时间，按 `[from,to)` 过滤，输出为 UTC `Z`。外部连接器负责同样的过滤与游标语义。

保留最多 2000 条、约 8 MiB 的受限文本；单次最多 500 条，返回 `hasMore`、`nextCursor` 和 `droppedBefore`。HTTP 耗时是请求到响应头的时间，不是完整下载耗时。只认浏览器明确的 corsErrorStatus，不把 `ERR_FAILED` 自动解释为 CORS。

WebSocket 默认只保留连接状态、101 握手响应、帧方向、类型、长度和可观察的关闭码；不输出文本正文或二进制 Base64。`Network.webSocketClosed` 没有关闭码时不编造数值。未看到收到帧只报告当前观察区间无响应，不据此推断 Pomelo/JSON 兼容性，也不声称应用层握手已经超时。

请求头与正文默认不采集，因此不泄露其中的 Authorization、Cookie、JSON 或表单密码。日志在入库和读回时过滤密码、Token、签名、Cookie、Authorization、API key、带凭证 URL 与常见凭证格式。外部事件使用字段白名单，再脱敏。无法可靠识别没有字段上下文的任意秘密字符串；此限制必须保留，不能宣称所有任意日志文本都绝对安全。

| 错误/状态 | 行为 |
| --- | --- |
| `INVALID_ARGUMENT` | 非法目标、时间范围、大小或资源参数；不执行动作 |
| `UNAUTHORIZED` / `PATH_OUTSIDE_PROJECT` | 非回环连接、身份不匹配或路径逃逸；拒绝 |
| `RESOURCE_BUSY` | 目标场景冲突或原生导入尚未退出；不自动重试 |
| `STALE_HANDLE` / `STALE_REVISION` | 页面归属或源码变化；保留现场 |
| `CONTEXT_UNAVAILABLE` | 编辑器/浏览器连接缺失；不返回陈旧成功 |
| 刷新 `failed` | 保留失败阶段与资源/行列错误；不继续刷新或重复提交 |
| 刷新 `unknown` | 证据不足，包括缺失编译适配器/浏览器加载证明 |
| 刷新 `timeout` / `cancelled` | 停止后续阶段，明确原生工作可能仍在完成 |

## 组合验收与剩余边界

复用现有 `cocos_workflow_*` 的 paramRefs、waitFor、持久化步骤和失败停止，不另建工作流调度器。推荐顺序：`preview.start(external-browser)` → `preview.refresh` → 轮询 `preview.refresh.status`（同时检查失败终态）→ 检查 `revisionMatched` → 浏览器操作 → 预期状态 → `preview.capture` → `preview.diagnose`。失败或 unknown 立即保留现场，不重复点击。

`runtime.ui.select/check/click` 已复用开发运行时桥接；`node.*` 仍仅操作编辑器场景。embedded 点击核对唯一节点、active/按钮/相机/可见/遮罩与命中候选，通过原生输入并独立检查 after；不直接调用业务回调。输入法、真实设备与外部 Chrome 接收者仍需专项验证。Creator 2 的 EditBox 语义操作复用 runtime.control.text，不能把程序赋值等同于键盘/输入法事件。声明式配方与夹具的操作、取消及清理见 [预览验收指南](preview-acceptance.md)。

## 本次验收证据（2026-09-22）

原生记录：`.codex-work/logs/external-preview-native-acceptance.json`。使用仓库**已有**的 Creator 2 测试工程；通过 `asset.location` 复用 Scripts 目录；测试语法错误已在 finally 中恢复。没有业务登录、账户或资金请求。启动时错误地选用了隔离用户数据目录，造成重复登录提示；收到用户纠正后停止启动该实例，后续须复用用户现有登录环境。

| 用例 | 结果 |
| --- | --- |
| 外部预览 | 原生仅服务就绪分支通过，没有宣称 Chrome 已打开；Chrome 自动控制待连接器 |
| 版本生效 | 原生导入/编译/source map/产物摘要通过；浏览器可见文本和 loadedRevision 未验证 |
| 编译错误 | 原生准确停在 compile，返回测试资源第 1 行第 32 列；恢复后 compile completed |
| HTTP 与 CORS | 自动化 CDP 事件测试通过；真实 Chrome 采集未验证 |
| WebSocket 无响应 | 帧摘要与无响应证据分类测试通过；业务握手超时未实现 |
| Canvas 节点交互 | 未实现，未宣称验收通过 |
| 生命周期 | 连接器替身测试验证复用、归属和只关闭自有标签页；真实浏览器未验证 |
| 断连恢复 | 断连清空成功状态、导航漂移拒绝测试通过；刷新句柄重启后失效 |
| 敏感信息 | JSON、表单、日志、请求头省略和二进制不留存测试通过；无字段上下文秘密的限制见上 |

本次浏览器工具的内部运行文件曾出现在系统临时目录，用户随后仅对此次不可控内部文件明确授权例外；MCP 可控的输出仍位于项目 `.codex-work/`。没有把 UI 工具内部行为描述成已符合全部文件路径规则。

### 指定工程安装验证

用户更换目标后，构建 `89c220026304` 安装到 `/Users/hao/Work/Code/Go/src/dzpk-ys/card-game-client/packages/cocos-mcp-creator2`。复用正在运行的 Creator 2.4.15，通过原生 Package.load 加载扩展，没有重启编辑器或切换用户数据目录。控制中心显示该构建、桥接已启动和 MCP 服务已启动；编辑器状态接口返回目标工程及未修改的 pdk 场景，MCP initialize 返回 HTTP 200。此次动态分配地址为 `http://127.0.0.1:55161/mcp`，不应作为固定配置写入代码。脱敏记录位于 `.codex-work/logs/card-game-client-installation.json`。

本次最终自动化测试为 280/280 通过，构建通过；该安装验证不等于外部 Chrome 或游戏业务验收，剩余边界仍以表格为准。
