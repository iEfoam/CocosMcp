# 统一 stdio 客户端与多工程连接

全局只配置一个固定 Node 入口，AI 在任务中调用 `cocos_project_connect`，按工程真实路径发现或启动本机后端。新增游戏工程无需修改 TOML，也无需把端口或 token 发给 AI。

## 安装和配置

需要独立 Node.js 24+ 和仓库固定版本 pnpm。源码安装：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm client:install
```

`client:install` 默认允许仓库上一级目录下的 Creator 工程。其他父目录使用安装器，`--allowed-root` 可重复指定，目录必须存在：

```sh
node .codex-work/build/client/install.mjs \
  --workspace /absolute/path/to/CocosMcp \
  --allowed-root /absolute/path/to/games
```

离线包 `cocos-mcp-client.zip` 包含 launcher、router、worker、install、LICENSE 和 manifest。先核验同版 SHA256SUMS，解压到工作区 `.codex-work/downloads/`，再使用包内 `install.mjs` 执行同样命令。安装和运行无需 node_modules、源码或下载依赖；AI 模型联网要求另行判断。

安装器输出完整 `configuration`，也可在新版 Creator 面板选择“统一 stdio（多工程）→ 复制 Codex 配置”。将它合并到 `~/.codex/config.toml`，保留其他设置。配置引用固定 launcher，不包含游戏路径、端口或 Bearer token：

```toml
[mcp_servers.cocos_unified]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/CocosMcp/.codex-work/artifacts/cocos-client/launcher.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

实际使用安装器生成的完整配置，包含工作区内 TMP、缓存和 UTC 环境。配置和初始化 instructions 的行为依据 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。保存后重新加载客户端 MCP；安装完成不能代替真实工具调用验证，当前会话是否立即刷新由客户端决定。

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

统一入口初始化即返回不超过 512 字符的 instructions，要求 AI 在 Cocos 任务中从会话工作区确认工程绝对路径，先连接再调用能力，无需每个会话重复 MCP 说明。目标不明确时必须询问；模型指导不能保证每次选择工具，服务端不能读取 Codex 隐含上下文。

`cocos_project_connect` 参数示例：

```json
{"projectPath":"/absolute/path/to/games/game-a"}
```

路径 realpath 归一化后，在 allowedRoots 内向上查找 Creator 元数据和 assets。支持工程子目录及指向同一工程的别名，拒绝普通 Node 仓库和越界符号链接，不从唯一打开窗口猜测工程。

响应含 `project`、`connection`、脱敏实例 `rows`。取返回的 projectId 和明确 instanceId 调用 `cocos_scene_query` 获取场景 revision。多个实例须按任务显式选择。写入附稳定 operationId、适用的 expectedRevision/哈希；运行时传明确 runtimeInstanceId。创建资源先 `asset.location`，整理先 plan，再携同一 planHash apply。

```json
{
  "projectId":"<connect 返回的 projectId>",
  "instanceId":"<选中的 instanceId>",
  "params":{}
}
```

连接表仅属于当前 stdio 进程，没有全局“当前工程”。`cocos_projects` 列当前连接；`cocos_connection_status` 返回后端、编辑器状态和共享会话/请求数。`cocos_project_disconnect` 只释放本会话引用，有调用进行中时拒绝断开。

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

先停止目标工程的旧连接，再安装对应 Creator 版本的新扩展并重载编辑器。已有旧插件的源码安装会保留回滚目录及有效的 clientInstallation；手动 ZIP 安装按前述 service-config.json 配置同一个已安装统一客户端。检查面板的客户端 buildId，并实际查询目标工程的场景，文件安装成功不等于编辑器已经加载新版。

删除旧插件不会自动删除 Codex 配置。若游戏工程 .codex/config.toml 中仍有旧的 [mcp_servers.cocos] HTTP 表，应同时停用或移除该旧连接及其子表，保留全局 cocos_unified。无需在每个新工程添加 command、端口或 token；工程位于已允许目录内时，使用其绝对路径调用 cocos_project_connect 即可。

## 策略、升级和回退

安装位于 `<workspace>/.codex-work/artifacts/cocos-client/`，policy 示例：

```json
{
  "schemaVersion":1,
  "allowedRoots":["/absolute/path/to/games"],
  "autoStartBackend":true,
  "allowProjectCode":false,
  "clientHeartbeatSeconds":10,
  "clientLeaseTtlSeconds":60,
  "idleExitSeconds":90
}
```

安装保留已有 policy，allowed-root 参数仅初始化新安装，不隐式扩大已有授权。新增游戏父目录只改 policy；重新加载 stdio 后生效，已运行后端保留启动策略，待安全退出后再连接。allowProjectCode 默认关闭，执行项目代码仍需明确授权。

版本位于 `versions/<buildId>/`，白名单文件逐一 SHA-256 校验，current.json 指向不可变版本。进程启动后固定 router/worker 版本；升级不改变在运行的进程，不杀旧后端，新进程按兼容 API 复用服务。

重复安装命令升级，前版保存到 previous。`pnpm client:rollback` 验证前版后切换入口，保留 policy、工程状态和其他版本；没有 previous 拒绝回退。安装锁存在时拒绝并发，异常锁先核实 owner.json 的 PID/时间，不自动清理。失败 staging 保留在本任务 tmp 诊断，不批量删除历史构建或备份。

## 验证和交付

`pnpm check` 按类型检查→构建→全量测试→构建执行，将当前源码的报告哈希嵌入客户端和扩展。`node scripts/project-env.mjs node scripts/release-bundle.mjs` 在证据、源码和文件哈希一致时生成 ZIP 与 SHA256SUMS。

回归涵盖零工程初始化、多会话共享、多工程路由、关闭/崩溃/重连、认证/租约、旧服务兼容、写入不重放、构建并发/恢复、安装校验及两版面板。编辑器和构建器使用桩；通过不等于真实 Creator 场景修改、游戏发布、GPU、真机或 Codex 当前会话刷新已验证。真实验收须记录工程、版本、实例和实际调用结果。
