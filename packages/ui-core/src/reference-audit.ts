import { CocosError, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';

/** 读取原生序列化结果，避免遍历业务 getter、引擎缓存及父子循环引用。 */
export class SerializedReferenceAudit {
  inspect(serialized: unknown, expectedIds: readonly string[] = []): JsonObject {
    const value = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
    if (!Array.isArray(value)) throw new CocosError('VERIFICATION_FAILED', 'Expected native serialized object table');
    const table = value as JsonObject[], rows: JsonObject[] = [], issues: JsonObject[] = [], events: JsonObject[] = [];
    let visited = 0;
    if (table.length > 100000) throw new CocosError('RESOURCE_BUSY', 'Serialized reference table exceeds traversal limit');
    const identities = new Set<string>();
    for (let index = 0; index < table.length; index++) {
      const record = table[index];
      if (!record || typeof record !== 'object' || Array.isArray(record)) { issues.push({ code: 'INVALID_SERIALIZED_RECORD', index }); continue; }
      const id = record._id;
      if (typeof id === 'string' && id) {
        if (identities.has(id)) issues.push({ code: 'DUPLICATE_OBJECT_IDENTITY', index, targetId: id });
        identities.add(id);
      } else if (['cc.Node', 'cc.Scene'].includes(String(record.__type__)) || 'node' in record || '_node' in record) issues.push({ code: 'MISSING_OBJECT_IDENTITY', index });
    }
    for (const targetId of expectedIds) if (!targetId || !identities.has(targetId)) issues.push({ code: 'SERIALIZED_OBJECT_MISSING', targetId });
    const structural = new Set(['_parent', '_children', '_components', '_prefab', 'node', '_node']);
    const walk = (raw: JsonValue, path: string, owner: JsonObject, ancestors: Set<number>, depth: number): void => {
      // 超限必须阻止删除规划，不能把截断扫描当成没有引用。
      if (++visited > 100000 || depth > 64) throw new CocosError('RESOURCE_BUSY', 'Serialized reference audit exceeds traversal limit');
      if (!raw || typeof raw !== 'object') return;
      if (Array.isArray(raw)) { raw.forEach((entry, index) => walk(entry, `${path}[${index}]`, owner, ancestors, depth + 1)); return; }
      if ('__uuid__' in raw) { rows.push({ ...owner, path, kind: 'asset', targetId: String(raw.__uuid__), resolved: null }); return; }
      if ('__id__' in raw) {
        const index = raw.__id__;
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || !table[index]) { issues.push({ ...owner, path, code: 'INVALID_OBJECT_REFERENCE', reference: raw }); return; }
        const target = table[index]!;
        if (typeof target._id === 'string' && target._id) {
          rows.push({ ...owner, path, kind: target.__type__ === 'cc.Node' || target.__type__ === 'cc.Scene' ? 'node' : 'component', targetId: target._id, targetType: target.__type__ ?? null, resolved: true }); return;
        }
        if (ancestors.has(index)) return;
        const next = new Set(ancestors); next.add(index);
        walk(target, path, owner, next, depth + 1); return;
      }
      if (raw.__type__ === 'cc.ClickEvent') {
        const ref = raw.target && typeof raw.target === 'object' && !Array.isArray(raw.target) ? raw.target.__id__ : null;
        const target = typeof ref === 'number' ? table[ref] : null;
        events.push({ ...owner, path, targetNodeId: typeof target?._id === 'string' ? target._id : null,
          componentClassId: typeof raw._componentId === 'string' ? raw._componentId : '', componentName: typeof raw.component === 'string' ? raw.component : '', handler: typeof raw.handler === 'string' ? raw.handler : '' });
      }
      for (const [key, entry] of Object.entries(raw)) if (key !== '__type__') walk(entry, `${path}.${key}`, owner, ancestors, depth + 1);
    };
    table.forEach((record, index) => {
      if (typeof record?._id !== 'string' || !record._id) return;
      const owner: JsonObject = { sourceId: record._id, sourceType: record.__type__ ?? null };
      for (const [key, raw] of Object.entries(record)) if (!structural.has(key) && !['_id', '__type__'].includes(key)) walk(raw, key, owner, new Set([index]), 0);
    });
    return { rows, issues, events, complete: issues.length === 0, scope: 'current-scene-serialized-references', limitations: ['资源 UUID 仅提取，尚未验证 AssetDB 中是否存在', '不推断 null 曾经指向的对象，不分析字符串路径及脚本闭包引用'] };
  }
  scene(inspector: SceneInspector): JsonObject {
    const serialize = inspector.environment.serializeReferences ?? inspector.environment.serialize;
    if (!serialize) throw new CocosError('CONTEXT_UNAVAILABLE', 'Native scene serializer unavailable');
    const expectedIds: string[] = [];
    for (const node of inspector.all()) {
      const components = Array.isArray(node._components) ? node._components : inspector.components(node);
      if (expectedIds.length + 1 + components.length > 10000) throw new CocosError('RESOURCE_BUSY', 'Scene reference coverage exceeds object budget');
      expectedIds.push(A.uuid(node));
      for (const component of components) expectedIds.push(A.uuid(component));
    }
    const audit = this.inspect(serialize(inspector.current()), expectedIds);
    const rows = audit.rows as JsonObject[], issues = audit.issues as JsonObject[];
    for (const event of audit.events as JsonObject[]) {
      let target: RuntimeObject | undefined;
      try { if (event.targetNodeId) target = inspector.node(String(event.targetNodeId)); }
      catch (error) { if (CocosError.from(error).code !== 'NOT_FOUND') throw error; }
      const problem = (code: string): void => { event.valid = false; issues.push({ ...event, code }); };
      if (!target) { problem('EVENT_TARGET_MISSING'); continue; }
      const js = inspector.environment.cc.js;
      // 优先使用原生序列化 classId，旧资源才回退 component 名称；绝不调用 emit 来探测。
      const type = event.componentClassId ? A.call(js, '_getClassById', event.componentClassId) : A.call(js, 'getClassByName', event.componentName);
      if (!type) { problem('EVENT_COMPONENT_TYPE_MISSING'); continue; }
      const candidates = A.call(target, 'getComponents', type) as RuntimeObject[];
      for (const component of candidates) rows.push({ sourceId: event.sourceId!, sourceType: event.sourceType!, path: event.path!, kind: 'event-component', targetId: A.uuid(component), targetType: inspector.type(component), handler: event.handler!, resolved: true });
      if (!candidates.length) { problem('EVENT_COMPONENT_MISSING'); continue; }
      if (candidates.length > 1) { problem('EVENT_COMPONENT_AMBIGUOUS'); continue; }
      const descriptor = A.descriptor(candidates[0]!, String(event.handler));
      if (descriptor?.get) { problem('EVENT_HANDLER_ACCESSOR_UNVERIFIED'); continue; }
      if (typeof descriptor?.value !== 'function') { problem('EVENT_HANDLER_MISSING'); continue; }
      event.valid = true; event.targetComponentId = A.uuid(candidates[0]);
    }
    return { ...audit, complete: issues.length === 0, callbacksInvoked: false };

  }
}
