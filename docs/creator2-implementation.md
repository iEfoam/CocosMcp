# Creator 2.4.15 适配与验收

本次实现以安装的 Creator **2.4.15** 原生 API 和 [cocos-engine v2.4.15](https://github.com/cocos/cocos-engine/tree/v2.4.15) 为依据。其他 2.x 小版本不自动继承新增能力的验证状态。

## 范围与边界

当前显式支持列表提供 **108 个编辑器入口、63 个运行时入口**，分别由编辑器宿主和已连接的预览桥接提供。数量来自 `packages/capability-catalog/src/creator2-support.ts`，编辑器入口还要求对应宿主方法存在。不要把它们与全局目录总数或原生验收数混用。

| 范围 | 已实现 | 原生验证与限制 |
| --- | --- | --- |
| P0 编辑器基础 | 环境查询、场景与节点组件操作、原生 Undo/Redo、脏状态保护、Prefab、选择与配置 | 创建、修改、撤销重做、保存重开、Prefab 应用/还原/解绑读回通过；配置写入、视图设置等尚未逐项原生覆盖 |
| P1 资源 | 集中目录策略、整理计划守卫、AssetDB CRUD、引用扫描、Texture/SpriteFrame 计划应用恢复 | UUID 保留、资源读回、导入设置恢复通过；动态脚本加载与二进制引用明确不在扫描完整性保证内 |
| P2 UI | 声明式 plan/build/diff/apply、布局与事件诊断；UITransform/UIOpacity 映射到 2.x Node | 创建与更新通过；结构变化须重新构建；命中候选不保证最终事件接收者 |
| P3 预览与运行时 | 2.x bootstrap、受控窗口、截图、输入、尺寸、资源句柄及会话清理 | 预览连接、资源加载释放、截图、键盘输入与关闭通过；未验收真机或独立浏览器 |
| P4 动画与媒体 | 原生 curveData、clip 修改恢复、2D 动画、Spine、DragonBones、粒子、Audio/Video、2D 诊断 | 动画采样修改恢复、骨骼控制、粒子和媒体调用通过；媒体调用成功不等同人眼/人耳体验验收；Spine attachment 尚未逐项覆盖 |
| P5 材质物理构建 | Effect 源码和备份、材质创建/复制/修改、运行时变体恢复、Box2D 查询、真实帧与 DrawCall 采样、CLI 参数适配 | 材质连续修改恢复、物理命中和帧采样通过；Web Desktop 构建实际尝试失败，见下文 |

下列能力保持不支持或不作等价承诺：Creator 3 专属 gfx/Shader 编译器及变体接口、管线状态写入、3D raycast 的 mask 映射、动画混合、未核实的视图 focus/grid 写入。整帧耗时不能作为单个 Shader GPU 时间；3D manager 可查询不等于模型导入或 3D 全流程通过。

2.4.15 的 `PhysicsManager.testPoint/testAABB` 原生只查询动态刚体，返回结果显式说明；raycast 可用于其他刚体。物理世界需在刚体进入 onEnable 前启用。组件运行时 ID 与编辑器 ID 不同，连接后须重新读取运行时层级。

## 独立工程与复现

工程位于仓库 `.codex-work/build/creator2-test-project`，含自己的 project.json、assets、settings 和 packages，不修改 Texas 业务资源。所有测试资源先调用 `asset.location`，随后通过 AssetDB 创建或导入；临时报告不进入 assets。

```sh
node scripts/project-env.mjs node scripts/build.mjs
node scripts/project-env.mjs node scripts/creator2-project.mjs
node scripts/project-env.mjs node .codex-work/build/server/cli.mjs install --project "$PWD/.codex-work/build/creator2-test-project" --creator /Applications/Cocos/Creator/2.4.15/CocosCreator.app
node scripts/project-env.mjs node scripts/creator2-project.mjs --launch
```

测试入口 `scripts/creator2-native.ts`、`scripts/creator2-extra-native.ts`、`scripts/creator2-build-native.ts` 用仓库 esbuild 打包为 `.codex-work/build/*.mjs` 后执行。构建测试前须关闭该测试工程的 GUI 实例，不能与 CLI 同时导入同一工程。测试会对该独立工程创建与修改夹具，不得指向业务工程。

```sh
node scripts/project-env.mjs node --input-type=module -e 'import {build} from "esbuild"; for (const name of ["creator2-native", "creator2-extra-native", "creator2-build-native"]) await build({entryPoints:[`scripts/${name}.ts`],outfile:`.codex-work/build/${name}.mjs`,bundle:true,platform:"node",format:"esm",packages:"external"});'
node scripts/project-env.mjs node node_modules/typescript/bin/tsc --noEmit
node scripts/project-env.mjs node scripts/test.mjs
node scripts/project-env.mjs node scripts/build.mjs
node scripts/project-env.mjs node .codex-work/build/creator2-native.mjs
node scripts/project-env.mjs node .codex-work/build/creator2-extra-native.mjs
# 仅在测试工程 GUI 关闭后执行：
node scripts/project-env.mjs node .codex-work/build/creator2-build-native.mjs
```

## 验证证据

本轮自动化 **187/187** 通过，TypeScript 检查与扩展打包通过。两套原生测试成功调用 **134 个不同能力入口**；这是调用覆盖，不能代替每个入口的所有参数、错误分支与渲染结果验收。UI、资源 UUID、动画采样、材质恢复、物理命中等关键路径另有断言。

本地产物：

- `.codex-work/logs/creator2-expansion-tests.log`：自动化回归。
- `.codex-work/logs/creator2-native/report.json`：基础原生测试。
- `.codex-work/logs/creator2-native/extended-report.json`：扩展原生测试。
- `.codex-work/logs/creator2-native/preview.png`：真实预览截图。
- `.codex-work/logs/creator2-native/build-report.json`：实际 CLI 构建状态及详细日志路径。

实际 Web Desktop 构建在 Creator 自带 `editor/page/build/build-worker.ccc` 抛出 `Cannot read property 'exportSimpleProject' of undefined`，退出码 1。任务状态正确为 failed，即使目录里已有中间产物也不标记成功。当前安装还报告自带 FBX 转换器 `spawn Unknown system error -86`。未修改 Creator 安装包，未验证安装修复、FBX 导入、原生平台或平台 SDK 构建；这些仍是未完成项。

受控临时、缓存和输出路径统一设置在工程 `.codex-work`；Creator 自身的 library/local/temp 及引擎内部缓存属于第三方内部流程，不能据此声称其所有内部写入均已审计。

后续验收需先解决安装环境构建失败，然后覆盖尚未逐项调用的设置、视图、材质迁移/分配、订阅清理与跨平台入口。当前结果不能表述为全部能力或所有 P0–P5 验收完成。
