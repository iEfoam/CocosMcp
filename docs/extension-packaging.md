# 扩展管理器资料与打包

## 资料来源

- 作者、版本、简介和链接：`extensions/creator2/package.json`、`extensions/creator3/package.json`。
- 双语详情模板：`extensions/shared/README.en.md`、`extensions/shared/README.zh.md`。
- 图标：`extensions/shared/logo.png`（256 × 256 PNG）。
- 固定发布文件清单：`packages/native-adapters/src/extension-files.json`。

构建会把资料复制到 `.codex-work/build/extensions/creator2` 和 `creator3`，并生成 `README.md`、`README.en.md`、`README.zh.md`、`README.zh-CN.md`。说明中的版本和构建标识与本包一致；`buildTime` 使用 UTC ISO 8601，表示打包时间，不代表商店上架时间。修改模板、图标或包配置会改变本地构建身份。

已核对 Creator 3.8.8 自带 `@editor/extension-sdk` 的 `Scanner.queryLocalExtensionDetail`：README 按语言精确匹配，图标从包根目录的 `logo.png/jpg/jpeg` 读取。本地扫描器不输出 `publish_at` 和 `platform`，因此扩展管理器页头的发布日期与支持平台不能靠添加同名 package 字段补齐；详情正文提供环境和打包信息。Creator 2 的资料随包提供，但不宣称相同管理器展示行为已原生验证。

## 版本资料同步（2026-09-18）

中英文首页、[版本矩阵](version-support.md) 和 shared README 同步声明 2.4.15 / 3.8.8 的子集，避免 Creator 2 包只显示 3.8.8 验证环境。共享模板保留版本对照并标明本包 major。菜单为“关于 CocosMCP → 打开控制中心 → 检查更新”，桥接启停在控制中心。

更新模板后构建生成双语文件，检查占位符、链接与固定清单。模板变化影响构建身份，应更新自动测试证据；不把历史原生报告改为新指纹完整复验。构建、安装、重载和远程发布是独立步骤，更新本地文档不自动执行后三项。

## 构建与发布包

```sh
node scripts/project-env.mjs node scripts/build.mjs
node scripts/project-env.mjs node scripts/release-bundle.mjs
```

本地安装器会复制整个构建目录，安装后即可获得全部资料。扩展代码修改仍应按项目检查流程完成类型检查及相关测试。

发布脚本同时生成两类 **JSON 更新包**（不是 Creator 扩展管理器直接导入的 ZIP）：

- `cocos-mcp-creator{2,3}.full.json`：完整运行文件、说明与图标，新更新器优先使用。
- `cocos-mcp-creator{2,3}.json`：旧更新器兼容包，保留历史精确文件清单，防止旧客户端拒绝升级。

现有 CI 的 `*.json` 发布规则会同时上传两类文件。旧版插件第一次在线升级只能安装兼容包；新版代码生效后再次执行更新即可补齐同版本展示资料。使用新构建目录重新安装则一次完成。完整包仍执行 SHA-256、扩展身份、必需文件、固定路径和重复路径校验。

安装后重新加载扩展，刷新扩展管理器。英文界面读取 `README.en.md`，中文界面读取 `README.zh.md`；`zh-CN` 文件用于显式使用该语言标识的读取方。不要只更新仓库首页 README，也不要把插件展示资源放进游戏工程的 `assets`。
