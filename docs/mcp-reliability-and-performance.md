# MCP 预览可靠性与性能工作流

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
