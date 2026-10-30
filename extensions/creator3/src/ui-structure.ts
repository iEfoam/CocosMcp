import { createHash } from 'node:crypto';
import { CocosError, Json, type JsonObject } from '../../../packages/contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../../packages/runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../../packages/runtime3-bridge/src/scene.js';
import { SerializedReferenceAudit } from '../../../packages/ui-core/src/reference-audit.js';
import { UiStructurePlan, type StructureNode, type StructureComponentType, type StructureReferences } from '../../../packages/ui-core/src/structure-plan.js';

/** 只读取原生对象和组件注册信息，绝不为了推测依赖实例化业务组件。 */
export class Creator3UiStructure {
  constructor(private readonly inspector: SceneInspector, private readonly facade: RuntimeObject) {}

  plan(p: JsonObject): JsonObject {
    const rootId = Json.string(p.rootId, 'rootId');
    if (!Array.isArray(p.rows)) throw new CocosError('INVALID_ARGUMENT', 'rows must be an array');
    const rows = p.rows.map(row => Json.object(row));
    const mode = String(A.call(this.facade, 'queryMode'));
    // 3.8.8 原生 SceneModeType.General 的值是 general；不能用面板的 scene 名称推测枚举。
    if (mode !== 'general' && mode !== 'prefab') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Structure planning requires general scene mode or Prefab asset editing mode', { mode });
    let assetRoot: RuntimeObject | undefined;
    let instanceRoot: RuntimeObject | undefined;
    let context: JsonObject = { kind: 'scene' };
    if (mode === 'prefab') {
      // Prefab 编辑器有自己的代理根节点；不能把包装 Canvas 或其他实例当作资源根。
      const proxy = A.object(A.object(A.call(this.facade, 'getCurrentFacade'))._sceneProxy, 'native Prefab scene proxy');
      assetRoot = A.object(A.call(proxy, 'getRootNode'), 'native Prefab asset root');
      if (A.uuid(assetRoot) !== rootId || this.inspector.node(rootId) !== assetRoot) throw new CocosError('INVALID_ARGUMENT', 'Prefab asset structure scope must be its native asset root');
      const assetUuid = A.call(proxy, 'queryCurrentSceneUuid');
      if (typeof assetUuid !== 'string' || !assetUuid) throw new CocosError('VERIFICATION_FAILED', 'Native Prefab asset identity is unavailable');
      context = { kind: 'prefab-asset', assetUuid, rootId };
    } else {
      const root = this.inspector.node(rootId);
      if (root._prefab && this.inspector.type(root) !== 'cc.Scene') {
        const info = A.object(root._prefab);
        // 实例覆盖必须以完整实例为撤销范围，不能从其中一个子节点绕过关联身份检查。
        if (info.root === root && info.asset && A.uuid(info.asset)) {
          instanceRoot = root;
          context = { kind: 'prefab-instance', assetUuid: A.uuid(info.asset), rootId };
          for (const row of rows) if (row.action === 'move' || row.action === 'remove') {
            const node = this.inspector.all(root).find(candidate => A.uuid(candidate) === row.node);
            // 源资源节点不能按普通节点重排/删除；只允许操作实例中新挂载的节点。
            if (node?._prefab && A.object(node._prefab).fileId) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Source-linked Prefab nodes require editing the Prefab asset', { nodeId: A.uuid(node) });
          }
        }
      }
    }
    const cc = this.inspector.environment.cc, definitions = new Map<string, StructureComponentType>();
    const typeName = (value: unknown): string => {
      const name = A.call(cc.js, 'getClassName', value);
      if (typeof name !== 'string' || !name) throw new CocosError('VERIFICATION_FAILED', 'Native component type identity is unavailable');
      return name;
    };
    const definition = (constructor: unknown): StructureComponentType => {
      const type = typeName(constructor), cached = definitions.get(type);
      if (cached) return cached;
      const dependencyProperty = A.descriptor(constructor, '_requireComponent');
      if (dependencyProperty?.get) throw new CocosError('VERIFICATION_FAILED', 'Component dependency accessor cannot be inspected without running project code');
      const required = dependencyProperty?.value;
      const requires = required ? (Array.isArray(required) ? required : [required]).map(typeName) : [];
      const satisfies: string[] = [];
      // 原生依赖允许子类满足基类要求，不能仅比较组件注册名。
      let current = constructor;
      for (let depth = 0; current && current !== Function.prototype; depth++) {
        if (depth > 64) throw new CocosError('VERIFICATION_FAILED', 'Component inheritance exceeds inspection limit');
        const name = A.call(cc.js, 'getClassName', current);
        if (typeof name === 'string' && name) satisfies.push(name);
        current = Object.getPrototypeOf(current);
      }
      const result = { requires, satisfies }; definitions.set(type, result); return result;
    };
    // Gizmo/编辑器内部树会随选择变化，不属于可保存业务子树，也不能参与计划修订或结果核对。
    const nativeNodes = this.inspector.all(this.inspector.node(rootId));
    const visibleIds = new Set(nativeNodes.map(A.uuid));
    if (nativeNodes.length > 2000) throw new CocosError('INVALID_ARGUMENT', 'Structure snapshot exceeds 2000 nodes');
    const source: StructureNode[] = nativeNodes.map(node => {
      let protectedReason: string | undefined;
      for (let ancestor: RuntimeObject | null = node, depth = 0; ancestor; ancestor = ancestor.parent ? A.object(ancestor.parent) : null, depth++) {
        if (depth > 2000) throw new CocosError('VERIFICATION_FAILED', 'Native parent chain exceeds inspection limit');
        // Scene 本身也有保存用 PrefabInfo（例如 targetOverrides），但并不是 Prefab 实例。
        if (ancestor._prefab && this.inspector.type(ancestor) !== 'cc.Scene') {
          const info = A.object(ancestor._prefab);
          // 资源编辑只放行当前资源自身的关联；嵌套实例仍需独立的 override 工作流。
          if ((!assetRoot || info.root !== assetRoot) && (!instanceRoot || info.root !== instanceRoot)) protectedReason = 'prefab-instance';
        }
        if (Number(ancestor._objFlags ?? 0) & 8) protectedReason = 'editor-internal-node';
        if (ancestor === assetRoot || ancestor === instanceRoot) break;
      }
      return { nodeId: A.uuid(node), parentId: node.parent ? A.uuid(A.object(node.parent)) : null,
        name: String(node.name), children: (node.children as RuntimeObject[]).map(A.uuid).filter(id => visibleIds.has(id)), ...(protectedReason ? { protectedReason } : {}),
        components: (node._components as RuntimeObject[]).map(component => ({ componentId: A.uuid(component), type: typeName(component), ...definition(component.constructor) })) };
    });
    for (const row of rows) if (row.action === 'add_component') {
      const type = Json.string(row.type, 'type'), constructor = A.call(cc.js, 'getClassByName', type);
      if (typeof constructor !== 'function' || !A.call(cc.js, 'isChildClassOf', constructor, cc.Component)) throw new CocosError('INVALID_ARGUMENT', 'Registered component class is unavailable', { type });
      definition(constructor);
    }
    // Creator 3.8.8 NodeManager.ensureUITransformComponent 检查任意 Canvas 上级；原生创建的默认组件也必须列入计划。
    const creationRules = [];
    if (rows.some(row => row.action === 'create')) {
      const transform = A.call(cc.js, 'getClassByName', 'cc.UITransform');
      if (typeof transform === 'function') {
        definition(transform);
        let inheritedOutsideRoot = false;
        for (let parent = this.inspector.node(rootId).parent, depth = 0; parent; parent = A.object(parent).parent, depth++) {
          if (depth > 2000) throw new CocosError('VERIFICATION_FAILED', 'Native ancestor chain exceeds inspection limit');
          for (const component of A.object(parent)._components as RuntimeObject[]) if (definition(component.constructor).satisfies?.includes('cc.Canvas')) inheritedOutsideRoot = true;
        }
        creationRules.push({ ancestorType: 'cc.Canvas', componentType: 'cc.UITransform', inheritedOutsideRoot });
      }
    }
    const audit = new SerializedReferenceAudit().scene(this.inspector);
    const references: StructureReferences = { complete: audit.complete === true,
      rows: (audit.rows as JsonObject[]).filter(row => row.kind !== 'asset').map(row => ({ sourceId: String(row.sourceId), targetId: String(row.targetId), path: String(row.path) })),
      issues: audit.issues as JsonObject[] };
    const result = new UiStructurePlan().create(rootId, source, rows, [...definitions.keys()], references, definitions, creationRules);
    const sourceRevision = createHash('sha256').update(JSON.stringify(this.inspector.fingerprint())).digest('hex');
    const planHash = createHash('sha256').update(JSON.stringify({ sourceRevision, mode, context, result })).digest('hex');
    return { ...result, mode, context, sourceRevision, planHash, applySupported: true };
  }
}
