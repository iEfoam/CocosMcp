# 功能清单与验收状态

## 如何理解状态

- `implementation` 是单个入口是否有实现；planned 能力可被搜索、描述，但不会注册为独立可执行工具，通用执行入口也会拒绝。
- 模块 `status` 表示完整 scope 的完成情况。存在可用操作但没有完整范围验收时为 partial，不再因“已登记操作全部 implemented”自动标记完成。
- `registeredOperations` / `implementedOperations` 继续统计原能力目录，保持字段兼容。
- `registeredServiceTools` / `serviceTools` 单独列出独立服务入口。构建工具计入 F47，工作流计入 F52；资源整理别名和通用分发入口不重复计数。
- 能力搜索保留原有 `rows` 分页，并通过独立分页的 `serviceTools.rows` 返回匹配的服务入口，支持发现构建和工作流工具。
- MCP 返回的服务工具还有 `availableInThisServer`，用于区分实现存在与当前服务依赖已配置。它不表示编辑器、SDK 或设备已经就绪。

`module-acceptance.json` 默认没有完整模块的验收声明。未来条目必须给出 moduleId、与目录一致的 reviewedScope，以及 criteria（title、entryIds、evidenceIds）。覆盖程序要求每项关联当前源码的编辑器/运行时/设备证据。审查者仍须确认这些 criteria 真正覆盖完整 scope；程序不能从自然语言自动证明范围完整。

## 当前与历史证据

`verification` 仅反映匹配当前构建源码指纹的证据。`verificationEvidence` 保留证据级别、来源、报告 SHA-256、版本限制及 applicability：

- `current-source`：记录的源码指纹与该构建一致。
- `historical`：来源于旧报告，或源码已发生变化；不能证明当前修改已通过。

已回填 Creator 3.8.8 的 Shader 原生编译/恢复、运行时调参/截图及资源整理报告。旧报告没有源码指纹，因此诚实地保留为历史实测，不批量把当前能力涂成 editor-verified。

## 自动回填流程

1. 测试前计算 apps/packages/extensions/scripts/tests/examples、包配置与锁文件的源码指纹，并撤销旧的当前测试缓存。
2. Node 测试运行器写入 `.codex-work/logs/verification-tests.jsonl`；只收录最小测试事件，不收录任意输出对象。
3. 整套测试退出 0、测试前后指纹一致、映射文件中相应测试文件实际执行且无失败/跳过/todo，才生成 `.codex-work/cache/verification/source-tests.json`。
4. `verification-suites.json` 明确把测试文件映射到被断言覆盖的入口，不因“全套通过”标记全部能力通过。
5. 构建把当前指纹和可用证据注入 server、managed service 与扩展制品。未带证据的源码导入默认为 unverified，历史仍可查。源码发生任何变化后，旧证据自动成为 historical。
6. `pnpm check` 执行 typecheck → build → test → build；首轮构建供已有制品测试使用，末轮构建嵌入本次验收证据。CI 已使用该入口，无需另开一套发布流程。

contract-tested/adapter-tested 不代表真实 Creator、渲染后端或设备已验证。编辑器/GPU/真机验收必须另外记录精确版本、操作范围、源码指纹、报告指纹和限制；不能靠修改一个状态字段代替证据。

## 验证与回滚

检查 `cocos_coverage`、`cocos_capability_describe` 和实际 `tools/list`：planned 测试入口在默认及 all-tools 中均不应出现；已有实现的 cocos_ui_build 应正常注册，并限定 Creator 3.8.8 与 planHash；F47/F52 应为 partial 并列出独立工具；旧实测可见而不冒充当前验收。

这些修复不改变构建、工作流或场景操作的协议路径，没有数据库迁移。回滚时恢复先前源码和构建制品；验收缓存不匹配时保持历史状态，不恢复虚假的当前验证标记。安装后的运行中服务需重新加载才会使用新制品，文件更新不等于活动实例已更新。

完整新增功能设计见 [实施方案](capability-roadmap.md)。
