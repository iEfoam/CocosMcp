# Creator 3 UI 示例

`McpReactorUiTest.ts` 是 Creator 3.8.8 反应堆场景使用的独立运行时 UI 面板，提供按钮计数、文本输入回显和 12 行滚动列表。列表名称、ONLINE 和 OK 均为演示文案，不表示实际设备或项目诊断结果。

通过 `asset.location` 查找工程脚本目录，再通过 AssetDB 导入脚本。在目标场景的独立节点上添加 `McpReactorUiTest` 组件并保存。进入预览后生成 Canvas、相机和控件；禁用该节点或移除组件即可停用测试层。不要把脚本生成到 assets 根目录。

建议使用 1280 × 720 桌面预览。点击 RUN DIAGNOSTIC 检查计数变化；在输入框中键入文本并检查回显；滚动 ACTIVITY STREAM 到第 12 行。此示例已在 Creator 3.8.8 原生 Web 预览中完成上述交互与截图检查；未验证移动端、输入法或跨版本兼容性。

`menu.json`演示声明式 UI 文档；运行时测试面板与 `ui.build` 的编辑器节点构建是不同路径，前者不构成后者的完整验收。
