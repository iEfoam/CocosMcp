import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../../packages/runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../../packages/runtime3-bridge/src/scene.js';
import { Creator3UiStructure } from './ui-structure.js';
import { Creator3StructureUndo } from './structure-undo.js';

/** 3.8.8 原生管理器批处理端口；用原生手动记录保持整组 Undo/Redo。 */
export class Creator3UiStructureExecution {
  constructor(private readonly inspector: SceneInspector, private readonly facade: RuntimeObject, private readonly nodes: RuntimeObject) {}

  async apply(p: JsonObject): Promise<JsonObject> {
    const plan = new Creator3UiStructure(this.inspector, this.facade).plan(p);
    if (Json.string(p.planHash, 'planHash') !== plan.planHash) throw new CocosError('OPERATION_CONFLICT', 'Structure plan is stale; query a new plan before applying');
    if (!plan.applicable) throw new CocosError('OPERATION_CONFLICT', 'Structure deletion is blocked by scene references', { references: plan.references! });
    const rows = plan.rows as JsonObject[], expected = plan.resultingNodes as JsonObject[];
    const componentClassIds = new Map<string, string>();
    for (const row of rows) if (row.action === 'add_component') {
      const type = Json.string(row.type, 'type'), js = this.inspector.environment.cc.js;
      const classId = A.call(js, '_getClassId', A.call(js, 'getClassByName', type));
      if (typeof classId !== 'string' || !classId) throw new CocosError('VERIFICATION_FAILED', 'Native component class ID is unavailable', { type });
      componentClassIds.set(type, classId);
    }
    const mapping = new Map<string, string>(), completed: JsonObject[] = [];
    const componentOwners = new Map<string, string>();
    for (const node of this.inspector.all(this.inspector.node(String(p.rootId)))) {
      mapping.set(A.uuid(node), A.uuid(node));
      for (const component of node._components as RuntimeObject[]) componentOwners.set(A.uuid(component), A.uuid(node));
    }
    const id = (value: JsonValue | undefined): string => {
      const key = Json.string(value, 'node reference'), uuid = mapping.get(key);
      if (!uuid) throw new CocosError('VERIFICATION_FAILED', 'Native operation cannot resolve a planned node', { key });
      return uuid;
    };
    const query = (uuid: string): RuntimeObject => A.object(A.call(this.nodes, 'query', uuid), 'native node');
    const undo = new Creator3StructureUndo(this.inspector, this.facade, String(p.rootId));
    let started = false, checkpointAttempted = false;
    const checkpoint = (): void => { checkpointAttempted = true; undo.finish(); };
    try {
      // 同步执行结构步骤，不在步骤间让出事件循环；手动记录独立保留批次开始时的完整状态。
      // 不能调用 facade 的逐项包装方法，它们可能各自提交快照，破坏整组撤销。
      for (const row of rows) {
        started = true;
        let componentId: string | undefined;
        if (row.action === 'create') {
          const uuid = A.call(this.nodes, 'createNode', id(row.parent), Json.string(row.name, 'name'), null, false);
          if (typeof uuid !== 'string' || !uuid || [...mapping.values()].includes(uuid)) throw new CocosError('VERIFICATION_FAILED', 'Native create did not return a new node UUID');
          mapping.set(String(row.key), uuid);
          if (row.index !== undefined) this.order(query(uuid), Number(row.index));
        } else if (row.action === 'move') {
          const uuid = id(row.node);
          A.call(this.nodes, 'setParent', id(row.parent), uuid, false);
          const parent = query(id(row.parent));
          this.order(query(uuid), row.index === undefined ? (parent.children as RuntimeObject[]).filter(node => !(Number(node._objFlags ?? 0) & 8)).length - 1 : Number(row.index));
        } else if (row.action === 'remove') {
          A.call(this.nodes, 'removeNode', id(row.node), false);
        } else if (row.action === 'add_component') {
          const owner = query(id(row.node)), previousIds = new Set((owner._components as RuntimeObject[]).map(A.uuid));
          if (A.call(this.nodes, 'createComponent', id(row.node), componentClassIds.get(String(row.type))) !== true) throw new CocosError('VERIFICATION_FAILED', 'Native component creation was rejected');
          // 原生 createComponent 会捕获构造失败后仍返回 true；必须读回新增实例，才能把此步骤计入 completed。
          const added = (owner._components as RuntimeObject[]).filter(component => !previousIds.has(A.uuid(component)) && A.call(this.inspector.environment.cc.js, 'getClassName', component) === row.type);
          if (added.length !== 1) throw new CocosError('VERIFICATION_FAILED', 'Native component creation did not produce the requested instance');
          componentId = A.uuid(added[0]);
        } else if (row.action === 'remove_component') {
          if (A.call(this.nodes, 'removeComponent', Json.string(row.componentId, 'componentId')) !== true) throw new CocosError('VERIFICATION_FAILED', 'Native component removal was rejected');
          if (this.inspector.all(this.inspector.node(String(p.rootId))).some(node => (node._components as RuntimeObject[]).some(component => A.uuid(component) === row.componentId))) throw new CocosError('VERIFICATION_FAILED', 'Native component remains after removal');
        } else throw new CocosError('INVALID_ARGUMENT', 'Unknown structure action');
        completed.push({ ...row, ...(row.action === 'create' ? { nodeId: mapping.get(String(row.key))! } : {}), ...(componentId ? { componentId } : {}) });
      }
      checkpoint();
      this.verify(String(p.rootId), expected, mapping, plan.deletedIds as string[], componentOwners);
      return { rootId: p.rootId!, completed, pending: [], mapping: [...mapping].map(([key, nodeId]) => ({ key, nodeId })),
        needsSave: true, verifiedStructure: true, undoScope: 'native-manual-recording' };
    } catch (error) {
      if (!started) throw error;
      let checkpointError: string | null = null;
      // 保留已完成结果；失败不等于未执行。只能提交已有撤销记录，不自动逆向重放或重试业务构造器。
      if (!checkpointAttempted) try { checkpoint(); } catch (failure) { checkpointError = CocosError.from(failure).message; }
      const failure = CocosError.from(error);
      throw new CocosError('OUTCOME_UNKNOWN', 'Native structure batch requires readback before continuing', {
        completed, pending: rows.slice(completed.length), mapping: [...mapping].map(([key, nodeId]) => ({ key, nodeId })),
        needsSave: true, cause: { code: failure.code, message: failure.message }, checkpointError,
      });
    }
  }

  private order(node: RuntimeObject, index: number): void {
    const parent = A.object(node.parent);
    const siblings = parent.children as RuntimeObject[], visible = siblings.filter(sibling => sibling !== node && !(Number(sibling._objFlags ?? 0) & 8));
    // 计划的顺序是业务兄弟节点序号；将它映射为原生数组位置，不让 Gizmo 数量影响结果。
    const anchor = visible[index], withoutNode = siblings.filter(sibling => sibling !== node);
    const nativeIndex = anchor ? withoutNode.indexOf(anchor) : withoutNode.length;
    A.call(this.facade, 'onNodeBeforeChanged', parent);
    A.call(node, 'setSiblingIndex', nativeIndex);
    A.call(this.facade, 'onNodeChanged', parent, {});
  }

  private verify(rootId: string, expected: JsonObject[], mapping: Map<string, string>, deleted: string[], componentOwners: Map<string, string>): void {
    const actual = this.inspector.all(this.inspector.node(rootId)), byId = new Map(actual.map(node => [A.uuid(node), node]));
    if (actual.length !== expected.length) throw new CocosError('VERIFICATION_FAILED', 'Native batch created or removed unplanned nodes');
    for (const row of expected) {
      const uuid = mapping.get(String(row.key))!, node = byId.get(uuid);
      if (!node || String(node.name) !== row.name || A.uuid(node.parent) !== (mapping.get(String(row.parent)) ?? row.parent ?? '')) throw new CocosError('VERIFICATION_FAILED', 'Native node identity, name or parent differs from the plan', { uuid });
      const children = (node.children as RuntimeObject[]).map(A.uuid).filter(id => byId.has(id)), expectedChildren = (row.children as string[]).map(key => mapping.get(key));
      const types = (node._components as RuntimeObject[]).map(component => String(A.call(this.inspector.environment.cc.js, 'getClassName', component))).sort();
      if (JSON.stringify(children) !== JSON.stringify(expectedChildren) || JSON.stringify(types) !== JSON.stringify([...(row.componentTypes as string[])].sort())) throw new CocosError('VERIFICATION_FAILED', 'Native child order or component set differs from the plan', { uuid });
    }
    const identities = new Set(actual.flatMap(node => [A.uuid(node), ...(node._components as RuntimeObject[]).map(A.uuid)]));
    if (deleted.some(uuid => identities.has(uuid))) throw new CocosError('VERIFICATION_FAILED', 'Removed native objects are still present');
    for (const [componentId, nodeId] of componentOwners) if (!deleted.includes(componentId) && !(byId.get(nodeId)?._components as RuntimeObject[] | undefined)?.some(component => A.uuid(component) === componentId)) {
      throw new CocosError('VERIFICATION_FAILED', 'Native batch changed an undeleted component UUID or owner', { componentId, nodeId });
    }
  }
}
