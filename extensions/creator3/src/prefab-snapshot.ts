import { CocosError, Json, type JsonObject } from '../../../packages/contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../../packages/runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../../packages/runtime3-bridge/src/scene.js';

export class Creator3PrefabSnapshot {
  constructor(private readonly inspector: SceneInspector, private readonly nativeSerialize?: (value: RuntimeObject) => unknown) {}
  capture(nodeId: string): JsonObject {
    const root = this.inspector.node(nodeId), info = A.object(root._prefab ?? {});
    if (!info.asset || info.root !== root) throw new CocosError('INVALID_ARGUMENT', 'Select the linked Prefab instance root');
    const serialize = this.nativeSerialize ?? this.inspector.environment.serialize;
    if (!serialize) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Native editor serialization unavailable');
    const pending: RuntimeObject[] = [root], visited = new Set<RuntimeObject>(), componentIssues: JsonObject[] = []; let components = 0;
    while (pending.length) {
      const node = pending.pop()!;
      if (visited.has(node)) throw new CocosError('VERIFICATION_FAILED', 'Cyclic Prefab instance hierarchy');
      visited.add(node);
      const attached = this.inspector.components(node); components += attached.length;
      if (visited.size + components > 10000) throw new CocosError('RESOURCE_BUSY', 'Prefab snapshot exceeds object budget');
      for (const component of attached) {
        const type = this.inspector.type(component);
        // MissingScript 会保留原始序列化数据，JSON 相等不能证明项目脚本已加载。
        if (type === 'cc.MissingScript' || type === 'Object' || !type) {
          if (componentIssues.length >= 1000) throw new CocosError('RESOURCE_BUSY', 'Prefab component issue budget exceeded');
          componentIssues.push({ side: 'instance', nodeId: A.uuid(node), componentId: A.uuid(component), type,
            code: type === 'cc.MissingScript' ? 'MISSING_COMPONENT_SCRIPT' : 'COMPONENT_TYPE_UNVERIFIED' });
        }
      }
      const children = node.children as RuntimeObject[] ?? [];
      // 在展开待访问队列前限制宽度，避免恶意层级让 spread 参数或内存先于总量守卫耗尽。
      if (children.length + pending.length + visited.size + components > 10000) throw new CocosError('RESOURCE_BUSY', 'Prefab snapshot exceeds object budget');
      for (const child of children) pending.push(child);
    }
    const serialized = Json.value(serialize(root));
    const serializedBytes = new TextEncoder().encode(typeof serialized === 'string' ? serialized : JSON.stringify(serialized)).byteLength;
    // 原生序列化会跟随父级/外部引用；这是返回值预算，不宣称能限制原生序列化内部的瞬时分配。
    if (serializedBytes > 16 * 1024 * 1024) throw new CocosError('RESOURCE_BUSY', 'Native Prefab serialization exceeds snapshot byte budget');
    return { rootId: A.uuid(root), assetUuid: A.uuid(info.asset), observedNodeCount: visited.size, observedComponentCount: components,
      serialized, serializedBytes, componentIssues, serializationScope: 'native-context-with-external-references', source: 'native-editor-serialization', sceneModifiedByTool: false };
  }
}
