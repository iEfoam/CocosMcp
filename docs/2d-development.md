# 2D 开发与功能扩展

本文详细调用流程面向 **Creator 3.8.8**，记录该批 33 项新增能力和 13 种可编辑脚本模板，数字是历史增量。Creator **2.4.15** 已独立适配 SpriteFrame、动画、UI、Tilemap、骨骼、物理与预览子集，但不提供这些 3.x 模板及全部操作；见 [版本矩阵](version-support.md)。其他小版本和发布平台需分别验证。

这是编辑器生产与开发运行时工具。模板生成后仍需绑定工程中的节点、资源和业务事件；生成成功不表示完整玩法已经验收。实现与实测范围见 [交付与验证记录](2d-implementation.md)。

## Creator 2.4.15 阅读入口

2.4.15 已有控件真实输入、正交/等距地图、普通碰撞、Box 接触、骨骼缓存/事件、Tween 和 2D Camera 像素记录。不能复用本文 3.x 的原生轨道、UITransform、物理后端或模板实现。Node 映射、curveData、Box2D 单位与缓存限制见 [适配记录](creator2-implementation.md)。TMX 持久化、2.x 模板及完整字体图集质量流程仍未完成。

## 能力入口

先通过 `cocos_capability_describe` 查看参数，再通过 `cocos_capability_execute` 调用。以下示例展示 `capabilityId` 与 `params`；实际调用还需传当前 `projectId`，多实例时指定目标实例。运行时工具需要开发预览已连接。

| 方向 | 能力 | 产出与边界 |
| --- | --- | --- |
| SpriteFrame | `spriteframe.inspect/plan/apply/restore` | 检查导入元数据、修改九宫格与 packable、备份和指纹恢复；保留纹理采样 |
| 2D 动画 | `animation2d.plan/create` | 原生 SpriteFrame、UIOpacity、Color 轨道和动画事件；创建后单独绑定 Animation |
| UI | `runtime.ui.inspect/hit_test/assert` | 布局、原生命中候选、文本/激活/按钮状态断言 |
| 渲染诊断 | `runtime.render2d.audit`、`runtime.label.audit`、`runtime.atlas.inspect` | 合批候选、Mask 边界、文字缓存与动态图集公开状态 |
| 物理 | `runtime.physics2d.test_point/test_aabb/trace_contacts` | 当前物理世界查询、有界真实帧接触采样；不主动步进 |
| Spine | `runtime.spine.inspect/play/set_skin/set_attachment/trace` | 命名动画、皮肤、附件和轨道采样；不覆盖项目事件监听 |
| Tilemap | `runtime.tilemap.inspect/query_region/plan/apply` | 图层/对象组、区域 GID 与翻转位、守卫式运行时修改 |
| UI 模板 | `ui.template.plan/build` | menu、inventory、hud、dialogue 节点树和稳定节点映射 |
| 游戏组件 | `gameplay2d.templates/plan/apply` | 固定模板源码审查、AssetDB 创建脚本、编译后挂载 |
| 关卡 | `level2d.plan/apply` | 固定种子的预制体网格和抖动分布，最多 200 个实例 |
| 网格寻路 | `navigation2d.find_path` | 四邻接等权网格最短路径，最大 128×128 |
| 多尺寸预览 | `preview.validate_viewports` | 最多 8 个尺寸截图，结束恢复原窗口尺寸 |

现有 `preview.input` 新增 `drag`、`long_press`、`key`、`touch_drag`、`touch_cancel`。UI 文档新增 `cc.SafeArea`、`cc.BlockInputEvents`、`cc.UIOpacity` 白名单组件。

## SpriteFrame 修改与恢复

1. `spriteframe.inspect` 查询原图 URL；存在多个 SpriteFrame 时明确选择 `spriteFrameUuid`。
2. 调用 `spriteframe.plan`，检查计划中的子资源、引用者、前后差异。
3. 使用相同参数加返回的 `planHash` 调用 `spriteframe.apply`。
4. 保存返回的 `backupId` 与 `expectedHash`；需要恢复时交给 `spriteframe.restore`。

```json
{
  "capabilityId": "spriteframe.plan",
  "params": {
    "url": "db://assets/Textures/Button.png",
    "spriteFrameUuid": "已导入的 SpriteFrame UUID",
    "settings": { "borderLeft": 12, "borderRight": 12, "borderTop": 8, "borderBottom": 8 }
  }
}
```

边距不能超出帧宽高。修改经 AssetDB 保存、重导入，等待子资源导入状态和指纹稳定后再返回恢复令牌。原图、UUID 或元数据已被其他操作改动时拒绝旧计划/恢复，不覆盖后续修改。`packable=true` 只代表资格，不保证已经打入动态图集；像素风 nearest 采样不会被自动改成 linear。

当前不提供像素裁剪、透明边界自动检测或图集重新排版写回。

## 创建序列帧与 UI 动画

```json
{
  "capabilityId": "animation2d.plan",
  "params": {
    "url": "db://assets/Animations/PlayerWalk.anim",
    "rootId": "角色节点 UUID",
    "document": {
      "name": "PlayerWalk", "duration": 0.2, "loop": true,
      "tracks": [
        { "path": "", "kind": "spriteFrame", "keys": [
          { "time": 0, "value": "第一帧 SpriteFrame UUID" },
          { "time": 0.1, "value": "第二帧 SpriteFrame UUID" }
        ] },
        { "path": "", "kind": "opacity", "keys": [
          { "time": 0, "value": 255 }, { "time": 0.2, "value": 180 }
        ] }
      ]
    }
  }
}
```

使用同一参数与 `planHash` 调用 `animation2d.create`。`path` 相对根节点，空字符串指根节点；每段路径必须唯一。SpriteFrame/Color 需要目标节点恰有一个 Sprite，opacity 需要恰有一个 UIOpacity。序列帧为离散轨道；颜色与透明度支持 linear/constant。最多 64 轨、总计 4000 个关键帧。

可选 `events: [{"time":0.1,"method":"attack","params":["left"]}]`。事件必须在根节点找到唯一接收组件，规划时不执行方法；生命周期和销毁入口被拒绝。播放时事件会调用项目业务逻辑。创建不会覆盖已有资源，也不会自动播放；用现有 `component.set` 绑定 Animation 的 clips/defaultClip，并显式保存场景。

## 可编辑组件模板

先查询 `gameplay2d.templates`，按返回的 bindings 配置依赖。调用 `gameplay2d.plan` 后检查完整源码，再以相同参数和 `planHash` 调用 `gameplay2d.apply`。

```json
{
  "capabilityId": "gameplay2d.plan",
  "params": {
    "template": "camera", "className": "PlayerCamera",
    "url": "db://assets/Scripts/PlayerCamera.ts", "nodeId": "相机节点 UUID"
  }
}
```

| template | 已有功能 | 必须配置/业务接口 |
| --- | --- | --- |
| `camera` | 跟随、死区、中心边界、震屏、正交缩放 | target、同节点 Camera；地图边界须扣除视口半尺寸 |
| `controller` | 横版/俯视移动、跳跃缓冲、离地宽限 | Dynamic RigidBody2D、碰撞体、地形 mask；attack/movement-state 事件 |
| `joystick` | 单指摇杆、半径约束、取消归零 | UITransform、可选 knob；joystick-change 事件 |
| `pool` | 容量限制、借出/回收统计、所有权守卫 | Prefab；pool-acquire/pool-release 中重置业务状态 |
| `effects` | 飘字、飞向目标、淡出 | UIOpacity、可选 Label/target；effect-complete 回收 |
| `burst` | 已有粒子与音效组合播放/停止 | ParticleSystem2D、可选 AudioSource；关闭粒子自动销毁 |
| `hitbox` | 攻击窗口、已有重叠检测、每窗口去重 | sensor Collider2D、碰撞组/contact listener；hitbox-hit |
| `dialogue` | 数据校验、文本、分支选择、结束事件 | JsonAsset 与 Label；业务负责选项 UI、条件和奖励 |
| `patrol` | 世界坐标路点、循环/完成 | waypoints；不自动绕障，不接管动态刚体 |
| `parallax` | 相机位移驱动视差 | camera、factor |
| `ui` | 子树按钮动作转发、文本和显隐接口 | ui-action 传按钮节点名；不自动购买、发奖励或暂停全局 |
| `virtual_list` | 固定行高复用，最多 200 行节点 | 顶部锚点专用 content、rowPrefab、data.json.rows；virtual-row 绑定显示 |
| `spine_socket` | 骨骼挂点位置与平面方向同步 | 实时 Spine、boneName、target；不自动换装或复制骨骼缩放 |

生成脚本不接受任意代码片段；类名和文件名必须一致，拒绝覆盖已有脚本/注册类。编译超过等待窗口或场景发生变化时返回已创建资产证据，先检查后补挂载，不能重复创建。返回的 `configured:false`、`runtimeVerified:false` 是待完成的工程配置与验收，不应被忽略。

对白数据示例：

```json
{ "start": "intro", "rows": [
  { "id": "intro", "text": "准备出发？", "choices": [{ "label": "出发", "next": "end" }] },
  { "id": "end", "text": "一路顺风。", "choices": [{ "label": "关闭", "next": null }] }
] }
```

## UI 与真实输入验收

`ui.template.build` 返回节点映射，不附带业务行为；可以再在 rootId 上生成 `ui` 模板。HUD 文案为占位内容，必须接入项目数据。`runtime.ui.assert` 接收 `rows:[{nodeId,active,text,interactable}]`，比较当前状态；`active` 表示层级有效激活，文字目前针对 Label。

`runtime.ui.hit_test` 使用引擎屏幕坐标和原生 UITransform.hitTest，返回候选，不代表最终事件接收者。`preview.input` 使用 MCP 预览内容区域的 DIP 坐标；两者不能直接混用，需考虑 Creator 预览工具条、画布位置与 DPR。

推荐验收顺序：订阅业务事件 → 发送一次真实输入 → 读取事件 → 断言 UI 状态 → 截图审查 → 取消订阅。手势最多 2 秒、60 步；触摸仅使用 MCP 自有调试器，结束或失败后释放触点。输入可能已经触发业务副作用，未知结果先检查，不盲目重放。

多尺寸捕获示例：`preview.validate_viewports({rows:[{width:390,height:844},{width:1024,height:768}]})`。工具返回真实图像但 `layoutVerified:false`，需要审查遮挡、裁切与文字；发生场景切换时不恢复到未知新场景。该流程不替代手机安全区、软键盘、多指或真机 GPU 测试。

## Spine、地图、物理与性能边界

- Spine 轨道采样按真实帧执行，最多 300 帧；不覆盖 Spine 单槽事件回调。缓存模式的多轨/排队、附件修改不在当前适配范围，DragonBones 未新增专用流程。
- Tilemap 的 inspect 使用 TiledMap componentId；区域和修改使用 TiledLayer componentId。区域最大 64×64，修改最多 512 格；旧会话、受影响单元格变化、重复坐标与非法 flags 会拒绝。修改仅在运行时生效，**不保存 TMX/TSX**。
- 物理点/矩形使用世界坐标，结果立即复制。接触采样最多 32 个碰撞体、300 帧、512 条事件；空结果不能证明没有碰撞，需确认项目碰撞组与 contact listener。
- 合批诊断只比较层级候选的材质、纹理、层与 Mask，**不报告真实 draw call 降幅**；Sorting2D、多相机、缓冲区和 GPU 行为仍需性能实测。
- `level2d` 生成位置但不证明无碰撞或关卡可玩；`navigation2d` 返回格点路径，不驱动物理角色、不包含动态避障。

所有新增资源入口复用 `asset.location` 和 AssetDB。使用返回的真实 URL/UUID，场景修改完成后显式保存。部分失败时检查 `completed`、`pending`、`created`，保留已有成果再制定补偿方案。
