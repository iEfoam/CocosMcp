import type { Capability, JsonSchema } from '../../contracts/src/index.js';
import { UiDocumentModel } from '../../ui-core/src/index.js';
import { Schema as S } from './schema.js';

export class UiCapabilities {
  list(): Capability[] {
    const document = { ...UiDocumentModel.schema }; delete document.$defs;
    const creation: JsonSchema = { ...S.object({ parentId: S.string(), document }, ['parentId', 'document']), $defs: UiDocumentModel.schema.$defs! };
    const build = { ...creation, properties: { ...(creation.properties as Record<string, JsonSchema>), planHash: S.string() }, required: ['parentId', 'document', 'planHash'] };
    const update: JsonSchema = { ...S.object({ rootId: S.string(), document, mapping: { type: 'array', minItems: 1, maxItems: 200, items: S.object({ key: S.string(), nodeId: S.string() }, ['key', 'nodeId']) } }, ['rootId', 'document', 'mapping']), $defs: UiDocumentModel.schema.$defs! };
    const apply = { ...update, properties: { ...(update.properties as Record<string, JsonSchema>), planHash: S.string() }, required: ['rootId', 'document', 'mapping', 'planHash'] };
    return [
      ['ui.diff', '比较已有 UI 的声明属性；保持 UUID，报告需要单独处理的结构变更', 'read', update],
      ['ui.apply', '按 planHash 原位更新已有 UI 属性；冲突时保留现场，禁止删除重建', 'scene', apply],
      ['ui.plan', '规划声明式 UI；检查版本、引用和名称冲突，返回 planHash', 'read', creation],
      ['ui.build', '执行已规划 UI 树并返回 UUID 映射；部分失败使用局部补偿', 'scene', build],
      ['ui.inspect_layout', '读取实际 UI 四角与世界包围盒，诊断零尺寸和父边界溢出', 'read', S.object({ rootId: S.string() }, ['rootId'])],
      ['ui.validate_interaction', '静态检查按钮、Toggle、EditBox 事件与标签、PageView 页面及富文本回调；不触发回调', 'read', S.object({ rootId: S.string() }, ['rootId'])],
    ].map(([id, title, effect, inputSchema]) => ({ id, title, description: title, effect, inputSchema, module: 'F20', context: 'editor', outputSchema: {}, versions: [3], supportedMajors: [3], implementation: 'implemented', verification: 'unverified',
      prerequisites: ['Creator 3.8.8；ui.build 必须传 ui.plan 返回的 planHash'], rollback: '只删除与最后确认快照一致的本批子树；不确定结果保留并报告 pending',
    } as Capability));
  }
}
