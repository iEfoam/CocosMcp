import { Creator2ReferenceAudit } from './reference-audit.js';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../../packages/runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../../packages/runtime3-bridge/src/scene.js';

interface Entry { id: string; parent: string | null; name: string; object?: RuntimeObject; removed: boolean; types: Set<string> }

export class Creator2UiStructure {
  constructor(private readonly inspector: SceneInspector, private readonly undo: RuntimeObject) {}
  private type(name: string): unknown { return A.call(this.inspector.environment.cc.js, 'getClassByName', name); }
  private plan(p: JsonObject): { entries: Map<string, Entry>; rows: JsonObject[]; rootId: string; references: JsonObject } {
    const root = this.inspector.node(Json.string(p.rootId, 'rootId')), rootId = A.uuid(root);
    const entries = new Map<string, Entry>(this.inspector.all(root).map(node => [A.uuid(node), { id: A.uuid(node), parent: node === root ? null : A.uuid(node.parent), name: String(node.name), object: node, removed: false, types: new Set(this.inspector.components(node).map(c => this.inspector.type(c))) }]));
    const rows = p.rows as JsonObject[], removedComponents = new Set<string>();
    if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new CocosError('INVALID_ARGUMENT', 'Expected 1–100 structure operations');
    const get = (id: JsonValue | undefined): Entry => { const entry = entries.get(Json.string(id, 'node reference')); if (!entry || entry.removed) throw new CocosError('INVALID_ARGUMENT', 'Node is outside the root, removed, or not created yet'); return entry; };
    for (const row of rows) {
      if (row.action === 'create') {
        const parent = get(row.parent), key = Json.string(row.key, 'key');
        if (entries.has(key)) throw new CocosError('INVALID_ARGUMENT', 'Create key conflicts with another node');
        entries.set(key, { id: key, name: Json.string(row.name, 'name'), parent: parent.id, removed: false, types: new Set() });
      } else if (row.action === 'move') {
        const node = get(row.node), parent = get(row.parent);
        if (node.id === rootId) throw new CocosError('INVALID_ARGUMENT', 'Cannot move the scoped root');
        for (let ancestor: Entry | undefined = parent; ancestor; ancestor = ancestor.parent ? entries.get(ancestor.parent) : undefined) if (ancestor === node) throw new CocosError('INVALID_ARGUMENT', 'Move creates a cycle');
        node.parent = parent.id;
      } else if (row.action === 'remove') {
        const node = get(row.node);
        if (node.id === rootId) throw new CocosError('INVALID_ARGUMENT', 'Cannot remove the scoped root');
        for (const candidate of entries.values()) for (let ancestor: Entry | undefined = candidate; ancestor; ancestor = ancestor.parent ? entries.get(ancestor.parent) : undefined) if (ancestor === node) { candidate.removed = true; break; }
      } else if (row.action === 'add_component') {
        const node = get(row.node), type = Json.string(row.type, 'type');
        if (!this.type(type) || node.types.has(type)) throw new CocosError('INVALID_ARGUMENT', 'Unavailable or duplicate component type');
        node.types.add(type);
      } else if (row.action === 'remove_component') {
        const id = Json.string(row.componentId, 'componentId'), component = this.inspector.component(id), node = get(A.uuid(component.node));
        if (removedComponents.has(id)) throw new CocosError('INVALID_ARGUMENT', 'Component already removed');
        removedComponents.add(id); node.types.delete(this.inspector.type(component));
      } else throw new CocosError('INVALID_ARGUMENT', 'Unknown structure operation');
      if (row.index !== undefined && (!Number.isInteger(row.index) || Number(row.index) < 0)) throw new CocosError('INVALID_ARGUMENT', 'Invalid sibling index');
      if (row.index !== undefined && ['create', 'move'].includes(String(row.action))) {
        const siblings = [...entries.values()].filter(entry => !entry.removed && entry.parent === row.parent);
        // 原生 setSiblingIndex 会静默裁剪过大索引，计划阶段明确拒绝以免实际顺序偏离请求。
        if (Number(row.index) >= siblings.length) throw new CocosError('INVALID_ARGUMENT', 'Sibling index exceeds the resulting parent child count');
      }
    }
    const names = new Set<string>();
    for (const entry of entries.values()) if (!entry.removed) {
      const key = `${entry.parent}\0${entry.name}`;
      if (names.has(key)) throw new CocosError('OPERATION_CONFLICT', 'Result contains ambiguous sibling names');
      names.add(key);
    }
    const deleted = new Set(removedComponents);
    for (const entry of entries.values()) if (entry.removed && entry.object) {
      deleted.add(entry.id);
      for (const component of this.inspector.components(entry.object)) deleted.add(A.uuid(component));
    }
    const references = new Creator2ReferenceAudit().scene(this.inspector);
    const blockers = (references.rows as JsonObject[]).filter(row => deleted.has(String(row.targetId)) && !deleted.has(String(row.sourceId)));
    return { entries, rows, rootId, references: { blockers, issues: references.issues!, deletionAllowed: deleted.size === 0 || (blockers.length === 0 && (references.issues as JsonObject[]).length === 0) } };
  }
  execute(method: string, p: JsonObject): JsonValue {
    const plan = this.plan(p);
    if (method.endsWith('.plan')) return { rows: plan.rows, rootId: plan.rootId, transformPolicy: 'preserve-local', resultingNodes: [...plan.entries.values()].filter(row => !row.removed).length, references: plan.references };
    if (!plan.references.deletionAllowed) throw new CocosError('OPERATION_CONFLICT', 'Resolve surviving serialized references before structural deletion', plan.references);
    const objects = new Map([...plan.entries.values()].filter(row => row.object).map(row => [row.id, row.object!]));
    const completed: JsonObject[] = [];
    const node = (ref: JsonValue | undefined): RuntimeObject => { const value = objects.get(String(ref)); if (!value) throw new CocosError('NOT_FOUND', 'Node reference disappeared'); return value; };
    try {
      for (const row of plan.rows) {
        if (row.action === 'create') {
          const value = A.construct(this.inspector.environment.cc.Node, [row.name]); objects.set(String(row.key), value);
          A.call(node(row.parent), 'addChild', value);
          if (row.index !== undefined) A.call(value, 'setSiblingIndex', Number(row.index));
          A.call(this.undo, 'recordCreateNode', A.uuid(value));
          completed.push({ ...row, nodeId: A.uuid(value) });
        } else if (row.action === 'move') {
          const value = node(row.node); A.call(this.undo, 'recordMoveNode', A.uuid(value)); A.call(this.undo, 'recordNode', A.uuid(value));
          A.call(value, 'setParent', node(row.parent)); if (row.index !== undefined) A.call(value, 'setSiblingIndex', Number(row.index));
          if (value.parent !== node(row.parent)) throw new CocosError('VERIFICATION_FAILED', 'Parent readback differs');
          completed.push(row);
        } else if (row.action === 'remove') {
          const value = node(row.node); A.call(this.undo, 'recordDeleteNode', A.uuid(value)); A.call(value, 'removeFromParent'); A.call(value, 'destroy'); completed.push(row);
        } else if (row.action === 'add_component') {
          const owner = node(row.node), value = A.object(A.call(owner, 'addComponent', this.type(String(row.type))));
          A.call(this.undo, 'recordAddComponent', A.uuid(owner), value, (owner._components as unknown[]).indexOf(value)); completed.push({ ...row, componentId: A.uuid(value) });
        } else {
          const value = this.inspector.component(String(row.componentId)), owner = A.object(value.node);
          A.call(this.undo, 'recordRemoveComponent', A.uuid(owner), value, (owner._components as unknown[]).indexOf(value)); A.call(value, 'destroy'); completed.push(row);
        }
      }
      A.call(this.undo, 'commit');
      return { completed, pending: [], rows: [...objects].filter(([key]) => !plan.entries.get(key)!.removed).map(([key, value]) => ({ key, nodeId: A.uuid(value) })), needsSave: true, undoScope: 'editor-native-history' };
    } catch (error) {
      // 自定义组件生命周期可能产生外部副作用；保留可撤销的原生记录，不能伪称完整自动回滚。
      A.call(this.undo, 'commit');
      throw new CocosError('OUTCOME_UNKNOWN', 'Structure operation interrupted; inspect before undo or retry', { completed, pending: plan.rows.slice(completed.length), objects: [...objects].map(([key, value]) => ({ key, nodeId: A.uuid(value) })), cause: CocosError.from(error).message });
    }
  }
}
