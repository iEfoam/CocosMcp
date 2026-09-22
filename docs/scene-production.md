# Creator 3.8.8 场景生产与预览

本模块把能量反应堆场景测试中的重复工作收敛为 MCP 能力：类型筛选、持久化参数网格、重复阵列、渲染设置以及独立预览截图。场景资源通过 AssetDB 写入，节点和组件通过 Creator 消息编辑；修改后仍需显式调用 `scene.save`。

所有下列能力通过 `cocos_capability_execute` 调用，参数结构为：

```json
{
  "projectId": "<cocos_projects 返回的项目 ID>",
  "instanceId": "<cocos_instances 返回的实例 ID>",
  "capabilityId": "geometry.create",
  "operationId": "<本次操作唯一 ID>",
  "expectedRevision": "<修改前读取的 revision>",
  "params": {}
}
```

先用 `cocos_capability_describe` 获取当前安装版本的 Schema。重试时先查询操作结果，避免生成重复节点。

版本更新（2026-09-18）：几何体、阵列和渲染配置仍以 **3.8.8** 为准。受控预览、输入、日志与尺寸已独立接入 **2.4.15**；该版本另有 Camera 坐标和 2D Graphics/Mask 像素验收，不等同本文 3.x 几何体或 Shader 预览。见 [版本矩阵](version-support.md)。

## 资源类型筛选

`asset.query` 在类型过滤后计算 `total`、`nextOffset` 与分页结果，类型为精确匹配，不会把目录或其他资源混入指定类型。

```json
{
  "capabilityId": "asset.query",
  "params": {
    "pattern": "db://internal/default_skybox/**",
    "type": "cc.TextureCube",
    "limit": 20,
    "offset": 0
  }
}
```

## 创建持久化几何体

`geometry.create` 支持 `cube`、`cylinder`、`sphere`、`torus`。它先通过 AssetDB 创建 GLTF 和 Mesh 子资源，再创建 MeshRenderer、绑定材质并读回属性。参数化尺寸烘焙在网格中，不需要借助非均匀节点缩放来实现倒角。

```json
{
  "capabilityId": "geometry.create",
  "params": {
    "name": "BeveledPlatform",
    "url": "db://assets/BeveledPlatform.gltf",
    "shape": "cube",
    "materialUuid": "<已有 PBR 材质 UUID>",
    "position": { "x": 0, "y": 0, "z": 0 },
    "options": {
      "size": { "x": 12, "y": 0.4, "z": 8 },
      "bevel": 0.06
    }
  }
}
```

不同形状允许的 `options`：

| 形状 | 参数 | 默认值 |
|---|---|---|
| cube | size、bevel | 单位立方体、bevel=0 |
| cylinder | radius、height、segments | 0.5、1、48 |
| sphere | radius、segments | 0.5、48 |
| torus | radius、tubeRadius、tubeHeight、segments | 1、0.05、与 tubeRadius 相同、48 |

`bevel` 小于最短边一半；`tubeRadius` 小于主半径；`segments` 是 8～128 的整数。Torus 通过 tubeHeight 控制竖向半厚度，可生成扁金属环。所有网格包含法线和 UV，不支持的形状参数会直接拒绝。

已有目标 URL 会被拒绝，不覆盖旧资源。失败信息包含本次资源 URL 和已创建节点 ID；资源可能已经被用户引用，因此不会自动删除导入资源，也不会调用全局 undo。创建成功不等于场景已保存。

## 创建楼梯或墙面阵列

`geometry.array` 复制整个源节点子树。`count` 表示额外复制数量，原节点保留；变换在源节点父坐标系下计算，各副本相对于源节点累加偏移。

```json
{
  "capabilityId": "geometry.array",
  "params": {
    "nodeId": "<第一级台阶节点 UUID>",
    "count": 10,
    "offset": { "x": 0, "y": 0.265, "z": -0.46 },
    "rotationStep": { "x": 0, "y": 0, "z": 0 },
    "namePrefix": "MezzanineStep"
  }
}
```

最多复制 100 个根节点，每个结果读回变换。失败时返回已完成的 `rows` 和 `incompleteNodeId`，不会隐藏半完成状态。源子树本身可能很大，调用方应控制规模。

## 渲染配置与反射

`rendering.query` 返回实际场景全局设置、可选相机设置，以及支持边界。

```json
{
  "capabilityId": "rendering.configure",
  "params": {
    "cameraNodeId": "<Camera 所属节点 UUID>",
    "lightComponentId": "<DirectionalLight 组件 UUID>",
    "bloom": { "enabled": true, "threshold": 1.1, "intensity": 0.25, "iterations": 3 },
    "fxaa": true,
    "editorPreview": true,
    "shadows": { "enabled": true, "resolution": 2048, "pcf": 2, "bias": 0.0005, "normalBias": 0.035 }
  }
}
```

如果相机缺少 `BuiltinPipelineSettings`，会添加这一组件。配置已有组件时保留其他设置。阴影采用真实 ShadowMap；开启时要求明确指定方向光。跨多个组件的修改不宣称全局原子回滚，失败返回 `completed`。`editorPreview` 是引擎的 experimental 预览选项。

```json
{
  "capabilityId": "rendering.planar_reflection",
  "params": {
    "name": "FloorReflection",
    "cameraComponentId": "<Camera 组件 UUID>",
    "rendererComponentIds": ["<地面 MeshRenderer 组件 UUID>"],
    "position": { "x": 0, "y": 0.09, "z": 0 },
    "size": { "x": 6, "y": 0.35, "z": 5.5 },
    "resolution": 512
  }
}
```

探针绑定指定相机和最多 200 个 MeshRenderer。配置前检查所有组件类型和可编辑字段；节点、探针和材质引用随后由 Creator 的属性读回校验。

**HBAO 和物理透射边界：**这组工具针对 Builtin 管线配置。传 `ambientOcclusion: "hbao"` 或 `transmission: "physical"` 会在任何修改之前返回 `UNSUPPORTED_CAPABILITY`，因为实际效果需要兼容的自定义渲染管线和 Effect。工具不自动更换全工程管线，也不会创建接地暗片或用 Alpha 混合冒充真实效果。可结合 Shader/Material 工具开发专用 Effect，但 GPU 结果仍需真实预览验收。

## MCP 管理的预览与截图

安装更新不会启动 Creator 或要求登录。由用户自行打开 Creator 工程后，才可调用：

1. `scene.save` 保存当前场景。
2. `preview.start`，例如 `{"width":1280,"height":800,"visible":true}`。
3. `preview.status` 查询窗口状态与最近的 warning/error；`pageReady` 仅表示页面加载完成。
4. `preview.capture` 等待游戏实际绘制帧、核对目标场景并返回 PNG。
5. `preview.stop` 只关闭 MCP 创建的预览窗口。

预览窗口使用受限的临时 Electron 会话，不开放 Node.js，不接受跨源导航、弹窗或设备权限。它读取 Creator 返回的本机预览 URL，不修改全局启动场景配置。当前窗口已预览其他场景时，先 stop 再 start，不自动切换。场景未保存时拒绝启动，不自动保存用户修改。

`preview.capture` 不依赖开发运行时网关；返回 `source: managed-preview-window`，内容为预览窗口截图，可能包含 Creator 预览工具栏，不冒称纯游戏 Canvas。工具响应含标准 MCP `image` 内容，并保留结构化 `dataUrl` 兼容旧客户端。捕获前会检查实际 scene UUID，加载错误、目标不符或无绘制帧时明确失败。

原 `runtime.capture` 仍要求开发运行时连接。此模块不自动注入运行时桥接，也不扩大到修改用户浏览器或关闭其他预览窗口。

## 验证与更新边界

自动化覆盖类型过滤/分页、网格索引及法线/绕序、阵列变换和部分失败、预览窗口隔离/失败释放、截图帧条件、MCP 图片输出、渲染属性映射和参数限制。

本次按用户要求不启动 Creator，测试通过和扩展安装仅证明源码、适配器与制品阶段；真实 Creator 预览、GPU 着色、反射与 Bloom 观感尚待用户打开后验收。不要将组件注册、页面加载或 `scene.validate` 等同于最终画质验收。
