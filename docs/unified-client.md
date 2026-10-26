# 共享本机客户端服务与多工程连接

全局配置一个客户端接入点，工程工具直接传入会话 `workspacePath`，按工程真实路径自动发现、连接或启动本机后端；保留 `cocos_project_connect` 兼容入口。支持轻量 stdio 桥接和直接连接共享 HTTP 服务。新增游戏工程无需修改 TOML，也无需把端口或 token 发给 AI。

## 安装和配置

需要独立 Node.js 24+ 和仓库固定版本 pnpm。源码安装：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm client:install
```

`client:install` 新安装默认 `allowedRoots: []`，使用“用户主动安装插件，即授权该工程”。先安装统一客户端，再通过源码 CLI 或控制中心更新安装对应 Creator 插件：安装器将真实工程路径和已校验的插件身份登记到客户端 `authorized-projects.json`。工程可位于任意目录，不需要逐个修改 TOML 或目录白名单。

手动复制/ZIP 安装不会自动扩大权限：在 Creator 控制中心选择“统一 stdio（多工程）”，点击“授权当前工程”一次。普通插件加载、面板刷新与工程自带配置均不会自动授予访问权限；移除插件或校验文件变化会拒绝原授权，可在控制中心取消或重新授权。客户端不会扫描磁盘寻找工程。

已有用户明确配置的 `allowedRoots` 保持兼容；确需父目录授权时可重复指定 `--allowed-root`（只初始化新安装），目录必须存在：

```sh
node .codex-work/build/client/install.mjs \
  --workspace /absolute/path/to/CocosMcp \
  --allowed-root /absolute/path/to/games
```

离线包 `cocos-mcp-client.zip` 包含 launcher、router、router-daemon、session、connector、worker、install、LICENSE 和 manifest。先核验同版 SHA256SUMS，解压到工作区 `.codex-work/downloads/`，再使用包内 `install.mjs` 执行同样命令。安装和运行无需 node_modules、源码或下载依赖；AI 模型联网要求另行判断。

安装器输出完整 `configuration`，也可在新版 Creator 面板选择“统一 stdio（多工程）→ 复制 Codex 配置”。将它合并到 `~/.codex/config.toml`，保留其他设置。配置引用固定 launcher，不包含游戏路径、端口或 Bearer token：

```toml
[mcp_servers.cocos_unified]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/CocosMcp/.codex-work/artifacts/cocos-client/launcher.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

实际使用安装器生成的完整配置，包含工作区内 TMP、缓存和 UTC 环境。配置和初始化 instructions 的行为依据 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。保存后重新加载客户端 MCP；安装完成不能代替真实工具调用验证，当前会话是否立即刷新由客户端决定。

### 共享 HTTP 与轻量兼容入口

保留现有 command/args 配置时，每个新聊天只有轻量 Node 字节桥接进程，经本机 HTTP 长连接转发到共享路由服务。桥接不加载 MCP SDK、能力目录、应用执行器或 Creator 适配器。路由服务在首条连接时加载 SDK 和工具声明，首次工具/资源路由才加载工程连接器；参数校验器在对应能力首次执行时编译。列工具不会启动游戏工程后端。

同一安装版本复用一个路由进程，内部为每个会话分别创建 SDK 连接、工程表、默认工作区、请求/进度标识及取消状态。相同请求 ID 在不同会话中互不影响。同项目继续复用原来的共享工程后端，不合并两个会话的连接器。关闭一个会话只释放它自己的租约，后台构建和运行时工作仍由独立工程后端保护。

如果希望完全取消每聊天的桥接进程，先使用已安装且校验通过的入口运行常驻服务，选用未占用的固定端口，例如：

```sh
node /absolute/path/to/CocosMcp/.codex-work/artifacts/cocos-client/launcher.mjs --serve --port 3039
```

服务只监听 `127.0.0.1`。端口占用、同版本服务已在运行或现有身份无法核实，均拒绝抢占；不要结束其他聊天的服务来腾端口。`--serve` 在前台持有监听，收到退出信号时排空会话并释放身份锁；应由用户选择的本机进程管理方式托管。此命令本身不安装 LaunchAgent，也不修改 Codex 配置。

核实服务身份后，把本地 token 安全注入客户端宿主的 `COCOS_ROUTER_TOKEN` 环境变量，再将目标表切换为：

```toml
[mcp_servers.cocos_unified]
url = "http://127.0.0.1:3039/mcp"
bearer_token_env_var = "COCOS_ROUTER_TOKEN"
enabled = true
startup_timeout_sec = 20
tool_timeout_sec = 120
```

HTTP 的 `url` 和 Bearer 环境变量配置依据同一份 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。桌面宿主必须实际继承该变量，不能把仅在终端中 export 成功当作桌面认证完成。不要将 stdio 的 command、args 或旧 env 子表与 HTTP 表混用。此处不输出 token；它位于工作区 `.codex-work/cache/cocos-router/<buildId>/.codex-work/cache/cocos-mcp/mcp-http-token`，权限为 `0600`。

标准 `/mcp` 提供有状态的 2025 系列 Streamable HTTP 协议，通过随机 `Mcp-Session-Id` 隔离聊天，支持 POST、GET/SSE 和 DELETE。直接 HTTP 客户端应正常初始化并保存会话 ID；关闭时发送 DELETE。未知会话返回 404，须新建连接并查询原操作状态，写请求不能自动重放。兼容 stdio 长连接沿用 SDK 的双时代协商；直接 HTTP 不宣称支持无状态的 2026 协议。工具名称、参数 Schema、图片、结构化结果、资源和提示词沿用同一工厂。

直接 HTTP 不从共享进程环境推断聊天工作区；通常在工具参数中传 `workspacePath`/`projectPath`。受控宿主可以在初始化时发送 UTF-8 绝对路径的标准 Base64 编码 `X-Cocos-Workspace`，它只属于本次会话，仍须通过工程授权。更换请求 Header 不会改变已经初始化的会话默认目标。

回环检查之外还要求 Bearer 认证，并拒绝浏览器 Origin。发现文件包含 PID、serviceId、工作区和启动身份；使用已有的跨进程锁与认证 identity 校验实现启动防重，不靠 PID/端口猜测。状态文件按安装版本隔离；升级后的新服务与旧会话可以并存，不批量终止旧进程。

自动启动的路由服务仅在没有任何仍保留的会话、初始化、工具调用和资源读取时，经过策略的 `idleExitSeconds` 后退出；下一次兼容入口可重新发现并启动。仍被宿主持有的 stdio 长连接永远不会因闲置超时被结束。原生 HTTP 会话保留至显式 DELETE，不因 GET/SSE 断开就猜测聊天结束；未正常释放的 HTTP 会话需要宿主恢复连接并关闭，或由用户安排服务维护。`--serve` 模式保留空闲监听，避免直接 URL 失效；无会话时不会持有工程连接。

切换前保存全局配置和安装 current/launcher/policy，核对目标端口及认证，再只替换目标连接。已经运行的聊天保持其旧进程；待用户逐个正常关闭、重连后迁移。禁止批量结束旧进程或重启整个应用。回退时通过安装器恢复前版，并按备份恢复本次目标配置，保留后续无关改动。

### Codex 配置冲突与恢复

统一入口使用独立名称 `cocos_unified`。Codex 会合并全局、工程和启动覆盖等配置层，同名配置必须保持同一种传输方式；不要将 stdio 的 command/args 加到已有 HTTP 的 `cocos` 表中。stdio 配置不能包含 url、http_headers 或 bearer_token_env_var。若其他配置层已经使用 `cocos_unified`，先核查并选择未使用的名称，同时修改该连接的主表和 env 子表。

修改前备份原配置，合并时只新增目标表并保留其他连接。先检查配置解析，再验证桌面端读取和实际初始化；CLI 解析成功不能证明桌面端所有配置层兼容。出现 `url is not supported for stdio` 时，撤回本次新增表或按备份恢复本次变更，再检查报错名称在全局、工程和启动覆盖中的定义。恢复时保留备份后其他任务的新改动；不要清空整个 MCP 配置。安装器和复制按钮只生成配置，不自动写入 Codex 全局文件。

必须按**故障会话的实际工作目录**验证。插件源码目录验证通过，不代表游戏工程的配置兼容；桌面端可同时打开多个工程，收藏目录也不能代替故障会话的 cwd。使用 App Server `config/read` 的 `cwd` 和 `includeLayers:true` 确认配置来源，并在该工程目录运行 `codex mcp get cocos_unified --json`。例如某游戏工程已有 `[mcp_servers.cocos] url = "http://127.0.0.1:3038/mcp"`，全局新增同名 command/args 会冲突；独立的 `cocos_unified` 主表和 env 子表可与它共存。不要为修复当前连接覆盖其他游戏工程的配置。配置层规则见 [OpenAI 官方配置文档](https://learn.chatgpt.com/docs/config-file/config-basic)。

各游戏仍需对应 Creator 扩展并启动桥接。源码扩展安装器自动记录客户端位置；手动 ZIP 安装在本机 `service-config.json` 加上：

```json
{
  "nodeExecutable":"/absolute/path/to/node",
  "clientInstallation":"/absolute/path/to/CocosMcp/.codex-work/artifacts/cocos-client"
}
```

发行 ZIP 不携带此文件，因为它含本机路径。后端可在编辑器关闭时连接，返回 `offline`，场景能力仍不可执行。Creator 2/3 支持范围沿用各自原生验证记录。

## 使用和目标选择

统一入口初始化提供不超过 512 字符的 instructions。首次场景/节点读取直接传当前聊天工作区的绝对路径，无需先单独连接：

```json
{"workspacePath":"/absolute/path/to/game-workspace","params":{}}
```

每个工程工具接受 workspacePath 或 projectPath，仍兼容已连接的 projectId。优先级为显式 projectId → 显式 projectPath → 请求 workspacePath → 宿主启动时显式提供的 COCOS_WORKSPACE_PATH。projectId 不会自动恢复断开的连接；需要恢复时显式 connect。连接和派发均重新校验授权、插件身份、后端 identity、API 和租约。

stdio 不自动携带聊天 cwd。launcher 的 workspaceRoot 只是客户端安装/运行状态目录，不是业务工作区，进程 cwd、唯一打开窗口、工程名称和复制的 project.json id 均不用于兜底。宿主能可靠绑定每个 stdio 会话时可提供 COCOS_WORKSPACE_PATH；否则模型须传 workspacePath 或 projectPath，不能宣称零输入识别。此流程不依赖已弃用 roots。工具/Schema 在新 stdio 会话初始化时加载，安装不会刷新已经运行的聊天连接。

路径先 realpath 归一化，并按目录边界匹配。工程内工作区选择最近 Creator 根，嵌套工程仍须独立授权。父目录只匹配 authorized-projects.json 中已授权根，以及旧 allowedRoots 中本身就是工程的根，不递归搜索磁盘。没有候选拒绝访问；多个同等候选返回 AMBIGUOUS_TARGET 及脱敏 rows，调用方显式选择 projectPath，不能默认第一个或按活跃窗口排序。

用户可在本机 policy.json 显式登记精确默认映射（不授予或扩大工程权限，修改后须启动新 stdio 会话）：

```json
{"workspaceMappings":[{"workspacePath":"/absolute/path/to/workspace","projectPath":"/absolute/path/to/workspace/game-a"}]}
```

仅匹配真实工作区精确路径；别名归一化后冲突映射拒绝选择。工程内工作区的最近根优先于父目录映射。映射失效、授权撤销或插件变化会拒绝访问，不能回退到另一个工程。

只在选定工程中存在唯一且通过桥接身份探测的实例时自动填充 instanceId；多个实例返回 AMBIGUOUS_TARGET 和脱敏 rows，须显式选择。运行时仍指定 runtimeInstanceId 或工作流 runtimeRef。写入仍附稳定 operationId、适用 revision/哈希。创建资源先 asset.location，整理先 plan，再携同一 planHash apply。自动连接不重放写请求，也不切换、保存场景。

连接缓存只属于当前 MCP 会话，按真实工程根产生的 projectId 隔离，没有全局“最近工程”或粘住旧候选的缓存。每个请求独立解析其真实工作区，多工作区并发不会相互更改默认目标。cocos_projects 列当前连接；cocos_connection_status 返回后端、编辑器状态和共享会话/请求数。cocos_project_disconnect 只释放本会话引用，有调用进行中时拒绝断开。

## 共享服务和恢复

每工程一个 HTTP 后端，仅绑定 127.0.0.1，动态端口通过工程 service.json 和认证 identity 发现。PID、serviceId、工程路径、启动时间、传输和 API 版本必须一致；存活但身份无法核实的进程不能接管。并发启动由工程排他锁裁决。

工程内部 Bearer 认证继续保留，共享模式还要求每客户端租约 ID 和私密 leaseToken。共享地址不能当普通 HTTP 配置复制。租约每 10 秒续期，60 秒过期；关闭一个 stdio 客户端不会停止其他会话或取消构建。

无租约、请求、工具执行、构建及活跃运行时会话时，后端空闲 90 秒退出。时长判断使用单调时间，记录使用 UTC。退出先拒绝新租约，再关闭服务、释放锁。客户端崩溃通过 TTL 回收；后端崩溃后显式 reconnect，写入不能自动重发。

独立 HTTP 服务可复用，客户端退出不会停止它。旧 stdio 服务占用工程时拒绝接管，需在原客户端停止。旧 HTTP 缺 apiVersion 时仅允许读取；不匹配 API 拒绝操作。共享模式不覆盖独立 HTTP 保存的端口。

`cocos_build_start` 要求稳定 operationId，准备 Creator、账号、配置时已占用工程名额。同 ID 同参数返回同任务，不同参数冲突；与编辑器写入共用工程持久操作空间。超时、断连和重启不自动派发第二次构建。

未知结果使用 `cocos_operation_query` 查询原 operationId，构建使用 status/list/logs 查询 jobId。重启后的运行记录保留 `outcome-unknown` 和占用保护；原 PID 存活时不能解除或自动杀进程。没有可靠 PID 的旧任务，用户确认原构建已经停止后才可调用 `cocos_build_recover`，携 projectId、jobId 和 `confirmedStopped:true`。恢复只解除占用，不把结果改为成功；重建用新 operationId。取消按 jobId 幂等处理。

账号沿用工程持久 profile，不输出凭据或反复启动登录窗口。关闭服务会阻止尚未派发的构建，等待已启动进程退出及最终状态落盘后才释放工程锁。

### Creator 原生场景与节点验收

桌面连接通过后，在明确指定的测试工程安装同版扩展，再启动对应 Creator。记录扩展 buildId、源码指纹、Creator 版本和 instanceId，通过统一入口验证 scene.query、scene.hierarchy、node.create、node.set、node.query、component.add、component.set 和 node.delete。每次写入使用返回的 revision 和独立 operationId，同时验证同 ID 不重复创建、旧 revision 拒绝写入以及原操作状态可查询。

Creator 3 的内置 Label 会在排版时修改 UITransform 尺寸。添加 Label 和修改其属性会先同步本次组件的原生排版，再返回读回结果与 revision；不通过忽略尺寸或跳过版本检查掩盖变化。添加已发生但排版失败时返回 OUTCOME_UNKNOWN 和 componentIds，应查询现有组件，不能再次添加。

测试节点放在已有测试场景中，清理时只删除本任务创建的节点，并核对场景快照与原资源及 meta 的哈希。原生 undo 历史和 dirty 标记不能单独证明所有 API 操作已恢复，不用全局撤销替代节点身份检查。保存或重开场景前先确认没有混入其他编辑。

启动器优先核验桥接的工程、实例和 PID。macOS/Linux 下历史 PID 已被其他程序复用时忽略陈旧记录，不删除记录或终止进程；仍是 Creator 或无法读取进程身份时保留失联状态，避免重复打开登录窗口。其他平台保持保守处理。

### 从单工程旧插件迁移

先停止目标工程的旧连接，再安装对应 Creator 版本的新扩展并重载编辑器。已有旧插件的源码安装会保留回滚目录及有效的 clientInstallation，同时登记新插件的工程授权；手动 ZIP 安装按前述 service-config.json 配置同一个已安装统一客户端，再点击“授权当前工程”。检查面板的客户端 buildId，并实际查询目标工程的场景，文件安装成功不等于编辑器已经加载新版。

删除旧插件不会自动删除 Codex 配置。若游戏工程 .codex/config.toml 中仍有旧的 [mcp_servers.cocos] HTTP 表，应同时停用或移除该旧连接及其子表，保留全局 cocos_unified。无需在每个新工程添加 command、端口或 token；插件安装授权完成后，直接传 workspacePath 或 projectPath 调用工程工具即可。

## 策略、升级和回退

安装位于 `<workspace>/.codex-work/artifacts/cocos-client/`，policy 示例：

```json
{
  "schemaVersion":1,
  "allowedRoots":[],
  "autoStartBackend":true,
  "allowProjectCode":false,
  "clientHeartbeatSeconds":10,
  "clientLeaseTtlSeconds":60,
  "idleExitSeconds":90
}
```

安装保留已有 policy，allowed-root 参数仅初始化新安装，不隐式扩大已有授权。安装授权记录按工程精确登记，原子发布并使用跨进程锁防止并发覆盖；客户端在每次连接、工具与资源派发前即时读取，新安装和取消授权不需要重启 stdio。取消授权优先于旧父目录白名单，已发出的请求不会被自动重放或强行终止。插件更新登记新身份；复制工程、嵌套工程及移动后的新真实路径需要新安装或显式授权。

旧版客户端升级为此版本后需重新建立连接一次，之后新增安装授权即时生效。policy 中的旧父目录配置仍在进程启动时读取；改用仅安装授权时，先登记已验证的已有工程，再将 allowedRoots 设为 [] 并重连。allowProjectCode 默认关闭，执行项目代码仍需明确授权。

无编辑器时可使用受控的本机入口登记已有插件（必须指定工程根目录，插件完整性与 Creator 版本会被校验）：

```sh
node /absolute/path/to/client/versions/<buildId>/install.mjs \
  --installation /absolute/path/to/client \
  --authorize-project /absolute/path/to/game
```

撤销使用相同入口的 `--revoke-project`。这些入口仅供用户/安装流程调用，不注册成 AI 可以自行扩大权限的 MCP 工具。保留 authorized-projects.json 和 policy.json 作为本机状态，不打包进发行包。

版本位于 `versions/<buildId>/`，白名单文件逐一 SHA-256 校验，current.json 指向不可变版本。进程启动后固定 router/worker 版本；升级不改变在运行的进程，不杀旧后端，新进程按兼容 API 复用服务。

重复安装命令升级，前版保存到 previous。`pnpm client:rollback` 验证前版后切换入口，保留 policy、工程状态和其他版本；没有 previous 拒绝回退。安装锁存在时拒绝并发，异常锁先核实 owner.json 的 PID/时间，不自动清理。失败 staging 保留在本任务 tmp 诊断，不批量删除历史构建或备份。

## 验证和交付

`pnpm check` 按类型检查→构建→全量测试→构建执行，将当前源码的报告哈希嵌入客户端和扩展。`node scripts/project-env.mjs node scripts/release-bundle.mjs` 在证据、源码和文件哈希一致时生成 ZIP 与 SHA256SUMS。

回归涵盖零工程初始化、多会话共享、多工程路由、关闭/崩溃/重连、认证/租约、旧服务兼容、写入不重放、构建并发/恢复、安装校验及两版面板。编辑器和构建器使用桩；通过不等于真实 Creator 场景修改、游戏发布、GPU、真机或 Codex 当前会话刷新已验证。真实验收须记录工程、版本、实例和实际调用结果。
