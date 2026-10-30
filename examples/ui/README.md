# Creator 3 UI 示例

正式静态界面优先使用 `menu.json`：先读取当前工程的 Canvas、相机及场景 revision，再调用 `ui.plan`，将相同文档、父节点及返回的 `planHash` 交给 `ui.build`。创建结果的 `rows` 是后续 `ui.diff/apply` 的 UUID 映射。通过 `scene.save` 保存，读回声明属性和场景 dirty 状态；可复用面板也可先查询 `asset.location`，再用 `prefab.create` 保存并核验资源。`needsSave: true` 不是保存成功。

脚本只负责交互、数据绑定和动态内容；动态列表可实例化已保存的 Prefab。颜色、布局和对齐字段见 [声明式 UI](../../docs/roadmap-implementation.md#声明式-ui)。遇到能力缺口先查组件属性接口或补充适配，不默认改成启动时生成整页 UI。

以下运行时面板仅用于独立交互测试，不是静态界面推荐模板。

`McpReactorUiTest.ts` 是 Creator 3.8.8 反应堆场景使用的独立运行时 UI 面板，提供按钮计数、文本输入回显和 12 行滚动列表。列表名称、ONLINE 和 OK 均为演示文案，不表示实际设备或项目诊断结果。

通过 `asset.location` 查找工程脚本目录，再通过 AssetDB 导入脚本。在目标场景的独立节点上添加 `McpReactorUiTest` 组件并保存。进入预览后生成 Canvas、相机和控件；禁用该节点或移除组件即可停用测试层。不要把脚本生成到 assets 根目录。

建议使用 1280 × 720 桌面预览。点击 RUN DIAGNOSTIC 检查计数变化；在输入框中键入文本并检查回显；滚动 ACTIVITY STREAM 到第 12 行。此示例已在 Creator 3.8.8 原生 Web 预览中完成上述交互与截图检查；未验证移动端、输入法或跨版本兼容性。

`menu.json` 演示声明式 UI 文档；运行时测试面板与 `ui.build` 的编辑器节点构建是不同路径，前者不构成后者的完整验收。

版本范围（2026-09-18）：本目录 TypeScript 运行时组件使用 Creator 3.8.8 API，不可直接作为 2.4.15 脚本导入。2.4.15 已有独立 UI 映射、结构计划和真实控件输入夹具，见 [版本矩阵](../../docs/version-support.md) 和 [验收台账](../../docs/creator2-expansion-tracker.md)。
