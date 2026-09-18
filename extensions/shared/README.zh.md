# CocosMCP · Creator {{major}}

免费开源的 Cocos Creator AI 工具。通过本地 MCP 桥接，让 AI 客户端连接编辑器、工程资源和开发运行时。

- **作者：** iefoam@foxmail.com
- **许可证：** MIT
- **插件版本：** {{version}}
- **构建标识：** {{buildId}}
- **打包时间（UTC）：** {{builtAt}}

## 核心能力

- 通过已支持的操作查询和编辑场景、节点、组件及预制体。
- 查询工程资源；资源整理先预览计划，再执行变更。
- 在可停靠控制中心查看桥接日志、连接状态和可用能力。
- 连接开发运行时，执行已支持的对象检查、调试和预览操作。
- 支持 stdio 及带认证的 Streamable HTTP，可接入兼容的 MCP 客户端。

## 按精确 Creator 版本划分的功能

文档基线：2026-09-18。本包属于 **Creator {{major}}**；对照表另一列不表示本包跨版本支持。

| 领域 | Creator 2.4.15 | Creator 3.8.8 |
| --- | --- | --- |
| 编辑器/资源 | 场景、节点、组件、Prefab、AssetDB、目录整理、依赖与 Undo | 同类基础编辑，另有原生控制台和版本匹配的编辑器消息 |
| UI/预览 | 声明式 UI、结构计划、引用守卫、五类控件真实输入、自有预览/日志 | 声明式 UI、布局/事件检查、自有预览/日志与鼠标键盘触摸 |
| 动画/物理 | curveData、Tween、Spine/DragonBones 缓存/事件/混合、Tilemap、碰撞/刚体/关节/Box 接触 | 原生轨道、Spine/Tilemap/物理工具，独立动画图/IK/CCT 适配 |
| 渲染/资源 | Camera 坐标、2D 像素与自有 GPU 清理、材质覆盖、资源快照趋势 | Effect 编译/变体、Shader 离屏预览、几何体/排序/探针及资源句柄 |
| 模板/构建 | 2.x 模板待交付；游戏构建有已记录环境失败 | 13 种可编辑模板，部分玩法验收；CLI 构建任务及产物检查 |

原生验收只覆盖指定夹具。2.4.15 最多 112 个编辑器与 99 个运行时入口，不等于全部原生通过数或默认工具列表长度。其他关节、Prefab 修复、字体图集质量、加载轨迹、单步等仍待完成；3.8.8 后处理和蒙皮也保留限制。两条版本线都未宣称全平台、全引擎完成。

## 开始使用

1. 将扩展安装到 Creator 工程，并在「扩展管理器」启用。
2. 打开 **CocosMCP → 打开控制中心**。菜单依次为 **关于 CocosMCP → 打开控制中心 → 检查更新**，有对应关于/更新页；桥接启停在控制中心内。支持简体中文和 English。
3. 准备 Node.js 24 或更高版本。源码安装时使用 CocosMCP 安装器记录 Node.js 可执行文件路径。
4. 启动桥接和 MCP 服务，再根据控制中心显示的连接配置接入 AI 客户端。
5. 操作前检查可用能力。更新安装后，重新加载扩展并重启 MCP 服务。

## 版本与平台说明

本包面向 **Creator {{major}}.x**，具体能力以当前编辑器版本及能力查询结果为准；声明支持的版本范围，不代表每个版本的全部功能都已完成验证。

本地原生记录覆盖 **macOS / Apple Silicon、Creator 2.4.15 和 3.8.8**，分别使用独立工程和不同功能范围。Windows、Intel Mac 和其他 Creator 版本需要分别验证。Linux CI 构建和自动化测试通过，不等于 Linux 原生编辑器验收。游戏导出平台与运行插件的编辑器宿主平台应分别判断。

Creator 3.8.8 的本地扩展扫描器会读取作者、版本、编辑器范围、`logo.png` 及当前语言的 README，但不会向管理器页头提供 **Release Date / Support Platforms**；本地安装时这两项可能仍显示「-」。上方时间表示打包时间，不冒充 Cocos Store 上架日期。

## 文档与反馈

- [开源仓库与完整安装说明](https://github.com/iEfoam/CocosMcp)
- [版本支持与验收边界](https://github.com/iEfoam/CocosMcp/blob/main/docs/version-support.md)
- [功能说明](https://github.com/iEfoam/CocosMcp/blob/main/docs/feature-reference.md)
- [提交问题](https://github.com/iEfoam/CocosMcp/issues)
- 联系邮箱：**iefoam@foxmail.com**

CocosMCP 使用 MIT 许可证，无需 CocosMCP 账号，也不设置工具调用配额；AI 客户端自身的使用条件和额度仍然适用。开发桥接的验证结果不能替代生产环境、真机或 GPU 验收。
