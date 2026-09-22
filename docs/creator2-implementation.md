# Creator 2.4.15 适配与验收

更新日期：2026-09-18。以本机 Creator **2.4.15** 随包引擎/编辑器源码及仓库版本适配为依据；其他 2.x 小版本不自动继承验证。按版本功能总览见 [版本支持矩阵](version-support.md)，完整第二轮范围见 [验收台账](creator2-expansion-tracker.md)。

## 当前支持范围

源码显式登记最多 **112 个编辑器入口、99 个运行时入口**。编辑器部分为 55 个基础、45 个精确版本场景、9 个预览、3 个依赖宿主的设置/场景脚本入口。数量来自 `creator2-support.ts` 与适配器 supportedCapabilities，不代表原生验收数量或当前会话可用数量。

| 领域 | 已实现及已有原生证据 | 仍有边界 |
| --- | --- | --- |
| 编辑器 / 资源 | 场景与节点组件、Undo/Redo、Prefab、AssetDB、目录整理、依赖/使用者、导入与恢复 | 配置未逐项原生验收；字符串/二进制引用不保证完整 |
| UI / 引用 | 声明构建和字段更新、结构计划/应用、直接引用和事件删除守卫、保存文件 UUID 审计 | Prefab 实例差异及计划修复、历史 null 引用待补；UITransform/UIOpacity 映射到 Node |
| 真实控件 | ScrollView/PageView/Slider/Toggle/EditBox 操作、输入和事件，含 Toggle 禁用/遮挡与取消订阅 | 赋值不等于真实输入；最终输入接收路径、多分辨率安全区仍待扩展 |
| 运行时资源 | 加载释放、Bundle 只读、缓存快照/差异/趋势，连续切场景测试 | 加载轨迹、真实业务长周期泄漏分析未完成 |
| 动画 / 骨骼 | curveData 编辑恢复、有界 Tween；Spine/DragonBones 结构、缓存边界、事件、实时混合 | 缓存姿态/负载不可伪造；复杂视觉结果与完整曲线组合未覆盖 |
| TiledMap / 碰撞 | 正交等距 GID/翻转及恢复；普通三类碰撞、矩阵、业务回调共存 | TMX 不持久化；物理接触形状不等同普通碰撞形状验收 |
| Box2D / Camera | 刚体力/冲量、DistanceJoint、Box 接触四阶段与生命周期；2D/3D 坐标、2D Graphics/Mask 像素与 GPU 对象删除 | 其他七类关节、非零切向冲量、3D 模型像素等未逐项验收 |
| 材质 / 媒体 / 预览 | Effect 源码/备份、材质属性宏与运行时恢复；粒子/媒体基础控制；自有窗口截图输入、帧与 DrawCall 采样 | 非 Creator 3 编译器和变体接口；媒体调用不等于视听体验，帧时间不等于 GPU 时间 |
| 视图 / 构建 | view.query/部分 view.set、CLI 构建任务与失败状态 | focus/grid 拒绝；Web Desktop、FBX 环境问题尚未修复 |

普通 Animation 的通用 blend 尚未适配；这不影响已实现的 Spine 实时动画对 mix 与 DragonBones 六类 fade。2.x 管线状态写入、3D raycast mask 映射及 3.x 几何体/玩法模板不作等价支持承诺。

`PhysicsManager.testPoint/testAABB` 原生只查询动态刚体，返回结果标注这一限制；物理系统应在刚体 onEnable 前启用。运行时组件 ID 与编辑器 ID 不同，连接后重新读取 `runtime.hierarchy`。

## 独立工程与复现

工程在仓库 `.codex-work/build/creator2-test-project`，使用固定工程身份，不修改 Texas 业务资源。本轮第二轮新增能力尚未同步 Texas。资源先查询 `asset.location`，再经 AssetDB 创建/导入；不得直接改 `.meta`。

```sh
node scripts/project-env.mjs node scripts/build.mjs
node scripts/project-env.mjs node scripts/creator2-project.mjs
node scripts/project-env.mjs node .codex-work/build/server/cli.mjs install --project "$PWD/.codex-work/build/creator2-test-project" --creator /Applications/Cocos/Creator/2.4.15/CocosCreator.app
node scripts/project-env.mjs node scripts/creator2-project.mjs --launch
```

原生脚本只能用于此独立工程，按依赖顺序逐个运行，不能并发操作同一场景/预览。`creator2-controls-native.ts` 创建专用控件场景；其后的结构、引用、资源、物理、Camera、Tween、骨骼脚本复用或创建各自夹具。骨骼和地图测试还依赖已导入的对应样例资源，缺失应先准备，不能把缺失测试当通过。

以接触验收为例，先运行基础接触脚本创建夹具，再运行生命周期脚本；各脚本结束关闭自己的预览和网关：

```sh
node scripts/project-env.mjs node --input-type=module -e 'import {build} from "esbuild"; for (const name of ["creator2-physics-contact-native", "creator2-physics-contact-lifecycle-native"]) await build({entryPoints:[`scripts/${name}.ts`],outfile:`.codex-work/build/${name}.mjs`,bundle:true,platform:"node",format:"esm",packages:"external"});'
node scripts/project-env.mjs node .codex-work/build/creator2-physics-contact-native.mjs
node scripts/project-env.mjs node .codex-work/build/creator2-physics-contact-lifecycle-native.mjs
```

基础验收入口仍为 `scripts/creator2-native.ts`、`creator2-extra-native.ts`；构建验收为 `creator2-build-native.ts`，须先关闭该工程 GUI，不能 GUI 与 CLI 同时导入同一工程。脚本创建/修改测试夹具，不可改为业务工程执行。

## 报告与边界

最近代码回归为 **249/249**，类型检查与扩展构建通过。第一轮的 187 项自动测试、134 个成功调用入口是历史统计，不能作为当前入口总数或全参数验收数。

| 本地报告 | 证据 |
| --- | --- |
| `.codex-work/logs/creator2-expansion-regression.log` | 最近完整自动回归 |
| `.codex-work/logs/creator2-native/report.json`、`extended-report.json` | 第一轮基础原生调用与断言 |
| `.codex-work/logs/creator2-expansion/` | 第二轮各领域原生报告，具体名称和限制见台账 |
| `physics-contact.json`、`physics-contact-lifecycle.json`（上列目录内） | Box 接触、单位、sensor、观察组件清理、断连与切场景、业务回调继续 |
| `physics-contact-lifecycle-paused-failure.json`（同目录） | 帧超时现场 gamePaused=true、directorPaused=false，不推断具体暂停触发源 |
| `.codex-work/logs/creator2-native/build-report.json` | 游戏 CLI 构建失败与日志路径 |

共享 FrameSession 超时附带 `gamePaused`、`directorPaused`、`timeoutMs`，不自动恢复游戏。测试脚本只有在自己拥有的预览内才显式 resume；不修改业务隐藏事件监听。

Web Desktop 实际构建在 Creator 自带 build-worker 抛出 `Cannot read property 'exportSimpleProject' of undefined`，退出码 1；另有 FBX 转换器 `spawn Unknown system error -86`。有中间目录不能标记构建成功。尚未修复安装环境、验证 FBX 导入或各原生 SDK/设备构建，其他独立功能可继续验收。

受控临时、缓存和输出路径均在工程 `.codex-work`；Creator 自身的 library/local/temp 为第三方内部流程，未宣称全部内部写入已审计。保存本地报告不等于证据已被能力目录映射为 current-source，见 [验收状态说明](capability-verification.md)。完整 16 域及后续新增范围仍有未完成项，不能表述为全功能验收完成。
