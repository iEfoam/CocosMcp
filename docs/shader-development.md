# Shader 开发工具

## 实现范围与前置条件

F22 提供 Effect/Chunk 读写、原生编译、依赖指纹、材质资源编辑、组件绑定、材质实例调试、宏变体和 RenderTexture 预览。原生编辑器适配锁定 **Creator 3.8.8**；其他版本只开放环境查询。Creator 2.x 尚未实现本模块。

构建并安装本仓库的 Creator 扩展，再在编辑器中启用桥接。运行时能力还需要加载本次构建的 `cocos-mcp.js` 或 `cocos-mcp.mjs` 并连接开发运行时网关，接入方式见 implementation-guide.md 的运行时章节。仅更新扩展不会自动替换已打开页面内的运行时脚本。对 MCP 自有预览窗口，可先 `preview.start`，再调用 `shader.preview.connect` 注入本次构建的桥接；多个网关时用 `gatewayPort` 明确选择。连接会等到目标场景启动并核对场景 UUID。

所有能力通过 `cocos_capability_describe` 获取输入 Schema，通过 `cocos_capability_execute` 调用。`runtime.*` 需要明确选择正确的 `runtimeInstanceId`。输入集合采用 `rows`；材质参数用明确类型表达，不能传任意引擎表达式。

材质属性值可以使用 `{type:"color",value:[255,128,0,255]}`、`{type:"vec4",value:[1,1,1,1]}` 或 `{type:"texture",uuid:"..."}`。颜色使用 Creator 的 0..255 分量。完整 `{r,g,b,a}`、`{x,y,z}` 等分量对象（包括 `__type__: "cc.Color"` 等序列化标记）会归一化为同一协议。数值数组仍表示 uniform 数组，不猜测为向量。`material.properties` 中的 Pass `properties` 是声明信息；写入时应使用 `overrides` 的属性值，不能把带数值 `type` 的声明直接作为值传入。输入格式错误会在调用 Scene 之前指出具体属性和所需格式。

MCP 自有材质、临时场景和 Shader 预览的清理使用 `cc.isValid(object, true)` 检查帧末待销毁状态，避免重复排队；该守卫不修改 Creator 原生 `Node.destroy`。3.8.8 的原生 `MiniPreview.clearByComponent` 报警仍需以原生堆栈和触发操作复现，不能用工具自有资源的回归测试当作其已修复证据。

## 能力表

| 操作 | 参数要点 | 结果或边界 |
|---|---|---|
| shader.environment | 无 | 精确编辑器版本、编译器可用性、运行时要求 |
| shader.preview.connect | 可选 gatewayPort | 将本工程开发网关连接到 MCP 自有预览窗口，不输出凭证 |
| shader.templates | 可选 name | 当前安装引擎的内置 Effect 清单；指定名称才返回源码 |
| shader.read | url | Effect/Chunk/Material 源码和 sourceHash |
| shader.create | url、content | 拒绝覆盖已存在资源 |
| shader.update | url、content、expectedHash | 备份旧版本，通过 AssetDB 保存，读回验证 |
| shader.compile | url、可选 includeSource | 同步原生编译，返回 taskId、依赖、指纹和诊断 |
| shader.validate / inspect | url | 原生校验；inspect 额外返回编译后的 Technique、Pass 和程序 |
| shader.dependencies | url | 本次编译实际读取的 Chunk 路径与哈希 |
| shader.diagnostics | taskId | 持久化结果；重新检查源文件和依赖是否已变化 |
| shader.variants.plan | axes、可选 limit | 宏的笛卡尔积；先检查上限，再生成组合 |
| shader.restore | backupId、expectedHash | 恢复备份并为被替换版本再生成备份 |
| material.query | url | 持久化材质源码与哈希 |
| material.create | url、effectUrl、可选 technique/properties/defines/states/passIndex | 使用真实引擎初始化及编辑器序列化 |
| material.clone | sourceUrl、targetUrl | 创建独立资源；保留源资源 |
| material.update | url、expectedHash、可选 properties/defines/states/technique/passIndex | 在临时 Material 上校验后保存 |
| material.migrate | url、effectUrl、expectedHash、可选 apply | 默认只返回迁移预览；apply=true 才保存 |
| material.properties / defines / states | url | 各 Pass 的声明、显式覆盖、宏和实际状态 |
| material.bindings | url | 当前场景引用及 AssetDB 资源使用者 |
| material.assign | componentId、materialUuid、expectedMaterialUuid、可选 slot | 编辑器属性记录与读回；场景保存是独立步骤 |
| material.apply_runtime | url、expectedHash、properties、可选 defines/states/passIndex | 保存调用者明确选择的参数，不自动覆盖全部运行时状态 |
| runtime.material.inspect | componentId、可选 slot | 运行时材质、各 Pass 和工具所有权 |
| runtime.material.update | componentId、可选 slot/properties/defines/states/passIndex | 编译候选独立实例后绑定；共享材质保持原值 |
| runtime.material.reset | componentId、可选 slot | 只恢复本工具拥有的覆盖；外部修改时拒绝覆盖 |
| runtime.material.compile | componentId、可选 slot | 各 Pass 的 tryCompile 结果 |
| runtime.shader.variants.compile | componentId、axes、可选 slot/limit | 临时实例逐组合编译并释放 |
| runtime.shader.preview.open | materialUuid、可选 shape/width/height | 建立自有几何体、相机和 RenderTexture；shape 为 sphere/cube/quad |
| runtime.shader.preview.update | properties/defines/states/passIndex | 更新预览实例 |
| runtime.shader.preview.capture | 无 | PNG、尺寸、空白检测、baselineId 和编译证据 |
| runtime.shader.preview.compare | baselineId、可选 tolerance | RGB 平均归一化误差、变化像素、差异图 |
| runtime.shader.preview.close | 无 | 恢复相机遮罩并销毁自有资源 |
| runtime.shader.profile | 可选 frames | 真实帧完成事件的帧耗时均值与分位数 |

## 参数示例

```json
{
  "componentId": "目标渲染组件 UUID",
  "slot": 0,
  "passIndex": 0,
  "properties": {
    "threshold": 0.6,
    "tint": { "type": "color", "value": [30, 180, 255, 255] },
    "offset": { "type": "vec2", "value": [0.1, 0.2] },
    "mainTexture": { "type": "texture", "uuid": "纹理资源 UUID" }
  }
}
```

上例展示格式，实际只能提交目标 Effect 已声明且当前变体启用的属性。Color 使用 Cocos Color 的 0–255 分量；Vec2/3/4 和 Mat3/4 使用原始数值。矩阵分别为 9/16 个分量，按 Cocos Mat3/Mat4 构造参数顺序传入。Uniform 数组用上述值组成的数组。`passIndex` 不填时修改所有适用 Pass，不能将一份不兼容参数强行应用到不同类型的 Pass。

```json
{ "axes": { "USE_TEXTURE": [false, true], "MODE": [0, 1] }, "limit": 16 }
```

变体上限默认 64，最大 256；宏必须存在于 Effect 描述且符合类型及范围。宏组合编译不会自动代表该组合已实际绘制，也不会修改材质资源。

## 开发闭环

1. 查询 `shader.environment`，确认精确版本和运行时连接。
2. 从 `shader.templates` 选择当前版本模板，或使用 examples/shaders 中的示例。
3. 通过 `shader.create/update` 写入 Effect，检查保存及导入状态。
4. 调用 `shader.compile`，只在 status=passed 且 stale=false 时继续。保存 taskId。
5. 用 `material.create` 创建材质。读取材质 URL 对应的 UUID，查询目标组件的当前引用，调用 `material.assign`。
6. 通过 `scene.save` 显式保存场景，再重新打开检查持久化引用。
7. 连接开发运行时后，用 `runtime.material.update` 调参。读取结果中的各 Pass 显式覆盖，选择需要保留的属性交给 `material.apply_runtime`。
8. 对通用 3D 材质可直接打开独立 RenderTexture 预览；Sprite/骨骼/粒子使用相应真实组件进行运行时调试和游戏画面截图，不能以 MeshRenderer 测试几何体替代这些顶点输入。
9. 固定示例参数后截取基线，修改参数再 compare，最后 close/reset 释放调试资源。
10. 用既有构建任务接口生成指定平台产物，并在该平台实际运行。保存代码检查、原生编译、运行时和设备验证的独立证据。

examples/shaders/unlit-gradient.effect 是静态 3D 渐变材质；sprite-dissolve.effect 是 Sprite 屏幕坐标噪声溶解。后者保留纹理图集 UV，但未宣称覆盖 RenderTexture 翻转、所有动态图集、遮罩和批处理组合，需要在实际项目中验收。

## 诊断与恢复

原生编译器使用安装包内的 shdc-lib，逐次创建独立词法作用域，避免跨工程和跨版本的 Chunk 缓存污染。仅加载精确版本安装目录内的编译器代码，不执行项目 JS。每次编译重新读取依赖，按实际调用记录依赖哈希。内置和项目 Chunk 同名时拒绝歧义。当前采用 warnings-as-errors；警告也会使编译任务失败。

`shader.compile` 是同步原生调用，返回时任务已经结束。任务文件用于后续查询，不代表异步队列；原生调用执行中不支持取消。诊断行号可能属于展开后的程序，明确标记 generated/unavailable，不伪称已经映射回原 Effect。

资源保存前后检查内容哈希，并通过编辑器队列串行处理本服务请求。外部文件编辑器不参与该队列，最后检查与 AssetDB 保存之间仍有窄并发窗口；这不是跨进程文件系统事务。保存失败后的 backupId 可用于核查和恢复，禁止以全局 Undo 回退其他编辑。

材质迁移在临时对象上完成，逐项列出 retained、removed、incompatible。运行时实例由本工具跟踪；外部更换绑定后 reset 拒绝覆盖。场景切换、运行时断开和 preview.close 会清理自有资源。

## 验证边界

- Creator 原生编译成功只证明 Effect 处理成功。`runtime.material.compile` 报告引擎程序创建结果，驱动编译日志暂不可用；不能据此声称目标设备已完整验收。
- 独立预览复用当前场景光照和引擎时间，不更换主光、不暂停用户游戏。需要确定性比较时使用不依赖时间的示例，并固定场景、相机和曝光；当前不是自动冻结全局时间的渲染沙箱。
- 基线保存在当前运行时内，最多 8 张；关闭预览、切换场景或断开后失效。比较是图像差异检查，不能自动认定美术效果符合需求。
- profile 的时间是整帧墙钟时间，包含场景与调度开销；gpuMs=null。不能当作单个 Shader 的 GPU 性能。
- 内置模板可用于 Surface、多 Pass、骨骼和粒子等源码开发；自定义后处理的管线注册与平台专用渲染接入尚未自动化。
- Creator 2.x、其他 3.x 补丁版本、原生 GPU 日志和跨设备验收均未声明完成。

## 文件与缓存

正式资源创建前先调用 `asset.location`，复用已有类型目录；缺失时通过 AssetDB 创建 Shaders、Materials 等目录。使用实际 `assetLocation.url` 继续操作，禁止散落 assets 根目录。已有资源通过 `asset.organize.plan/apply` 整理，详见 [项目资源整理](asset-organization.md)。工具主动生成的备份、编译记录和测试产物保存在各自工程内：

```text
.codex-work/cache/shader/backups/<backupId>.json
.codex-work/cache/shader/tasks/<taskId>.json
.codex-work/build/
.codex-work/logs/
```

不要把这些运行记录提交到版本库。Creator 自身还会管理 library、temp 和 profiles；它们属于编辑器内部行为。本工具不能据此保证 Creator 的全部内部写入都位于 .codex-work。启动验证时将 TMPDIR/TMP/TEMP、--user-data-dir、--home 明确指向项目 .codex-work 下已创建的目录。
