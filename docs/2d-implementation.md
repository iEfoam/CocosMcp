# 2D 加强与功能扩展交付记录

本记录对应“面向 2D 的基础加强”和“功能扩展”两部分。本次交付的是有边界的第一版实现：核心编辑、诊断、生产和模板接口已接入能力目录，复杂玩法与平台验收不以接口存在代替。使用步骤见 [2D 开发指南](2d-development.md)。

## 方案落地对应

| 方案 | 方向 | 本次实现 | 尚未覆盖 |
| --- | --- | --- | --- |
| 基础加强 | SpriteFrame/图集 | 九宫格与 packable 计划、修改、备份恢复；采样资格诊断 | 像素裁剪工具、图集重新排版 |
| 基础加强 | UI 适配/命中 | 原生命中候选、状态断言、SafeArea 等文档组件、多尺寸截图 | 真机安全区/软键盘、多指、自动视觉判分 |
| 基础加强 | 2D 动画 | 序列帧、透明度、颜色原生轨道及事件 | 可视化时间轴、完整动画状态机生成 |
| 基础加强 | 性能诊断 | 材质/纹理/层/Mask 候选、Label 缓存、动态图集状态 | 精确 draw-call 归因、GPU 性能收益证明 |
| 基础加强 | Spine | 动画、队列、皮肤、附件、轨道采样 | 完整 Spine 事件流、缓存模式多轨、DragonBones 专用操作 |
| 基础加强 | Physics2D | 点/矩形查询、真实帧接触采样、空 JS Box2D 世界兼容 | 所有后端/平台验证、自动碰撞配置修复 |
| 基础加强 | Tilemap | 图层、对象组、区域 GID/flags、守卫式运行时写入 | TMX/TSX 源文件写回、地图编辑器 |
| 功能扩展 | UI 生产 | 菜单/背包/HUD/对白树、按钮动作脚本、固定行高虚拟列表 | 自适应行高、完整背包经济/存档系统 |
| 功能扩展 | 角色/交互 | 横版/俯视控制器、摇杆、攻击窗口 | 项目动画绑定、完整战斗/移动平台机制 |
| 功能扩展 | Spine 装配 | 实时骨骼挂点跟随和已有皮肤/附件切换 | 装备资源管理、骨骼缩放/完整换装业务 |
| 功能扩展 | 关卡/地图 | 固定种子预制体布置、格点路线、路点巡逻 | 可玩性求解、动态避障、程序化地图主题规则 |
| 功能扩展 | 镜头/表现 | 跟随/边界/震屏/缩放、视差、飘字/飞入、粒子音效组合 | 镜头穿透避障、全套美术资源、设备性能预算 |
| 功能扩展 | 通用业务 | 数据分支对白、有容量与所有权约束的对象池 | 剧情条件/奖励、全局存档、通用业务状态重置 |

## 实现位置

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 能力契约 | `packages/capability-catalog/src/two-d.ts` | 33 项 Schema、版本与副作用分类 |
| 动画文档 | `packages/animation-core/src/two-d.ts` | 轨道/事件校验、预算和路径约束 |
| 模板与算法 | `packages/gameplay2d-core/src/templates.ts`、`planning.ts` | 13 种固定组件、UI 树、种子布局、格点寻路 |
| 编辑器生产 | `packages/creator3-adapter/src/two-d-production.ts` | AssetDB、计划指纹、编译注册、挂载、部分失败证据 |
| 图片导入 | `packages/creator3-adapter/src/texture.ts` | SpriteFrame 子资源修改、导入稳定等待、恢复守卫 |
| 运行时读取 | `packages/runtime3-bridge/src/two-d-inspector.ts` | UI 状态/命中、渲染与图集候选 |
| 运行时控制 | `packages/runtime3-bridge/src/two-d-control.ts`、`physics.ts` | Spine、Tilemap、接触采样与物理查询 |
| 原生动画 | `packages/runtime3-bridge/src/animation-two-d.ts` | 原生轨道序列化、资产引用与唯一目标验证 |
| 预览输入 | `extensions/creator3/src/preview.ts` | 鼠标/键盘/触摸释放、窗口前台与场景守卫 |

创建资源前统一复用 `asset.location`；失败保留实际 UUID、created/completed/pending，避免重复创建。代码未修改 Cocos 引擎或第三方库，也未接入生产服务。

## 源码核对与兼容修复

核对基线为本机安装的 **Creator 3.8.8** 引擎源文件与声明，不把其他分支 HEAD 当成 3.8.8：

- `cocos/2d/framework/ui-transform.ts`：调用公开 `hitTest`，不自行重建事件分发规则。
- `cocos/animation/tracks/` 与 AnimationClip：使用 ObjectTrack、RealTrack、ColorTrack、TrackPath 与原生事件结构。
- `cocos/physics-2d/framework/physics-system.ts`、`box2d/physics-world.ts`：查询当前世界并复制结果。
- `node_modules/@cocos/box2d/src/collision/b2_dynamic_tree.js` 与 `common/b2_growable_stack.js`：空树 Query 推入 null，Pop 抛无消息 Error。插件仅在 3.8.8 JS Box2D 的公开 `GetProxyCount()===0` 时返回空查询，不吞非空世界的原生错误。
- AssetDB 原生实测发现 `reimport-asset` 返回后子资源仍可处于 `imported=false`、files 未稳定状态。现在等待导入完成且相邻完整指纹一致，再返回恢复令牌。
- macOS 原生预览发现窗口 focus 与应用获得前台存在延迟。仅在用户请求输入时激活 Creator，并等待自有预览获得焦点；不会向其他窗口投递输入。

## 验证与证据

验证日期：2026-09-16。原生环境：macOS / Apple Silicon、Creator 3.8.8、JS Box2D、MCP 自有预览。

最终本地构建 `18da33036145` 已安装并在专用测试工程重载。最终原生报告包含 75 次成功调用（包含查询与清理，不是 75 项不同能力）；构建前后功能源码相同，最后构建补入最新测试证据。源码指纹匹配的自动测试证据为 23 组。

| 验证层级 | 结果与范围 |
| --- | --- |
| TypeScript | 仓库 `tsc --noEmit`；13 个生成组件逐个对安装版 `cc.d.ts` 编译 |
| 自动回归 | 完整 175 项测试通过；含旧计划拒绝、模板行为、采样保留、导入异步稳定、空 Box2D 世界、Tilemap 部分失败、监听清理、输入序列释放、预览会话替换时禁止恢复旧尺寸 |
| 原生资源 | 图片经 AssetDB 导入；九宫格修改后恢复；原生三类轨道创建、保存重开并检查轨道保留；脚本编译与挂载 |
| 原生预览 | 菜单真实 click 产生 ui-action；drag、touch_cancel、Space 输入；布局/命中/Label/图集/合批诊断调用；点和 AABB 命中实际碰撞体；禁用碰撞体后空点查询返回零 |
| 图像审查 | 800×600、390×844、1024×768 自有窗口截图；窗口恢复原尺寸，菜单与测试 Sprite 可见；不是美术品质或真机适配验收 |
| 清理 | 预览错误日志为空，停止本次预览，恢复原场景且 dirty=false |

本机复查入口：

- `scripts/two-d-native.ts`：真实编辑器验收；报告 `.codex-work/logs/two-d-native.json`，截图 `.codex-work/build/two-d-*.png`。
- `scripts/check-gameplay2d-types.ts`：输出到 `.codex-work/build/gameplay2d-types/`，校验所有模板。
- `tests/two-d.test.ts`、`tests/gameplay2d-behavior.test.ts`、`tests/texture.test.ts`、`tests/preview-input.test.ts`。
- `.codex-work/logs/two-d-tests.log`、`two-d-build.log` 为本次本地检查记录，不提交缓存或截图到正式 assets。

原生脚本初次创建资源，后续复用同一 UUID，不能把重复运行误报为每次都重新创建成功。报告中的 `screenshotReviewRequired` 表示脚本本身不自动判图；本次另行人工式图像审查。能力目录只将与源码指纹匹配的测试映射提升为 adapter-tested，不将整组能力统一标成原生验证。

**尚无真实 Spine/TMX 资产专项验收，也未完成所有 13 模板的完整玩法测试。** 接触事件采样已有断连清理测试，尚未证明各后端的接触事件序列。Windows、其他 Creator 版本、原生设备、小游戏、WebGL/GPU 性能另行验收。本次没有发布商店、提交 Git 或部署生产环境。

## 维护与复验

按项目标准先 typecheck，再 build、test、build，使最后构建携带当前源码的测试证据。所有命令通过 `scripts/project-env.mjs` 设置项目内缓存/临时目录。原生验证在专用测试工程进行，执行前要求原场景已保存、没有已有 MCP 预览；结束恢复场景，不自动关闭用户 Creator。

以后扩展裁剪、TMX 持久化或高级玩法时，应补独立 Schema、精确资产/场景守卫、部分失败恢复策略和真实样例；不应通过通用脚本执行绕过资源目录、版本或所有权约束。
