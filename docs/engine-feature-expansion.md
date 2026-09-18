# GitHub 引擎能力扩展实施记录

引擎基线：`cocos/cocos-engine@411f98df047c25902f93440d4b22925c2fb65461`（v3.8.8）。这是持续实施记录，不是九类功能全部完成声明；下文各批次的测试数、构建及报告均保留其历史时间边界，当前总览以版本矩阵为准。

版本范围更新（2026-09-18）：本文描述 **3.8.8** 的路径、IK、CCT、探针等扩展；2.4.15 的 Camera、Tween、骨骼和接触能力独立适配，不继承这些入口。参见 [版本矩阵](version-support.md) 和 [2.4.15 台账](creator2-expansion-tracker.md)。下列后处理/蒙皮阻碍仍有效。

## 兼容契约

新增工具对未适配版本、缺少模块/方法、未初始化的物理控制器返回普通业务结果：

```json
{"supported":false,"status":"unsupported","code":"UNSUPPORTED_CAPABILITY","capabilityId":"runtime.character.inspect","reason":"当前物理后端未初始化角色控制器"}
```

不改动已有接口错误契约；参数错误、对象不存在、场景冲突、通信失败和执行结果不确定继续使用原错误分类，不用“不支持”隐藏程序故障。Creator 2 和旧扩展不认识的新能力由应用层转换为上述结果。新工具 Schema 在严格 AJV 模式下验证，不能因新增能力导致目录初始化失败。

## 已接入入口与实际边界

| 工作包 | 入口 | 当前边界 |
|---|---|---|
| 路径 | path.plan/sample/bake_clip | 原生 Spline；局部坐标；直线/贝塞尔/Catmull-Rom；近似等速；烘焙位置轨道。无朝向跟随、避障或闭合路径策略 |
| 路径预览 | runtime.path.preview | parentId 将局部点转换到世界坐标；要求指定相机已有 GeometryRenderer |
| 调试绘制 | runtime.debug.draw/shape/inspect/clear | 有界线段、射线、包围盒、视锥、点标记；ownerId、TTL；不 reset 共享绘制器；原生包围盒绘制与清除已有截图证据 |
| 动画图观测 | runtime.animation_graph.inspect/trace/assert/set_parameter | 已有图、指定层、实际帧采样；仅标量参数可写；状态断言需要引擎调试标识 |
| 排序 | sorting.inspect/plan/apply | 已有 Sorting2D，场景指纹守卫，原生属性读回及重叠图形遮挡顺序截图；不自动增加组件或生成 Y 排序脚本 |
| 后处理 | postprocess.inspect/plan/apply、runtime.postprocess.inspect | 编辑器允许属性及运行时相机开关、绑定、实际 Pass 检查；不自动切换管线。当前预览管线不能提供后处理 Pass 查询，返回不支持；无 LUT 创建/绑定工作流 |
| 探针 | probe.generate/inspect/plan/apply、runtime.probe.preview | 均匀局部点阵和已有 LightProbeGroup；最多 4096 个；adaptive 明确不支持；支持每页最多 256 个点的世界坐标预览；不进行烘焙 |
| 角色 | runtime.character.inspect/test_route | 已初始化 CCT 后端、有界位移、位置/速度/落地和碰撞/触发事件快照；最多 512 事件，报告丢弃数；可指定 expectedEnd/tolerance 断言终点；不自动恢复或声称寻路成功 |
| 蒙皮 | runtime.skinning.inspect/plan | 配置查询与编译缺陷、共享骨架、2..6 单元适用性检查；不激活组件。当前引擎检测到递归编译缺陷，返回不支持；创建和性能比较受此阻塞 |
| IK | runtime.ik.inspect、ik.inspect/plan/apply/mask_create | 创建独立原生双骨骼图与动作遮罩；检查非零骨长、路径和子树名称唯一性。图不自动绑定已有控制器；已在独立样例验证目标姿态及可选布尔参数驱动的 IK/Rest 切换 |

目录 implementation 表示具体入口已经有处理器，不表示整项工作包已完成。未实现的高级操作没有注册成可执行空壳。

## 调用示例

路径采样：

```json
{"capabilityId":"path.sample","params":{"mode":"catmull_rom","points":[{"x":0,"y":0,"z":0},{"x":5,"y":2,"z":0},{"x":10,"y":0,"z":0}],"samples":60,"uniformSpeed":true}}
```

路径烘焙前先调用 asset.location 查询 `.anim` 目标，复用已有资源目录。bake_clip 另传 url、rootId、name、duration，可选 targetPath。不会绑定或播放剪辑。

排序先 plan，再传相同参数和返回的 planHash 调用 apply：

```json
{"componentId":"实际组件UUID","properties":{"sortingOrder":7}}
```

任意场景变化都会使原计划失效。apply 返回逐项 before/after；失败返回已完成项并保留现场，不盲目重试或执行全局 undo。需要恢复时，读取当前状态，将确认的原值作为新 properties 重新 plan/apply。

探针 generate 传 min/max、counts（各轴 2..32，乘积不超过 4096），输出 rows 可作为 probe.plan 的 properties.probes。坐标相对探针组节点。

## 验证与制品

- 类型检查：`node scripts/project-env.mjs node node_modules/typescript/bin/tsc --noEmit`。
- 构建：`node scripts/project-env.mjs node scripts/build.mjs`。
- 自动化回归：`node scripts/project-env.mjs node scripts/test.mjs`。
- 新增测试：`tests/engine-features.test.ts`，覆盖缺模块、版本、Creator 2、缺网关、危险 getter、帧取消、路径采样、探针预算、计划过期和绘制所有权。
- 原生脚本：`scripts/engine-features-native.ts`；先用 esbuild 编译到 `.codex-work/build/engine-features-native.mjs`，再通过 project-env 运行并显式传测试工程路径。
- 原生测试创建独立场景及动画资源，通过 AssetDB 操作，保存重开后验证配置，结束恢复原场景；只关闭自己开启的预览。
- 报告在 `.codex-work/logs/engine-features-native-*.json`；配置、运行连接与视觉/业务验收分开记录。

已取得 Creator 3.8.8 原生路径采样/烘焙、排序/探针/Bloom 修改与保存重开、预览运行时连接、IK 目标姿态，以及调试框绘制/清除的像素证据。已验证布尔参数驱动的 IK → Rest → IK 状态切换与 Rest 骨骼位置；当前 Bullet 后端已有地面/墙体、台阶、坡道、宽窄通道原生验收；尚无真实后处理效果或蒙皮合批优化的完整原生验收，不能标记这些工作包全部完成。

### 独立最小样例与兼容发现

最新通过的样例为测试工程 `assets/Scenes/EngineFeatureTest_c5a1dd19.scene`。配套资源由 AssetDB 创建并复用 Animations、Models、Shaders、Materials 目录，源生成器为 `scripts/minimal-skinned-fixture.ts`。报告为 `.codex-work/logs/engine-features-native-c5a1dd19.json`，截图为 `.codex-work/build/engine-fixture-c5a1dd19.png`。

- IK：Root → Middle → End 三节点，目标 `(1,1,0)`、极向 `(0,0,1)`；独立 `.animgraph` 和 `.animask`。原生采样 5 帧处于 IK 状态，末端误差 `9.550499576785472e-16`。
- 蒙皮：自包含 glTF，两个四顶点网格共享三关节骨架、材质和 JointSwing 动画；源网格已实际显示。配备专用合批 Effect/Material、两单元 SkinnedMeshBatchRenderer，合批节点默认不激活。
- 当前 Creator 3.8.8 原生预览激活合批组件时出现 `Maximum call stack size exceeded`，见 `engine-features-native-faec2a92.json` 的预览日志。当前证据只能证明样例配置和源网格可运行，不能证明合批绘制或性能收益。未修改引擎来掩盖该错误。
- 项目裁剪模块与编辑器类注册表不同。IK、Sorting2D、后处理写入前检查项目模块；缺失直接返回 `UNSUPPORTED_CAPABILITY`。图求值器未初始化时也提前返回不支持，避免原生断言。
- 测试工程单独启用了 procedural-animation、sorting-2d、custom-pipeline-post-process、geometry-renderer 并重启生效。普通用户工程不会自动开启模块。
- 测试结束已关闭自有预览并恢复原场景。146 项自动测试、类型检查通过；截图确认两片源网格可见，最后一轮预览日志为空。

## 尚需实施的阶段出口

1. 已完成基础调试形状封装及包围盒绘制/清除原生截图；继续补充多相机和原生场景切换矩阵。
2. 已完成真实 IK/Rest 状态切换样例；继续补充缺调试标识环境、断线取消与实际参数事件矩阵。
3. 已完成运行时管线兼容诊断和测试样例恢复流程；后处理真实效果受当前管线适配限制，尚无视觉通过证据。
4. 已完成 Sorting2D 实际遮挡截图、探针分页预览和清除验收；继续补充多相机及复杂层级矩阵。
5. 已完成角色事件记录、终点误差断言、监听清理，以及 Bullet 胶囊控制器的地面/墙体、台阶/坡道/宽窄通道原生样例；其他物理后端和设备尚未验证。
6. IK 图替换、遮罩绑定及多动作组合；当前仅创建独立图和遮罩，已有图不会被重写。
7. 蒙皮合批适用性规划、专用合批材质、独立预览、资源拥有关系及性能/画面比较。
8. 为全部新增能力补齐与当前构建对应的原生证据；当前支持范围不自动扩展到其他 Creator 版本或原生设备。

## 继续实施记录

新增 `runtime.debug.shape`、`runtime.skinning.plan`、`runtime.postprocess.inspect`，扩展 `runtime.character.test_route`。调试形状使用世界坐标；视锥 corners 为近面四角、远面四角，两面按相同方向排列。点标记最多 256 个，可用于探针预览。角色 expectedEnd 为中心的世界坐标，tolerance 默认 0.05；事件在回调发生时复制，结束/取消均移除监听，游戏副作用不会回滚。

原生复测脚本：`scripts/engine-feature-followup-native.ts`。复用已有独立场景，不写入或保存场景；预览内短暂修改相机/Bloom 后恢复，最后关闭自有预览并恢复先前场景。该测试允许调用固定的原生公开方法，不更改常驻服务的执行权限。

验证结果：

- 152 项自动测试通过，类型检查通过。覆盖新增形状预算、递归 setter 的无执行探测、碰撞事件复用/取消清理、后处理相机和 Pass 边界。
- `.codex-work/logs/engine-feature-followup-native.json`：本轮原生调用通过，预览日志无错误。报告 passed 只代表脚本检查通过，不代表被明确拒绝的能力可执行。
- `.codex-work/build/engine-followup-box.png` 和 `engine-followup-cleared.png` 已逐图查看：绿色包围盒出现并在 clear 后消失，模型姿态一致。
- 当前运行时实际编译的合批 setter 为 `this.mesh = val` / `this.skeleton = val`，与官方源码的 `super` 赋值不同。只检查 setter 文本，不执行故障代码，也不修改用户引擎。
- 后处理截图无可见泛光；诊断分别返回“相机未开启后处理”和“当前环境不支持接口：getCameraPasses”。参数恢复已经验证，效果未验证，不以参数写入代替渲染支持。
- 原生未激活 CCT 的 test_route 返回 `UNSUPPORTED_CAPABILITY`，没有执行位移或抛出服务异常；这不等同于真实物理通行验收。

### 可选 IK 状态开关

`ik.plan/apply` 可传 `enabledParameter: "ikEnabled"`（以字母开头，最多 64 位字母、数字、下划线）。图默认处于 IK；参数为 false 时进入使用骨骼初始姿态的 Rest，为 true 时返回 IK。两方向均为零时长过渡，不等待退出时间。未传该参数保持原来的单状态图。只操作新建的独立图，不修改已有图。

最新原生报告 `engine-features-native-c5a1dd19.json` 为 passed：验证参数修改、Rest/IK 状态断言，以及 Rest 末端位置 `(0,2,0)`（容差 0.02）。原始 IK 目标误差为 `9.550499576785472e-16`。152 项自动测试、类型检查通过，截图已检查，测试后恢复原场景。

### 探针预览、排序与角色路线验收

新增 `runtime.probe.preview`：传 `componentId`、`cameraComponentId`、`ownerId`，可选 `offset`（默认 0）、`limit`（默认 256）、`radius`（默认 0.05）及调试绘制参数。读取已有探针组，使用节点 worldMatrix 转换局部点，返回本页 `rows`、`total`、`nextOffset`。空组或缺模块返回不支持；分页越界仍属于参数错误。标记半径为世界单位，使用 `runtime.debug.clear` 按 ownerId 清理。只显示点位，不烘焙或修改探针资源。

本轮 153 项回归测试、类型检查和构建通过。原生证据仍由 `scripts/engine-feature-followup-native.ts` 生成到 `.codex-work/logs/engine-feature-followup-native.json`。最终报告 passed，预览日志 rows 为空，原场景恢复成功。测试中创建的 Canvas、相机、图形和物理节点只存在于自有预览，全部按所有权销毁。

| 原生验收 | 实测结果 |
|---|---|
| Sorting2D | 两个重叠 Graphics 图形，红色 sortingOrder 从 0 改为 2 后，遮挡关系由蓝在前变为红在前；两张截图已检查 |
| 探针 | 8 个点标记显示，clear 后消失；截图已检查；分页转换、源点不变及越界有自动测试 |
| 地面/墙体 | 胶囊从 x=100 前进，在 x=101 停下，grounded=true，有碰撞事件，墙后终点 reached=false |
| 台阶 | stepOffset=0.5，跨过 0.3 米台阶，中心约为 (102,1.3,0) |
| 坡道 | slopeLimit=45°，登上 20° 坡道，中心约为 (103,2.302,0) |
| 通道 | 直径 1 米胶囊通过 1.2 米通道到达 x≈103；0.6 米通道在 x=100.5 挡住 |
| 不可用后端状态 | 未激活、未初始化的控制器返回 UNSUPPORTED_CAPABILITY，无位移或服务错误 |

截图：`.codex-work/build/engine-followup-sorting-blue-front.png`、`engine-followup-sorting-red-front.png`、`engine-followup-probes.png`、`engine-followup-probes-cleared.png`。这些是 Creator 3.8.8 当前 Bullet 后端和预览管线的证据，不自动外推到 Creator 2、PhysX、其他版本或原生设备。
