import { CocosError, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../../packages/runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../../packages/runtime3-bridge/src/scene.js';

/** 读取原生序列化结果，避免遍历业务 getter、引擎缓存及父子循环引用。 */
export class Creator2ReferenceAudit {
  inspect(serialized: unknown): JsonObject {
    const value = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
    if (!Array.isArray(value)) throw new CocosError('VERIFICATION_FAILED', 'Expected Creator 2 serialized object table');
    const table = value as JsonObject[], rows: JsonObject[] = [], issues: JsonObject[] = [], events: JsonObject[] = [];
    let visited = 0;
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
    return { rows, issues, events, complete: true, scope: 'current-scene-serialized-references', limitations: ['资源 UUID 仅提取，尚未验证 AssetDB 中是否存在', '不推断 null 曾经指向的对象，不分析字符串路径及脚本闭包引用'] };
  }
  scene(inspector: SceneInspector): JsonObject {
    if (!inspector.environment.serialize) throw new CocosError('CONTEXT_UNAVAILABLE', 'Native scene serializer unavailable');
    const audit = this.inspect(inspector.environment.serialize(inspector.current()));
    const rows = audit.rows as JsonObject[], issues = audit.issues as JsonObject[];
    for (const event of audit.events as JsonObject[]) {
      let target: RuntimeObject | undefined;
      try { if (event.targetNodeId) target = inspector.node(String(event.targetNodeId)); }
      catch (error) { if (CocosError.from(error).code !== 'NOT_FOUND') throw error; }
      const problem = (code: string): void => { event.valid = false; issues.push({ ...event, code }); };
      if (!target) { problem('EVENT_TARGET_MISSING'); continue; }
      const js = inspector.environment.cc.js;
      // 2.4.15 优先使用序列化 classId，旧工程才回退 component 名称；绝不调用 emit 来探测。
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
    return { ...audit, callbacksInvoked: false };

  }
}
