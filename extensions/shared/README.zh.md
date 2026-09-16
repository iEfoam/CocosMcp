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

## 开始使用

1. 将扩展安装到 Creator 工程，并在「扩展管理器」启用。
2. 打开 **CocosMCP → 打开控制中心**。控制中心支持简体中文和 English。
3. 准备 Node.js 24 或更高版本。源码安装时使用 CocosMCP 安装器记录 Node.js 可执行文件路径。
4. 启动桥接和 MCP 服务，再根据控制中心显示的连接配置接入 AI 客户端。
5. 操作前检查可用能力。更新安装后，重新加载扩展并重启 MCP 服务。

## 版本与平台说明

本包面向 **Creator {{major}}.x**，具体能力以当前编辑器版本及能力查询结果为准；声明支持的版本范围，不代表每个版本的全部功能都已完成验证。

本地开发和原生编辑器检查环境为 **macOS / Apple Silicon、Creator 3.8.8**。Windows、Intel Mac 和其他 Creator 版本需要分别验证。Linux CI 构建和自动化测试通过，不等于 Linux 原生编辑器验收。游戏导出平台与运行插件的编辑器宿主平台应分别判断。

Creator 3.8.8 的本地扩展扫描器会读取作者、版本、编辑器范围、`logo.png` 及当前语言的 README，但不会向管理器页头提供 **Release Date / Support Platforms**；本地安装时这两项可能仍显示「-」。上方时间表示打包时间，不冒充 Cocos Store 上架日期。

## 文档与反馈

- [开源仓库与完整安装说明](https://github.com/iEfoam/CocosMcp)
- [功能说明](https://github.com/iEfoam/CocosMcp/blob/main/docs/feature-reference.md)
- [提交问题](https://github.com/iEfoam/CocosMcp/issues)
- 联系邮箱：**iefoam@foxmail.com**

CocosMCP 使用 MIT 许可证，无需 CocosMCP 账号，也不设置工具调用配额；AI 客户端自身的使用条件和额度仍然适用。开发桥接的验证结果不能替代生产环境、真机或 GPU 验收。
