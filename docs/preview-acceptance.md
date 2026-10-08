# 预览优化、验收配方与验证边界

更新日期：2026-10-08。本文对应 CP-001～CP-013 预览优化清单，区别于覆盖整个引擎的 [长期路线图](capability-roadmap.md)。这 13 项已有实现，不表示长期路线图的所有模块、设备和业务流程完成。

## 已交付范围

| 项目 | 实现 | 验证边界 |
| --- | --- | --- |
| CP-001 完整包 | Creator 2/3 均包含 runtime；逐文件 SHA、staging、备份、同版本修复和运行/磁盘身份 | 两版安装与重载实测；缺文件、混包、旧版安装及目录回滚由自动测试覆盖 |
| CP-002 场景身份 | launch/current scene、generation、严格期待、旧句柄/任务/订阅失效 | 合成 A→B→A 场景切换实测，不是实际登录→牌桌路线 |
| CP-003 截图 | PNG、UTC、SHA、DPR/几何、绘制证据、异常像素和 lastFrame | 彩色合成画面与暂停实测；窗口合成像素的精确帧索引保持 unknown |
| CP-004 输入 | 先聚焦自有窗口，再等待帧和发送输入；不隐式 resume、不重放未知输入 | 此前两版隐藏窗口检查通过；最新 3.8.8 隐藏窗口输入后态未知，保留原操作、不重放 |
| CP-005 横屏/坐标 | 四种预设、CSS/buffer/design/DPR、视图指纹和冲突恢复 | 两版桌面尺寸与 UI 断言实测，不代表真机 |
| CP-006 刷新 | 原生编译信号、source map、importer UUID、实际导航加载字节 | 两版脚本/图片/Prefab completed；3.8.8 场景 completed；2.4.15 场景字节证据不足时 unknown |
| CP-007 就绪 | 分层状态、运行时连接别名、场景/帧/UI 有界等待、当前场景快照 | 两版 runtime 源码匹配；不把引擎就绪当作业务成功 |
| CP-008 诊断 | 有界 debug/info、错误层分类、声明连接用途、脱敏与采集缺口 | 两版 diagnose；CORS/拒绝/WS 和敏感字段另有协议测试 |
| CP-009 审计 | 成功/失败/runtime 全路径、UTC 半开时间范围、证据引用、去重和重启恢复 | 两版查询；未知状态及审计故障不重放由自动测试覆盖 |
| CP-010 语义点击 | 唯一 selector、可见/按钮/遮罩/候选、真实输入和独立 after 断言 | 两版 Before→Clicked 实测；actualReceiverVerified 不冒充 true |
| CP-011 验收配方 | plan/run/status/cancel、版本/源码/原图/脱敏结果及清理证据 | 此前两版 fixture 配方通过；最新 3.8.8 配方成功断言未通过；realBusinessOutcomeVerified=false |
| CP-012 夹具/资源 | UI plan/build、原生所有权快照、父位置与引用守卫；3.x Prefab 编辑身份 | 此前通过轮的夹具清理实测；最新 3.8.8 失败配方现场保留，不盲目删除 |
| CP-013 回归 | 有界重复、生命周期基线、帧推进、P50/P95 | 两版有限尺寸回归，不代表长期泄漏排除或 GPU 内存测量 |

最新源码的 333/333 自动测试、28 个来源匹配套件、类型检查、构建和发布包校验通过。原生结果必须按源码快照区分：

| 源码指纹 | Creator 2.4.15 | Creator 3.8.8 |
| --- | --- | --- |
| `87a6b920f49be9fea72e11a274d313c157f88a3d1b949f8c9b86e1bfa0a02ee2` | 14/14 通过 | 14/14 通过 |
| `6fe31cc10b167d022012777e622ae7f0aabae4110c673bbcc617b6dcd43a0dae` | 14/14 通过 | 12/14 通过；隐藏窗口输入与配方未通过 |

后一快照补齐 Creator 2 的 `preview.presets` 暴露入口及检查。3.8.8 隐藏窗口操作返回 `OUTCOME_UNKNOWN`、`inputSent=true`：输入已发送，但点击后的 UI 状态未被证明；配方返回 failed，未达到预期 succeeded。现场记录保留，不重复发送输入。按用户要求停止进一步测试，不把此前通过记录迁移成最新源码全通过，也不把两个未通过项声称为已修复。

检查通过包括“证据不足时正确返回 unknown”的明确契约断言；上述要求成功而未通过的两项仍计为失败。合成检查不能代表所有资源、平台和真实业务成功。

机器证据位于仓库忽略的 `.codex-work/artifacts/mcp-roadmap-20261008/`，包含 `acceptance.md`、`final-summary.json`、逐版 `summary.json/report.json`、安装备份位置和验收后的状态。证据与凭据不随 Git 分发；文档里的实测结论也不会自动改变能力目录的 verification 级别。

## 选择正确实例并连接

先查询 `cocos_projects`、`cocos_instances`，多实例时指定 `instanceId`。启动本工程的 MCP 服务和 runtime gateway，然后通过 `cocos_capability_execute` 传入 `projectId`、所选实例与以下 capability 参数。例子省略外层工程身份，调用时必须补齐。

```json
{"capabilityId":"preview.start","params":{"target":"embedded","preset":"landscape-844","visible":true}}
```

当前场景必须已保存；工具不会自动保存用户的 dirty 场景。四种预设为 568×320、844×390、1280×720、1920×1080，可通过 `preview.presets` 查询。它们是窗口参考尺寸，不是设备模拟器。

```json
{"capabilityId":"preview.runtime.connect","params":{"gatewayPort":12345}}
```

将 `gatewayPort` 替换为当前 MCP 服务实际启动的回环网关端口，不能硬编码旧端口。记录返回的 `runtimeInstanceId` 并用于后续 runtime 请求。刷新后重新连接并使用新的 ID；其他标签页和失联保留期内的旧 runtime 不能被猜测为当前目标。原有 `shader.preview.connect` 兼容入口仍保留。

```json
{"capabilityId":"preview.wait","params":{"timeoutMs":5000,"uiChecks":[{"selector":{"name":"Action"},"count":1,"visible":true,"clipped":false}]}}
```

`preview.wait` 可同时约束 `sceneId`、`afterFrameIndex` 和 UI 条件，截止范围 100～30000 ms，不接受 JavaScript 表达式。暂停时不会自动恢复。

## 语义交互与配方

`runtime.ui.select/check` 可按 nodeId/name/path 匹配；多个字段使用 AND，歧义拒绝。不存在断言用 `exists:false`；`optional:true` 允许节点缺失，但存在时仍检查其声明条件。

下面的真实点击只适用于已授权的隔离场景。它可能触发业务回调，不能用于未授权的匹配、扣费或资金入口。

```json
{"capabilityId":"runtime.ui.click","runtimeInstanceId":"<当前预览返回的 ID>","params":{"selector":{"name":"Action"},"after":[{"selector":{"name":"Action"},"text":"Clicked"}],"timeoutMs":5000}}
```

`inputSent=false` 表示发送前失败；`null` 表示投递未知；`true` 表示已经确认发送。发送后后态无法证明时返回 `OUTCOME_UNKNOWN`，先读回实际状态，不能再点击一遍。Creator 2 遮罩有效性无法从公开接口证明时保守拒绝。

配方使用相同 params 先 `acceptance.plan`，再添加返回的 `planHash` 调用 `acceptance.run`。查询 `acceptance.status` 的 runId，直到 succeeded/failed/unknown/incomplete/cancelled/timeout 等终态。以下是对已经运行的预览进行只读验收的示例；`mode:live` 表示采用工程当前数据，不代表真实业务已被验证。

```json
{"capabilityId":"acceptance.plan","params":{"mode":"live","steps":[{"capabilityId":"preview.wait","params":{"timeoutMs":5000,"uiChecks":[{"selector":{"name":"Action"},"count":1,"visible":true}]}},{"capabilityId":"preview.capture","params":{}}]}}
```

配方最多 50 步、8 个活跃运行，最多 120 秒。`runtime.ui.click` 和 `runtime.control.text` 步骤必须另加 `allowInputs:true`，这一参数不替代用户对真实业务动作的授权。取消仅阻止后续步骤；已经发出的原生操作仍可能完成，原 ID 与检查点保留。服务重启后未确认运行返回 unknown，不自动续跑。

## 夹具创建与退出

1. 使用 `fixture.plan`，指定已查询的 `parentId`、合成 UI `document`、`label`、期限 `ttlMs` 和精确 `allowedOrigins`。计划复用 `ui.plan`，不手改序列化 JSON。
2. 使用相同参数及返回的 `planHash` 调用 `fixture.create`，记录 fixtureId。默认业务网络 deny；允许源最多 8 个，必须是完整 origin，不带凭据、路径或通配符。
3. `preview.start` 与 `mode:fixture` 的配方都绑定该 fixtureId。网络隔离只在绑定夹具的 embedded 预览内实施；external-browser 尚无可执行的夹具隔离证明，会拒绝 fixtureId。
4. 结束后 `fixture.cleanup` 检查原生快照、父位置及存活引用。修改冲突保留现场，所有权未完成或清理未知时查询 `fixture.status`，不能重复创建、猜测删除或重放整个计划。

清理只删除本任务创建且仍匹配的 UI 子树，不自动删除正式资源。夹具期限限制后续使用，不表示到期会自动删除。原图保存在 `.codex-work/artifacts/cocos-mcp/`；普通审计只留路径/SHA 和脱敏结果，不存 Base64。布尔 passed 保留，凭据字段仍脱敏。

Creator 3 的 Prefab 子节点修改需要先 `scene.save`，再 `prefab.open` 进入原生资源模式；修改后 `scene.save`，最后 `scene.open` 返回原场景。保存返回的是实际资源 UUID，不把布尔确认值当作 UUID。创建资源前查询 `asset.location`，后续沿用返回的实际 URL/UUID。

## 生命周期回归与审计

```json
{"capabilityId":"preview.regression","params":{"cycles":3,"rows":[{"capabilityId":"preview.resize","params":{"preset":"landscape-844"}},{"capabilityId":"preview.resize","params":{"preset":"landscape-1280"}}]}}
```

最多 10 轮、每轮 8 步，仅接受 resize、refresh、wait 和 runtime.scene.load。首轮预热后比较句柄、订阅、任务、帧等待、资产引用/加载和资源数量；P50/P95 是工具操作墙钟延迟，不是 GPU 时间。跨导航不比较旧帧计数，GPU 内存缺失时明确 unavailable。

```json
{"capabilityId":"operation.audit.query","params":{"from":"2026-10-08T00:00:00Z","to":"2026-10-09T00:00:00Z","limit":100}}
```

时间范围为 UTC `[from,to)`。开始和终态是两条审计事件，不是两次执行。请求参数只保存摘要；审计写入失败不会使已成功的输入变成可重试动作。

## 复现原生检查

先完成 `pnpm check`、[发布包校验和完整安装](extension-packaging.md)，打开专用测试工程并原生重载扩展。两个测试工程都必须处于已保存状态；不把正式业务工程当作夹具。当前 harness 仅接受路径包含 `CocosMcp-UI-Test-3.8.8` 的 3.x 工程，或路径以 `/.codex-work/build/creator2-test-project` 结尾的 2.x 工程。

```sh
node scripts/project-env.mjs node --input-type=module -e 'import {build} from "esbuild"; await build({entryPoints:["scripts/roadmap-native-acceptance.ts"],outfile:".codex-work/build/roadmap-native-acceptance.mjs",bundle:true,packages:"external",platform:"node",target:"node24",format:"esm"});'
node scripts/project-env.mjs node .codex-work/build/roadmap-native-acceptance.mjs /absolute/isolated/CocosMcp-UI-Test-3.8.8 3
node scripts/project-env.mjs node .codex-work/build/roadmap-native-acceptance.mjs "$PWD/.codex-work/build/creator2-test-project" 2
```

可在命令环境中设置 `COCOS_NATIVE_SOURCE_FINGERPRINT` 为本次 release-manifest 的实际摘要，以将 summary 关联到候选源码；未设置时该字段为 null，不能把其当作当前源码原生证据。两个原生检查顺序执行，避免焦点冲突。脚本通过 `asset.location` 和原生 API 创建自己的场景、图片、脚本和 Prefab，保存原图/逐步结果，停止自有预览、守卫清理夹具并恢复先前场景。合成测试资源和失败现场保留在隔离工程，不清空工程或业务资源。

未验证范围继续保留：外部 Chrome MCP 连接器端到端、真实设备/GPU 内存/长期压力及实际游戏登录/匹配/扣费。Creator 2 场景快照与磁盘导入产物的字节证明不完整时返回 unknown；层级正确和页面截图不能补成字节证明。

登录复用见 [使用指南](user-guide.md#creator-登录状态)；技术契约见 [可靠性说明](mcp-reliability-and-performance.md)、[外部连接器协议](external-preview.md)。推送 main 触发既有 CI 的开发版 prerelease，稳定版仅由明确版本标签触发，不会将本地候选自动标记为稳定版。
