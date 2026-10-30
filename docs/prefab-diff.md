# Prefab 差异检查

`prefab.diff` 接收 `nodeId`，当前实现限定 Creator 3.8.8 的已关联 Prefab 实例根节点。该能力为只读检查，不执行 apply、restore、保存或修改序列化资源。

## 身份与快照

源码通过 AssetDB UUID 定位，读取上限 16 MiB，并在实例快照后复核文件身份。实例通过原生编辑器序列化，同时独立统计实际节点和组件数量。返回 `sourceHash`、`instanceHash`、`assetUuid`、`url`，用于标识本次检查的证据。

根资源与 PrefabInfo 关联的子资源共同记录到 sourceDependencies，并生成 sourceGraphHash。每次检查重新采集，不复用旧捕获对象；快照后核对所有文件身份及 AssetDB UUID/路径。上限为 100 个资源、嵌套深度 16、单文件 16 MiB、总内容 64 MiB；循环依赖拒绝。此守卫证明读取期间源文件未被观察到变化，不能证明原生资产缓存已刷新，也不能代替压缩源展开。

比较子树中的序列化资源引用带上 side、对象 key 与属性 path，返回 `assetReferences`；不扫描原生快照附带的无关父级记录。适配器按规范化 UUID 去重查询 AssetDB，返回 `assetReferenceValidation`。未找到、无效/未导入/目录、身份不符和查询失败均产生 `ASSET_REFERENCE_UNVERIFIED`，使比较不完整并阻止变更计划。每侧最多 1,000 个引用位置、合计最多 500 个不同 UUID，同时最多 4 个查询。AssetDB 未找到也可能是特殊内置资源未登记，因此不会直接宣称引擎中一定不存在；resolved 仅证明本次查询身份匹配，不证明缓存新鲜或运行时可加载。

比较使用节点/组件的 Prefab fileId；嵌套实例叠加实例 fileId 路径。名称、表索引和运行时 UUID 不作为匹配身份。对象引用按对应身份归一化，层级父子关系和顺序单独比较。`tree` 为差异树，`rows` 为属性覆盖与增删记录。

保存重开可能重新分配 Prefab 实例的运行时 UUID。调用方应重新查询当前层级并核对 `assetUuid`，不能继续使用旧 `nodeId`；源资源关联及 fileId 才用于跨快照比较。2026-10-29 的 Creator 3.8.8 隔离工程验收已覆盖自定义数值属性差异，以及删除自有测试脚本、重开后实际 `cc.MissingScript` 导致比较不完整、apply/restore 计划均拒绝。可用 `scripts/prefab-component-native-acceptance.ts` 在指定隔离工程复验；该脚本保留自有场景和 Prefab 作为证据，并恢复原场景。

## 不完整结果

实例快照独立检查实际组件类型，返回 `componentIssues`。Creator 的 `cc.MissingScript` 会保留原始脚本序列化数据，因此即使源与实例 JSON 相同，也返回 `MISSING_COMPONENT_SCRIPT`；无法识别的实际类型返回 `COMPONENT_TYPE_UNVERIFIED`。旧插件没有此检查字段时返回 `COMPONENT_AVAILABILITY_UNVERIFIED`。这些问题均使比较不完整并阻止新的 apply/restore 计划，不推断缺失脚本的行为，不自动移除或替换组件。已识别的自定义组件仍只比较序列化字段，不能据此证明其运行逻辑正确。

缺失层级列表或反向父级/组件归属不一致，也会使比较不完整。原生计数必须是范围内的整数，节点数量至少为 1；计数类型错误、缺失序列化内容直接返回验证失败，避免隐式转换掩盖协议错误。

真实嵌套 Prefab 源文件会省略子实例默认属性与组件，保留覆盖账本。此类未展开源返回 NESTED_SNAPSHOT_NOT_EXPANDED；属性行标为 unverified-property-difference，树节点为 unverified-modified，不能将其当作已确认用户覆盖。完整展开源的嵌套 fileId 路径匹配已有合成测试；文件依赖新鲜度守卫已实现，压缩源原生展开及导入缓存新鲜度核验仍待完成。

## 有守卫的整实例变更

`prefab.change.plan` 接收 `nodeId` 与 `action`（`apply` 写回资源，`restore` 恢复实例）。仅完整差异可生成计划；应用方向另外检查源资源可编辑。计划返回差异 `rows`、源依赖 `sourceDependencies`、`expectedHash` 与 `planHash`。前者为源依赖图摘要，后者同时绑定工程、版本、节点、操作方向、资源与实例摘要。

两个入口的输出由共享契约校验，限定哈希格式、保留字段与操作方向的一致性，并要求 sceneSavedByTool=false；真实摘要是否匹配仍由执行前检查负责。可校验的参数/结果示例见 [contract-examples.md](./contract-examples.md)，其中身份和摘要均为占位值。

审查计划后，以相同 `nodeId`、`action` 和两个摘要调用 `prefab.change.apply`。执行前重新采集并匹配计划，过期返回 `STALE_REVISION` 且不调用写操作。原生写调用后重新比较，只有源实例一致、关联身份一致、子依赖未变才返回 `source-instance-converged`；恢复操作还要求根源摘要不变。原生报错、返回后未收敛或后置检查失败均为 `OUTCOME_UNKNOWN`，必须先检查现状再决定操作，不盲目重放。

这不是逐字段修复：原生操作作用于整个实例；不自动保存场景，不提供跨资源回滚，也不将原生布尔返回值当作保存或收敛证明。旧 `prefab.apply/revert` 保留兼容，新守卫不追溯改变旧入口语义。摘要检查是执行前后观察，并非与 Creator UI 或外部文件写入共享的原子锁。实例摘要包含序列化外部上下文，相关上下文变化也会令计划失效。

Creator 3.8.8 原生恢复会保留实例根名称。恢复计划以 `preservedRows` 明确列出这一差异并将其纳入 planHash；后置差异必须与该列表完全一致，才返回 `source-instance-converged-with-preserved-properties`。其他残留字段仍视为验收失败，不泛化豁免。

新入口已有源/实例过期、方向变更、不完整比较、只读资源、写后收敛、丢失回复与未收敛测试。Creator 3.8.8 单节点 UITransform 的公开差异、计划、组件覆盖恢复、写回、Undo 和保存后切换场景重载已验证：恢复宽度 133→100，Undo 回到 133；独立源写回宽度 145 并在重载后保持零差异。写回原生返回 false，独立源摘要和收敛证据仍证明写入完成。Undo 恢复了组件值但未恢复最初文件字节摘要，不能承诺字节级回滚。证据见 `.codex-work/artifacts/optimization-review-20261029/prefab-public-native-acceptance.json`。

关联缺失、fileId 重复、外部/损坏引用、序列化数量与原生观察不一致等情况写入 `issues`，并使 `comparisonComplete=false`。此时未匹配对象标为 `unverified-added` 或 `unverified-missing`，不得据此判定删除。`automaticRepairAllowed` 始终为 `false`。

私有覆盖账本、编辑器缓存和运行时 UUID 不做逐字段比较。资源引用的标准 UUID 与 Creator 3.8.8 的 22 字符压缩 UUID 已统一比较，`@` 子资源后缀保持大小写和完整内容；只转换资源引用，不将普通文本或 fileId 当作 UUID。未知格式保留原样，不猜测转换。嵌套 Prefab 依赖也按归一化身份查询和去重；一般资源引用按上述 AssetDB 查询边界核验。自定义属性仅使用原生序列化值，不另外调用 getter。比较限制每侧 10,000 个对象、层级深度 128、属性深度 64 和 200,000 次属性访问，结果最多 10,000 行。

## 验证状态

UUID 归一化已与本机 Creator 3.8.8 的 `cocos/core/utils/decode-uuid.ts` 算法核对 10,000 组输入（包括子资源后缀），全部一致。证据为 `.codex-work/logs/optimization-native-uuid-parity.json`，包含源文件 SHA-256；这是引擎算法交叉验证，不是 Editor 集成或跨版本验收。

Creator 3.8.8 的单节点 UITransform 实例已取得真实快照：默认序列化会压缩组件，启用 reserveContentsForSyncablePrefab 后 1 节点/1 组件完整，比较只报告预期的名称覆盖。保存重开后实例 UUID 变化，需重新定位实例。最初通过第一方场景脚本采集，随后公开 prefab.diff 已验证同一范围；嵌套 Prefab 仍未完整验收。

原生序列化会跟随父级与外部引用；比较范围仍是选中根的子树，快照明确标记 native-context-with-external-references。返回快照预算为 16 MiB，不能限制原生序列化内部瞬时分配；资源过大时拒绝，不临时断开节点父级。实例摘要当前覆盖完整原生快照，外部上下文变化可能使摘要变化。

已有合成测试验证表索引/运行时 UUID 变化、嵌套实例重复 fileId、属性覆盖、增删、损坏引用、快照缺失、源文件变化以及只读调用边界。Creator 3.8.8 的实际序列化展开形态仍待原生验收；不能将合成测试视为完整 Prefab 原生支持证明。Creator 2 未开放此能力。
