import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';

export interface StructureComponentType { requires?: string[]; satisfies?: string[] }
export interface StructureComponent extends StructureComponentType { componentId: string; type: string }
export interface StructureNode { nodeId: string; parentId: string | null; name: string; children: string[]; components: StructureComponent[]; protectedReason?: string }
export interface StructureReferences { complete: boolean; rows: Array<{ sourceId: string; targetId: string; path: string }>; issues: JsonObject[] }
export interface StructureCreationRule { ancestorType: string; componentType: string; inheritedOutsideRoot: boolean }
interface PlannedNode extends StructureNode { removed: boolean; created: boolean; components: Array<StructureComponent & { created: boolean }> }

/** 只模拟声明的结构变化，不运行组件构造器，不改写场景序列化数据。 */
export class UiStructurePlan {
  create(rootId: string, source: StructureNode[], operations: JsonObject[], componentTypes: string[], references: StructureReferences, definitions: ReadonlyMap<string, StructureComponentType> = new Map(), creationRules: StructureCreationRule[] = []): JsonObject {
    if (!source.length || source.length > 2000 || !operations.length || operations.length > 100) throw new CocosError('INVALID_ARGUMENT', 'Structure plan requires 1–2000 nodes and 1–100 operations');
    const nodes = new Map<string, PlannedNode>(), componentOwners = new Map<string, string>();
    const available = new Set(componentTypes), deleted = new Set<string>(), rows: JsonObject[] = [];
    for (const node of source) {
      if (!node.nodeId || nodes.has(node.nodeId)) throw new CocosError('VERIFICATION_FAILED', 'Duplicate or missing native node UUID');
      nodes.set(node.nodeId, { ...node, children: [...node.children], components: node.components.map(component => ({ ...component, created: false })), removed: false, created: false });
      for (const component of node.components) {
        if (!component.componentId || componentOwners.has(component.componentId)) throw new CocosError('VERIFICATION_FAILED', 'Duplicate or missing native component UUID');
        componentOwners.set(component.componentId, node.nodeId);
      }
    }
    const root = nodes.get(rootId);
    if (!root) throw new CocosError('INVALID_ARGUMENT', 'Root is absent from structure snapshot');
    for (const id of componentOwners.keys()) if (nodes.has(id)) throw new CocosError('VERIFICATION_FAILED', 'Node and component identities overlap');
    // 快照必须是完整且唯一的 scoped 子树，截断层级不能作为删除保护依据。
    const seen = new Set<string>();
    const visit = (id: string): void => {
      const node = nodes.get(id);
      if (!node || seen.has(id)) throw new CocosError('VERIFICATION_FAILED', 'Invalid or cyclic native hierarchy');
      seen.add(id);
      for (const childId of node.children) {
        if (nodes.get(childId)?.parentId !== id) throw new CocosError('VERIFICATION_FAILED', 'Native parent/children disagree');
        visit(childId);
      }
    };
    visit(rootId);
    if (seen.size !== nodes.size) throw new CocosError('VERIFICATION_FAILED', 'Snapshot contains nodes outside its scoped root');
    const get = (value: JsonValue | undefined): PlannedNode => {
      const id = Json.string(value, 'node reference'), node = nodes.get(id);
      if (!node || node.removed) throw new CocosError('INVALID_ARGUMENT', 'Node is outside scope, removed, or not created yet');
      return node;
    };
    const editable = (node: PlannedNode): void => {
      // Prefab 实例和资源编辑模式由原生端口显式标记，不能用普通场景节点流程默默修改关联。
      if (node.protectedReason) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Native structure context requires its dedicated workflow', { nodeId: node.nodeId, reason: node.protectedReason });
    };
    const attach = (node: PlannedNode, parent: PlannedNode, index: JsonValue | undefined): void => {
      const position = index === undefined ? parent.children.length : Number(index);
      if (index !== undefined && (typeof index !== 'number' || !Number.isInteger(index)) || position < 0 || position > parent.children.length) throw new CocosError('INVALID_ARGUMENT', 'Sibling index is outside the resulting parent');
      parent.children.splice(position, 0, node.nodeId); node.parentId = parent.nodeId;
    };
    const dependencies = (node: PlannedNode): void => {
      for (const component of node.components) for (const required of component.requires ?? []) {
        if (!node.components.some(candidate => candidate.type === required || candidate.satisfies?.includes(required))) {
          throw new CocosError('OPERATION_CONFLICT', 'Structure operation breaks a native component dependency', { nodeId: node.nodeId, type: component.type, required, operationIndex: rows.length });
        }
      }
    };
    for (const operation of operations) {
      const row = { ...operation };
      if (row.action === 'create') {
        const parent = get(row.parent), key = Json.string(row.key, 'key'); editable(parent);
        if (nodes.has(key) || componentOwners.has(key)) throw new CocosError('OPERATION_CONFLICT', 'Create key overlaps an existing identity');
        const node: PlannedNode = { nodeId: key, parentId: parent.nodeId, name: Json.string(row.name, 'name'), children: [], components: [], removed: false, created: true };
        const implicitComponentTypes: string[] = [];
        for (const rule of creationRules) {
          let matches = rule.inheritedOutsideRoot;
          for (let ancestor: PlannedNode | undefined = parent; ancestor; ancestor = ancestor.nodeId === rootId ? undefined : nodes.get(ancestor.parentId!)) {
            if (ancestor.components.some(component => component.type === rule.ancestorType || component.satisfies?.includes(rule.ancestorType))) matches = true;
          }
          if (matches && !node.components.some(component => component.type === rule.componentType)) {
            if (!available.has(rule.componentType)) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Native default component is unavailable');
            node.components.push({ ...definitions.get(rule.componentType), componentId: `planned-default:${rows.length}:${rule.componentType}`, type: rule.componentType, created: true });
            implicitComponentTypes.push(rule.componentType);
          }
        }
        if (implicitComponentTypes.length) row.implicitComponentTypes = implicitComponentTypes;
        dependencies(node);
        nodes.set(key, node); attach(node, parent, row.index);
      } else if (row.action === 'move') {
        const node = get(row.node), parent = get(row.parent); editable(node); editable(parent);
        if (node.nodeId === rootId) throw new CocosError('INVALID_ARGUMENT', 'Cannot move scoped root');
        for (let ancestor: PlannedNode | undefined = parent; ancestor; ancestor = ancestor.nodeId === rootId ? undefined : nodes.get(ancestor.parentId!)) if (ancestor === node) throw new CocosError('INVALID_ARGUMENT', 'Move creates a cycle');
        const previous = get(node.parentId); editable(previous);
        previous.children.splice(previous.children.indexOf(node.nodeId), 1); attach(node, parent, row.index);
      } else if (row.action === 'remove') {
        const node = get(row.node);
        if (node.nodeId === rootId) throw new CocosError('INVALID_ARGUMENT', 'Cannot remove scoped root');
        const remove = (entry: PlannedNode): void => {
          editable(entry); entry.removed = true;
          if (!entry.created) deleted.add(entry.nodeId);
          for (const component of entry.components) if (!component.created) deleted.add(component.componentId);
          for (const child of entry.children) remove(nodes.get(child)!);
        };
        editable(get(node.parentId)); remove(node);
        const parent = get(node.parentId); parent.children.splice(parent.children.indexOf(node.nodeId), 1);
      } else if (row.action === 'add_component') {
        const node = get(row.node), type = Json.string(row.type, 'type'); editable(node);
        if (!available.has(type) || node.components.some(component => component.type === type)) throw new CocosError('INVALID_ARGUMENT', 'Component type is unavailable or already present');
        node.components.push({ ...definitions.get(type), componentId: `planned-component:${rows.length}`, type, created: true });
        // Creator 会自动补齐缺失依赖；规划必须先声明依赖，避免实际执行产生计划外组件和 UUID。
        dependencies(node);
      } else if (row.action === 'remove_component') {
        const componentId = Json.string(row.componentId, 'componentId'), owner = componentOwners.get(componentId);
        if (!owner) throw new CocosError('INVALID_ARGUMENT', 'Component is outside scoped root');
        const node = get(owner); editable(node);
        const index = node.components.findIndex(component => component.componentId === componentId);
        if (index < 0) throw new CocosError('INVALID_ARGUMENT', 'Component already removed');
        deleted.add(componentId); node.components.splice(index, 1);
        // 不能先删除依赖、稍后再补回：中间步骤会被原生编辑器拒绝，或破坏仍存活的组件。
        dependencies(node);
      } else throw new CocosError('INVALID_ARGUMENT', 'Unknown structure action');
      rows.push(row);
    }
    for (const node of nodes.values()) if (!node.removed) {
      const names = new Map<string, string[]>();
      for (const id of node.children) {
        const name = nodes.get(id)!.name;
        const group = names.get(name) ?? []; group.push(id); names.set(name, group);
      }
      // 原生编辑器自身可能含同名内部节点。保留既有同名集合，不能因此阻止无关分支的编辑；新增冲突仍拒绝。
      const original = source.find(entry => entry.nodeId === node.nodeId);
      for (const [name, ids] of names) if (ids.length > 1 && ids.some(id => !original?.children.includes(id))) {
        throw new CocosError('OPERATION_CONFLICT', 'Result introduces ambiguous sibling names', { parentId: node.nodeId, name });
      }
      dependencies(node);
    }
    const blockers = references.rows.filter(row => deleted.has(row.targetId) && !deleted.has(row.sourceId));
    const deletionAllowed = deleted.size === 0 || references.complete && references.issues.length === 0 && blockers.length === 0;
    return { rootId, rows, applicable: deletionAllowed, transformPolicy: 'preserve-local',
      resultingNodes: [...nodes.values()].filter(node => !node.removed).map(node => ({ key: node.nodeId, nodeId: node.created ? null : node.nodeId, parent: node.parentId, children: node.children, name: node.name, componentTypes: node.components.map(component => component.type) })),
      deletedIds: [...deleted], references: Json.value({ complete: references.complete, blockers, issues: references.issues, deletionAllowed }) };
  }
}
