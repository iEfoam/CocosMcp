# 资源移动前的引用审查

`asset.references.scan` 是 Creator 2/3 共用的只读文件审查能力。先获取 `asset.organize.plan`，再将其 `referenceReview.urls` 作为目标，选择覆盖相关业务代码的扫描范围。没有待移动资源时无需调用扫描。审查完毕仍需用原范围重新规划并传最新 `planHash`，扫描本身不执行移动或改写。

通过 `cocos_capability_execute` 调用示例：

```json
{
  "projectId": "已连接的工程 ID",
  "capabilityId": "asset.references.scan",
  "params": {
    "urls": ["db://assets/resources/ui/Card.prefab"],
    "scopeUrl": "db://assets/",
    "recursive": true
  }
}
```

结果分三类：

| kind | 定位与证据 | 处理方式 |
| --- | --- | --- |
| `uuid` | 已解析 JSON 中的 `__uuid__` 字段，提供源 URL、JSON 路径、原始 targetUuid 和 canonicalTargetUuid | 标准与 22 字符压缩 UUID 统一匹配；保留子资源后缀，不推断主/子资源映射。`requested-target-meta-match` 仅表示匹配目标 meta，不证明 AssetDB 注册、加载或渲染成功。其他值为 unresolved，不能冒充断引 |
| `literal-path` | 文本字面量与目标完整/后缀路径匹配，提供行、列和字符偏移 | 同名资源保留全部候选；核对 resources、Bundle 或业务解析上下文，不自动替换 |
| `dynamic-unknown` | 加载调用上下文或模板字符串未解析，提供行、列和字符偏移 | 人工检查拼接、插值、接收者、Bundle 名称与运行时路径；即使首参为字面量，也不把整个调用判为安全 |

默认递归读取范围内的 js/mjs/cjs/ts/tsx、json、scene/fire/prefab、mtl/anim/gltf/effect 文本；resources 和 Bundle 子目录照常读取。只按明确文本规则扫描，不执行脚本、组件 getter 或加载器。结果不是完整 JS/TS AST 分析；正则等语法可能产生额外候选，自定义加载封装、二进制、未知 UUID 格式、部分转义/大小写变体可能未解析。未命中不等于没有引用。

`scanComplete` 只表示所选范围内受支持文件的枚举和解析没有已报告的遗漏；跳过符号链接、非递归子目录和解析问题会使它为 false。`referenceCoverageComplete`、`automaticRewriteAllowed` 始终为 false，输出契约禁止把它们错误地返回为 true。`sources` 提供实际读到的 SHA-256 和字节数；这是逐文件快照，不是跨文件事务。目标 meta 在扫描后再次核对，变化时拒绝结果。

预算为最多 2000 个目标、2000 个文本源文件、50000 个目录条目；每个源文件最多 8 MiB，meta 最多 1 MiB，合计读取最多 64 MiB。匹配行、歧义候选总数和问题数量另有上限。超限拒绝返回成功结果，需要缩小扫描范围；不静默截断成“没有引用”。符号链接不跟随。

已有 `asset.references.audit` 保持原参数 `url` 和 Creator 2.4.15 的单文件 AssetDB UUID 核对行为，不被新扫描替换。新接口的两版适配路由与文件边界已有自动测试；尚未据此宣称两版 Creator 原生环境验收通过。Prefab 实例与源资源的完整差异树属于另一个待完成能力，不能由这份文本扫描替代。
