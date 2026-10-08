import { Schema as S } from './schema.js';
import type { Capability, JsonSchema } from '../../contracts/src/index.js';
import { UiDocumentModel } from '../../ui-core/src/index.js';

/** 验收配方只组合已有受控能力，业务输入必须在配方中显式声明。 */
export class RoadmapCapabilities {
  static readonly presets = [
    { id: 'landscape-568', width: 568, height: 320, orientation: 'landscape' },
    { id: 'landscape-844', width: 844, height: 390, orientation: 'landscape' },
    { id: 'landscape-1280', width: 1280, height: 720, orientation: 'landscape' },
    { id: 'landscape-1920', width: 1920, height: 1080, orientation: 'landscape' },
  ];
  static readonly selector = { ...S.object({ nodeId: S.string(), name: S.string(), path: S.string() }), minProperties: 1 };
  static readonly checks = { type: 'array', minItems: 1, maxItems: 100, items: { ...S.object({ selector: RoadmapCapabilities.selector,
    exists: S.boolean(), count: { type: 'integer', minimum: 0, maximum: 1000 }, active: S.boolean(), text: { type: 'string', maxLength: 10000 },
    interactable: S.boolean(), visible: S.boolean(), clipped: S.boolean(), optional: S.boolean() }, ['selector']), minProperties: 2 } };
  list(): Capability[] {
    const rows: Capability[] = [], str = S.string(), hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
    const add = (id: string, title: string, effect: Capability['effect'], properties: Record<string, JsonSchema>, required: string[] = [], module = 'F52'): void => {
      rows.push({ id, title, description: title, module, context: id.startsWith('runtime.') ? 'runtime' : /^(acceptance|fixture)\./.test(id) || ['preview.regression', 'operation.audit.query'].includes(id) ? 'service' : 'editor', effect,
        inputSchema: S.object(properties, required), outputSchema: {}, versions: [2, 3], supportedMajors: [2, 3], implementation: 'implemented', verification: 'unverified',
        prerequisites: ['Creator 2.4.15 或 3.8.8；真实业务和设备另行验收'], rollback: '只恢复身份与指纹仍匹配的工具自有设置和资源；输入不自动重放' });
    };
    add('preview.presets', '列出横屏窗口参考预设，不模拟真机', 'read', {}, [], 'F43');
    add('runtime.view.inspect', '读取公开引擎视图及几何指纹', 'read', {}, [], 'F43');
    add('runtime.view.configure', '按指纹有限修改设计尺寸与适配策略，返回恢复句柄', 'runtime', {
      width: { type: 'integer', minimum: 256, maximum: 4096 }, height: { type: 'integer', minimum: 256, maximum: 4096 },
      policy: S.enum('EXACT_FIT', 'NO_BORDER', 'SHOW_ALL', 'FIXED_HEIGHT', 'FIXED_WIDTH'), expectedHash: hash,
    }, ['width', 'height', 'expectedHash'], 'F43');
    add('runtime.view.restore', '冲突检测后恢复本会话视图设置', 'runtime', { restoreId: str }, ['restoreId'], 'F43');
    add('runtime.ui.select', '解析唯一节点、相机投影与原生命中候选，不触发回调', 'read', { rootId: str, selector: RoadmapCapabilities.selector }, ['selector'], 'F20');
    add('runtime.ui.check', '声明式检查存在、唯一性、可选节点、文本及相机裁切', 'read', { rootId: str, rows: RoadmapCapabilities.checks }, ['rows'], 'F20');
    add('runtime.ui.click', '向绑定的自有预览发送真实输入并独立检查后态', 'runtime', {
      rootId: str, selector: RoadmapCapabilities.selector, after: RoadmapCapabilities.checks,
      allowResume: S.boolean(), timeoutMs: { type: 'integer', minimum: 100, maximum: 30000 },
    }, ['selector'], 'F20');
    add('runtime.scene.load', '通过公开 AssetManager 和 Director 加载场景 UUID，不修改启动配置', 'runtime', { sceneUuid: str }, ['sceneUuid'], 'F03');
    add('runtime.lifecycle.snapshot', '读取本会话句柄、任务、订阅、资产和帧统计', 'read', {}, [], 'F46');
    const operation = S.object({ capabilityId: str, params: S.record() }, ['capabilityId', 'params']);
    add('preview.regression', '重复有限场景/刷新/窗口操作并记录生命周期和延迟证据', 'runtime', {
      cycles: { type: 'integer', minimum: 1, maximum: 10 }, rows: { type: 'array', minItems: 1, maxItems: 8, items: operation },
      maxResourceGrowth: { type: 'integer', minimum: 0, maximum: 10000 },
    }, ['cycles', 'rows'], 'F46');
    const step = S.object({ capabilityId: str, params: S.record(),
      paramRefs: { type: 'object', additionalProperties: S.object({ step: { type: 'integer', minimum: 0 }, path: str }, ['step', 'path']) },
      runtimeRef: S.object({ step: { type: 'integer', minimum: 0 }, path: str }, ['step', 'path']),
      waitFor: S.object({ path: str, equals: {}, timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 }, intervalMs: { type: 'integer', minimum: 10, maximum: 5000 } }, ['path', 'equals']),
    }, ['capabilityId', 'params']);
    const recipe = { mode: S.enum('fixture', 'live'), fixtureId: str, allowInputs: S.boolean(), steps: { type: 'array', minItems: 1, maxItems: 50, items: step },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 } };
    add('acceptance.plan', '校验验收配方的副作用、选择器和夹具约束', 'read', recipe, ['mode', 'steps']);
    add('acceptance.run', '执行已审查配方，保存原图、摘要、版本与清理结果', 'runtime', { ...recipe, planHash: hash }, ['mode', 'steps', 'planHash']);
    add('acceptance.status', '查询持久化验收证据包与未完成步骤', 'read', { runId: str }, ['runId']);
    add('acceptance.cancel', '取消配方后续步骤，保留未知原生结果和证据', 'runtime', { runId: str }, ['runId']);
    const fixture = { parentId: str, document: UiDocumentModel.schema, label: { type: 'string', minLength: 1, maxLength: 128 },
      ttlMs: { type: 'integer', minimum: 1000, maximum: 86400000 }, allowedOrigins: { type: 'array', maxItems: 8, uniqueItems: true, items: str } };
    add('fixture.plan', '规划隔离 UI 夹具，默认阻止业务网络', 'read', fixture, ['parentId', 'document', 'label']);
    add('fixture.create', '按 UI 计划创建夹具并保存所有权和清理指纹', 'scene', { ...fixture, planHash: hash }, ['parentId', 'document', 'label', 'planHash']);
    add('fixture.status', '查询夹具范围、期限、网络策略和清理状态', 'read', { fixtureId: str }, ['fixtureId']);
    add('ui.owned_snapshot', '读取原生子树快照和父节点位置，用于自有资源清理守卫', 'read', { rootId: str }, ['rootId'], 'F20');
    add('ui.owned_remove', '仅当原生子树、父节点和引用均匹配时移除指定树', 'scene', { rootId: str, expectedSnapshot: {} }, ['rootId', 'expectedSnapshot'], 'F20');
    add('fixture.cleanup', '按原生快照指纹清理自有夹具，冲突时保留现场', 'scene', { fixtureId: str }, ['fixtureId']);
    for (const row of rows.filter(row => ['fixture.plan', 'fixture.create'].includes(row.id))) {
      const schema = row.inputSchema as JsonSchema & { properties: Record<string, JsonSchema> };
      const document = { ...UiDocumentModel.schema }; delete document.$defs;
      schema.properties.document = document; schema.$defs = UiDocumentModel.schema.$defs;
    }
    add('operation.audit.query', '按 UTC 半开时间范围分页读取脱敏操作审计', 'read', {
      from: str, to: str, cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 }, operationId: str,
    }, [], 'F10');
    return rows;
  }
}
