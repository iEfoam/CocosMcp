# 项目资源整理

Creator 2.4.15 / 3.8.8 已接入 `asset.location`、`asset.organize.plan`、`asset.organize.apply`，共享目录策略并分别使用对应版本 AssetDB。也提供直接 MCP 工具 `cocos_assets_organize_plan`（预览）和 `cocos_assets_organize_apply`（执行），供 agent 直接发现和调用。亦可通过 `cocos_capability_execute` 调用，也可用 CLI `call --capability ... --params ...`。版本与验收边界见 [支持矩阵](version-support.md)；2.4.15 已有 UUID 保留、目录复用和原生资源读回记录。

创建资源前调用 `asset.location`，例如 `{"url":"db://assets/Water.effect"}`。工具只规划，不创建目录。已有 Effects、Shaders 等对应目录优先复用（忽略大小写，浅目录优先，同深度按路径排序）；没有则建议 Shaders。创建时缺失目录通过 AssetDB 自动创建，返回 `assetLocation.url`，后续编译、引用必须使用实际路径。

覆盖 asset.create/import/copy、shader.create、material.create/clone、scene.create/save_copy、prefab.create ；geometry.create 的持久化几何体流程限 Creator 3.8.8，不计入 2.4.15。asset.import 按单文件归类，目录批量导入需由 agent 枚举后逐文件操作。明确业务子目录保持不变；更新和明确移动已有资源不自动重定向。

整理现有资源：

1. 调用 `asset.organize.plan`，参数 `{}` 默认检查根目录。可传 `scopeUrl`、`recursive:true`，或 `urls` 精确限定文件（最多 2000）。
2. Agent 查看 `rows` 的类型、源/目标和 UUID；查看 `skipped`，检查代码中的路径加载及相对引用。已归类的子目录不会被扁平化。
3. 调用 `asset.organize.apply`，保留预览的范围参数，加上返回的 `planHash`。内容、元数据或目标状态变更会使计划失效。
4. 读取 `status`、逐项 `verified` 和日志。`partial` 表示中断，不能当作成功。日志先记录待移动项，再通过 AssetDB 移动并验证 UUID、内容和旧路径消失；每项提供反向 `asset.move` 路径用于恢复。

根目录默认分类为 Shaders、Materials、Scenes、Prefabs、Textures、Models、Audio、Animations、Fonts、Scripts、Data、Other。资源已有合适目录时优先复用。新建支持上述类型；自动整理会跳过 scripts/data/chunk、OBJ/FBX/位图字体、带外部 URI 的 glTF、resources、Bundle 及插件/第三方目录，避免破坏导入与路径加载。未知类型列为人工审查。名称冲突不覆盖、不改名。

整理保证受控移动的 UUID 与内容验证，不保证项目内任意字符串路径自动更新。持久化日志在目标项目 `.codex-work/logs/asset-organization/`。规则见仓库 `AGENTS.md`；MCP 执行工具说明也要求 agent 先规划后执行。
