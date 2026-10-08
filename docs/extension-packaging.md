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
node scripts/project-env.mjs pnpm check
node scripts/project-env.mjs node scripts/release-bundle.mjs
```

本地安装器会复制整个构建目录，安装后即可获得全部资料。扩展代码修改仍应按项目检查流程完成类型检查及相关测试。

发布脚本从同一份已验证构建生成以下交付物：

- `cocos-mcp-creator{2,3}.zip`：分别用于 Creator 2 / 3 的安装 ZIP，包根目录直接包含 package.json。
- `release-manifest.json` 和 `SHA256SUMS`：记录源码指纹、两个版本的构建身份、文件大小及 SHA-256。

- `cocos-mcp-creator{2,3}.full.json`：完整运行文件、说明与图标，新更新器优先使用。
- `cocos-mcp-creator{2,3}.json`：仅运行文件的更新包。Creator 3 保持历史白名单兼容；Creator 2 新增必需 runtime，旧七文件更新器不兼容，首次升级需本地安装器或 ZIP 整包安装。

CI 同时上传 ZIP、两类 JSON 更新包及校验清单。打包前必须通过 `pnpm check` 并完成最后一次构建；缺少当前源码的测试记录、报告校验不一致或构建未嵌入当前报告时拒绝打包。ZIP 与 full.json 每个文件来自同一份字节，排除本机 service-config、凭据、缓存和 sourcemap。Creator 2/3 均包含 dist/runtime.js，并验证 package.json.fileHashes；同版本缺文件或摘要不一致时整包修复。Creator 2 七文件旧更新器不能接收新包，必须先整包安装；不为兼容而继续遗漏 runtime。Creator 3 旧更新器可先安装运行包，重载后再次更新补齐展示资料。完整包继续校验下载 SHA-256、扩展身份、必需文件、固定路径及重复路径。

## 发布通道

- `main` 推送或分支上的手动运行生成 `v<version>-dev.<run>.<sha>`，标记为 prerelease 且 `latest=false`。
- 稳定版仅由 `vMAJOR.MINOR.PATCH` 标签触发，必须与根 package.json 版本一致；完整检查通过后发布为 latest。
- 插件内更新继续读取 GitHub `releases/latest`，并拒绝响应中的 draft/prerelease。历史上已标记 latest 的构建不会由本地修改自动修正。

本地生成发布包不会推送代码、创建 GitHub Release、安装到 Creator 或提交 Cocos Store。商店上传仍按对应 Creator 主版本分别操作。

## 安装、重载和回滚检查

1. 从同一份通过检查的构建或 Release 取包，核对 Creator 主版本、buildId/sourceFingerprint、SHA256SUMS 与必需清单。两版完整包各 13 文件，必需运行包各 8 文件，均含 dist/runtime.js；不手动从其他版本补单个文件。
2. 停止目标工程的 MCP 服务和自有预览，保留本地 service-config 及账号目录。本地安装器返回 installedPath/backupPath；整包替换只作用于指定扩展，不能覆盖其他任务或游戏资产。
3. 通过原生扩展管理器重载，再启桥接/MCP 服务。editor.status.extension 中 integrity.health 应为 healthy，runningBuildId 与 installedBuildId 相同，reloadRequired=false；旧包缺摘要时 unknown 不是 healthy。
4. 打开专用预览，通过 preview.runtime.connect 核对 runtimeSourceFingerprint 与 runtimeSourceConsistency=matched，再验证场景、帧和目标能力。磁盘摘要、桥接连通和 runtime 握手分别检查。
5. 失败时停止该工程的自有服务/预览并停用扩展，完整恢复 backupPath 对应扩展目录后原生重载，重新核对身份。输入、AssetDB 导入及不属于扩展目录的用户变更不会因为扩展回滚自动撤销。

安装/重载不需要另建账号目录或重新登录；使用已有 Creator 实例，必要重启沿用 [本地登录入口](user-guide.md#creator-登录状态)。2026-10-08 的两版原生安装/重载及当前候选身份已验收；故障目录回滚由自动测试覆盖，不宣称此次额外执行过完整原生回滚激活。

安装后重新加载扩展，刷新扩展管理器。英文界面读取 `README.en.md`，中文界面读取 `README.zh.md`；`zh-CN` 文件用于显式使用该语言标识的读取方。不要只更新仓库首页 README，也不要把插件展示资源放进游戏工程的 `assets`。
