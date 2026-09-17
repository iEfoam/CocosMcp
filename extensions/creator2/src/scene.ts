import { Creator2ReferenceAudit } from './reference-audit.js';
import { Creator2Material } from '../../../packages/runtime2-bridge/src/material.js';
import { Creator2Animation } from './animation.js';
import { Creator2Ui } from './ui.js';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../../packages/runtime3-bridge/src/access.js';
import { SceneInspector } from '../../../packages/runtime3-bridge/src/scene.js';

declare const cc: RuntimeObject;
declare const Editor: { serialize(value: unknown): unknown; Undo?: RuntimeObject };
declare const _Scene: RuntimeObject;
interface SceneEvent { reply?(error: unknown, result?: unknown): void }

class Creator2Scene {
  private readonly inspector = new SceneInspector({ cc, major: 2, editor: true, serialize: value => Editor.serialize(value) });

  private undo(): RuntimeObject {
    if (!_Scene.Undo) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Creator 2 native scene undo is unavailable');
    return A.object(_Scene.Undo);
  }
  private clean(): void { if (A.call(this.undo(), 'dirty')) throw new CocosError('RESOURCE_BUSY', 'Save the scene before switching or closing it'); }
  private sceneInfo(): JsonObject { return { ...Json.object(this.inspector.sceneInfo()), dirty: Boolean(A.call(this.undo(), 'dirty')) }; }
  private matches(actual: unknown, expected: unknown): boolean {
    if (actual === expected) return true;
    if (typeof expected === 'number') return typeof actual === 'number' && Math.abs(actual - expected) < 1e-6;
    if (expected && typeof expected === 'object' && A.uuid(expected)) return A.uuid(actual) === A.uuid(expected);
    if (expected && typeof expected === 'object') return Boolean(actual && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => this.matches(A.object(actual)[key], value)));
    return actual === expected;
  }

  private serializeScene(): JsonValue {
    const scene = this.inspector.current();
    const asset = A.construct(cc.SceneAsset, []); asset.scene = scene; asset.name = scene.name;
    // 不销毁包装的 SceneAsset，避免其生命周期实现连带销毁正在编辑的场景。
    return { uuid: A.uuid(scene), content: Json.value(Editor.serialize(asset)) };
  }

  private async loadAsset(uuid: string): Promise<unknown> {
    return new Promise((accept, reject) => {
      const callback = (error: unknown, value: unknown): void => { if (error) reject(error); else accept(value); };
      if (cc.assetManager) A.call(cc.assetManager, 'loadAny', uuid, callback);
      else A.call(cc.loader, 'load', { uuid }, callback);
    });
  }

  private async value(value: JsonValue): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map(entry => this.value(entry)));
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.uuid === 'string') {
      try { return this.inspector.node(value.uuid); } catch (error) { if (!(error instanceof CocosError) || error.code !== 'NOT_FOUND') throw error; }
      try { return this.inspector.component(value.uuid); } catch (error) { if (!(error instanceof CocosError) || error.code !== 'NOT_FOUND') throw error; }
      return this.loadAsset(value.uuid);
    }
    return value;
  }

  private async set(target: RuntimeObject, properties: JsonObject): Promise<void> {
    const prepared: Array<{ owner: RuntimeObject; key: string; value: unknown; before: unknown }> = [];
    for (const [path, value] of Object.entries(properties)) {
      const segments = Json.safePath(path); const key = segments.pop()!;
      const owner = segments.length ? A.object(A.get(target, segments.join('.'))) : target;
      const descriptor = A.descriptor(owner, key);
      if (!descriptor || (!descriptor.writable && !descriptor.set)) throw new CocosError('INVALID_ARGUMENT', `Property is missing or read-only: ${path}`);
      prepared.push({ owner, key, value: await this.value(value), before: owner[key] });
    }
    A.call(this.undo(), 'recordObject', A.uuid(target), 'CocosMCP 修改属性');
    try {
      for (const change of prepared) change.owner[change.key] = change.value;
      for (const change of prepared) if (!this.matches(change.owner[change.key], change.value)) throw new CocosError('VERIFICATION_FAILED', `Property readback failed: ${change.key}`);
      A.call(this.undo(), 'commit');
    }
    catch (error) { for (const change of prepared.reverse()) change.owner[change.key] = change.before; A.call(this.undo(), 'cancel'); throw error; }
  }

  private type(name: string): unknown { return A.call(cc.js, 'getClassByName', name) ?? A.get(cc, name.replace(/^cc\./, '')); }

  private async mutate(id: string, p: JsonObject): Promise<JsonValue> {
    const str = (key: string): string => Json.string(p[key], key);
    switch (id) {
      case 'node.query': return { node: this.inspector.summary(this.inspector.node(str('nodeId'))) };
      case 'node.create': {
        const node = A.construct(cc.Node, [str('name')]);
        A.call(p.parentId ? this.inspector.node(str('parentId')) : this.inspector.current(), 'addChild', node);
        A.call(this.undo(), 'recordCreateNode', A.uuid(node)); A.call(this.undo(), 'commit');
        return { nodeId: A.uuid(node), node: this.inspector.summary(node), undoScope: 'editor-native-history' };
      }
      case 'node.delete': {
        const node = this.inspector.node(str('nodeId'));
        if (node === this.inspector.current()) throw new CocosError('INVALID_ARGUMENT', 'Cannot delete scene root');
        A.call(this.undo(), 'recordDeleteNode', A.uuid(node)); A.call(node, 'removeFromParent'); A.call(node, 'destroy'); A.call(this.undo(), 'commit');
        return { deletedNodeId: str('nodeId'), undoScope: 'editor-native-history' };
      }
      case 'node.duplicate': {
        const source = this.inspector.node(str('nodeId')); const node = A.object(A.call(cc, 'instantiate', source));
        A.call(source.parent ?? this.inspector.current(), 'addChild', node); A.call(this.undo(), 'recordCreateNode', A.uuid(node)); A.call(this.undo(), 'commit');
        return { nodeId: A.uuid(node), node: this.inspector.summary(node), undoScope: 'editor-native-history' };
      }
      case 'node.reparent': {
        const node = this.inspector.node(str('nodeId')), parent = this.inspector.node(str('parentId'));
        if (node === this.inspector.current() || this.inspector.all(node).includes(parent)) throw new CocosError('INVALID_ARGUMENT', 'Parent would create a cycle or move the scene root');
        const before = A.construct(cc.Mat4, []); A.call(node, 'getWorldMatrix', before);
        const position = A.construct(cc.Vec3, []), rotation = A.construct(cc.Quat, []), scale = A.construct(cc.Vec3, []);
        if (p.keepWorldTransform !== false) {
          A.call(node, 'getWorldPosition', position); A.call(node, 'getWorldRotation', rotation); A.call(node, 'getWorldScale', scale);
          const parentScale = A.construct(cc.Vec3, []); A.call(parent, 'getWorldScale', parentScale);
          if (['x', 'y', 'z'].some(key => Math.abs(Number(parentScale[key])) < 1e-8)) throw new CocosError('INVALID_ARGUMENT', 'Singular parent transform');
        }
        const oldParent = node.parent, sibling = A.call(node, 'getSiblingIndex'), oldPosition = A.call(node.position, 'clone'), oldRotation = A.call(node.eulerAngles, 'clone'), oldScale = A.construct(cc.Vec3, [node.scaleX, node.scaleY, node.scaleZ]);
        A.call(this.undo(), 'recordMoveNode', A.uuid(node)); A.call(this.undo(), 'recordNode', A.uuid(node));
        try {
          A.call(node, 'setParent', parent);
          if (p.keepWorldTransform !== false) {
            A.call(node, 'setWorldPosition', position); A.call(node, 'setWorldRotation', rotation); A.call(node, 'setWorldScale', scale);
            const after = A.construct(cc.Mat4, []); A.call(node, 'getWorldMatrix', after);
            if (Object.keys(before).some(key => typeof before[key] === 'number' && Math.abs(Number(before[key]) - Number(after[key])) > 1e-4)) throw new CocosError('UNSUPPORTED_CAPABILITY', 'World transform cannot be represented without shear');
          }
          A.call(this.undo(), 'commit');
        } catch (error) { A.call(node, 'setParent', oldParent); A.call(node, 'setSiblingIndex', sibling); node.position = oldPosition; node.eulerAngles = oldRotation; A.call(node, 'setScale', oldScale); A.call(this.undo(), 'cancel'); throw error; }
        return this.mutate('node.query', p);
      }
      case 'node.set': await this.set(this.inspector.node(str('nodeId')), Json.object(p.properties)); return this.mutate('node.query', p);
      case 'node.reset': await this.set(this.inspector.node(str('nodeId')), { position: { x: 0, y: 0, z: 0 }, angle: 0, scaleX: 1, scaleY: 1 }); return this.mutate('node.query', p);
      case 'component.types': {
        const js = A.object(cc.js); const rows: JsonObject[] = [];
        const registry = js._registeredClassNames;
        if (!registry || typeof registry !== 'object') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Creator 2 class registry is unavailable');
        for (const [name, type] of Object.entries(A.object(registry))) {
          if (A.call(js, 'isChildClassOf', type, cc.Component)) rows.push({ name });
        }
        return { rows };
      }
      case 'component.add': {
        const component = A.object(A.call(this.inspector.node(str('nodeId')), 'addComponent', this.type(str('type'))));
        const owner = this.inspector.node(str('nodeId'));
        A.call(this.undo(), 'recordAddComponent', A.uuid(owner), component, (owner._components as unknown[]).indexOf(component)); A.call(this.undo(), 'commit');
        return { componentId: A.uuid(component), component: this.inspector.properties(component), undoScope: 'editor-native-history' };
      }
      case 'component.query': return { component: this.inspector.properties(this.inspector.component(str('componentId'))) };
      case 'component.delete': {
        const component = this.inspector.component(str('componentId')), owner = A.object(component.node);
        A.call(this.undo(), 'recordRemoveComponent', A.uuid(owner), component, (owner._components as unknown[]).indexOf(component)); A.call(component, 'destroy'); A.call(this.undo(), 'commit');
        return { deletedComponentId: str('componentId'), undoScope: 'editor-native-history' };
      }
      case 'component.set': await this.set(this.inspector.component(str('componentId')), Json.object(p.properties)); return this.mutate('component.query', p);
      case 'component.reset': {
        const target = this.inspector.component(str('componentId'));
        if (typeof target.resetInEditor !== 'function') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Component does not expose resetInEditor');
        A.call(this.undo(), 'recordObject', A.uuid(target)); A.call(target, 'resetInEditor'); A.call(this.undo(), 'commit'); return this.mutate('component.query', p);
      }
      case 'component.invoke': return Json.value(await A.call(this.inspector.component(str('componentId')), str('method'), ...await Promise.all((p.args as JsonValue[] ?? []).map(value => this.value(value)))));
      case 'prefab.instantiate': {
        const prefab = await this.loadAsset(str('uuid')); const node = A.object(A.call(cc, 'instantiate', prefab));
        if (p.name) node.name = p.name;
        A.call(p.parentId ? this.inspector.node(str('parentId')) : this.inspector.current(), 'addChild', node);
        A.call(this.undo(), 'recordCreateNode', A.uuid(node)); A.call(this.undo(), 'commit');
        return { nodeId: A.uuid(node), node: this.inspector.summary(node), undoScope: 'editor-native-history' };
      }
      case 'prefab.apply': case 'prefab.revert': case 'prefab.unlink': {
        const node = this.inspector.node(str('nodeId'));
        if (!node._prefab) throw new CocosError('INVALID_ARGUMENT', 'Node is not a prefab instance');
        const method = id === 'prefab.apply' ? 'applyPrefab' : id === 'prefab.revert' ? 'revertPrefab' : 'breakPrefabInstance';
        A.call(_Scene, method, id === 'prefab.unlink' ? [A.uuid(node)] : A.uuid(node));
        return { requested: true, nodeId: A.uuid(node), method, verification: 'readback-required' };
      }
      default: throw new CocosError('UNSUPPORTED_CAPABILITY', `Creator 2 scene operation is not verified: ${id}`);
    }
  }

  async dispatch(method: string, args: unknown[]): Promise<JsonValue> {
    const materials = new Creator2Material(this.inspector);
    if (method === 'material.serialize') return materials.serialized(Json.object(args[0]), value => Editor.serialize(value));
    if (method === 'material.bindings') { const uuid = Json.string(Json.object(args[0]).uuid, 'uuid'); return { rows: this.inspector.all().flatMap(node => this.inspector.components(node).flatMap(component => Array.isArray(component.materials) ? component.materials.flatMap((material, slot) => A.uuid(material) === uuid ? [{ nodeId: A.uuid(node), componentId: A.uuid(component), slot, materialUuid: uuid }] : []) : [])) }; }
    if (method === 'material.inspect') return materials.describe(await materials.load(Json.string(Json.object(args[0]).uuid, 'uuid')));
    if (method === 'shader.inspect') { const effect = await materials.load(Json.string(Json.object(args[0]).uuid, 'uuid')); if (this.inspector.type(effect) !== 'cc.EffectAsset') throw new CocosError('INVALID_ARGUMENT', 'Expected EffectAsset'); return { uuid: A.uuid(effect), techniques: A.safeData(effect.techniques), shaders: A.safeData(effect.shaders), gpuValidated: false }; }
    if (method === 'material.assign') {
      const p = Json.object(args[0]), component = this.inspector.component(Json.string(p.componentId, 'componentId')), slot = Number(p.slot ?? 0);
      if (!Array.isArray(component.materials) || slot < 0 || slot >= component.materials.length) throw new CocosError('INVALID_ARGUMENT', 'Invalid material slot');
      const before = component.materials[slot];
      if (A.uuid(before) !== p.expectedMaterialUuid) throw new CocosError('STALE_REVISION', 'Material binding changed');
      const material = await materials.load(Json.string(p.materialUuid, 'materialUuid'));
      if (this.inspector.type(material) !== 'cc.Material') throw new CocosError('INVALID_ARGUMENT', 'Expected Material');
      A.call(this.undo(), 'recordObject', A.uuid(component)); A.call(component, 'setMaterial', slot, material); A.call(this.undo(), 'commit');
      if (A.uuid((component.materials as unknown[])[slot]) !== A.uuid(material)) throw new CocosError('VERIFICATION_FAILED', 'Material binding readback failed');
      return { materialUuid: A.uuid(material), beforeUuid: A.uuid(before), componentId: A.uuid(component), slot };
    }
    if (method.startsWith('animation')) return new Creator2Animation(this.inspector, value => Editor.serialize(value), uuid => this.loadAsset(uuid)).execute(method, Json.object(args[0]));
    if (method.startsWith('ui.')) return new Creator2Ui(this.inspector, this.undo(), uuid => this.loadAsset(uuid)).execute(method, Json.object(args[0]));
    switch (method) {
      case 'scene.references': return new Creator2ReferenceAudit().scene(this.inspector);
      case 'sceneInfo': return this.sceneInfo();
      case 'createSceneAsset': this.clean(); return this.inspector.createSceneAsset(Json.object(args[0]));
      case 'markSaved': A.call(this.undo(), 'save'); return this.sceneInfo();
      case 'closeScene': this.clean(); A.call(_Scene, 'newScene'); return this.sceneInfo();
      case 'view.query': return { view: A.safeData(_Scene.view), tool: A.safeData(A.object(_Scene.gizmosView).transformTool), coordinate: A.safeData(A.object(_Scene.gizmosView).coordinate), pivot: A.safeData(A.object(_Scene.gizmosView).pivot) };
      case 'view.set': {
        const p = Json.object(args[0]);
        if (p.grid !== undefined) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Grid setter has not been verified');
        for (const [key, setter] of [['tool', 'setTransformTool'], ['coordinate', 'setCoordinate'], ['pivot', 'setPivot'], ['is2D', 'setGizmoDimension']]) if (p[key!] !== undefined) A.call(_Scene, setter!, key === 'is2D' ? (p[key!] ? 2 : 3) : p[key!]);
        return this.dispatch('view.query', []);
      }
      case 'view.focus': throw new CocosError('UNSUPPORTED_CAPABILITY', 'Native focus endpoint is pending inspection');
      case 'environment': return { editor: Object.keys(Editor).sort(), scene: Object.keys(_Scene).sort(), undo: Object.keys(this.undo()).sort(), view: A.propertyNames(_Scene.view), gizmosView: A.propertyNames(_Scene.gizmosView), engineVersion: String(cc.ENGINE_VERSION ?? '') };
      case 'mutate': { const request = Json.object(args[0]); return this.mutate(Json.string(request.capabilityId, 'capabilityId'), Json.object(request.params)); }
      case 'serializeCurrentScene': return this.serializeScene();
      case 'openScene': {
        this.clean();
        const p = Json.object(args[0]);
        return new Promise((accept, reject) => A.call(_Scene, 'loadSceneByUuid', Json.string(p.uuid, 'uuid'), (error: unknown) => error ? reject(error) : accept(this.inspector.sceneInfo())));
      }
      case 'serializePrefab': {
        const p = Json.object(args[0]); const prefab = A.construct(cc.Prefab, []);
        prefab.data = this.inspector.node(Json.string(p.nodeId, 'nodeId'));
        const serialized = Editor.serialize(prefab);
        return typeof serialized === 'string' ? JSON.parse(serialized) as JsonValue : Json.value(serialized);
      }
      case 'undo': case 'redo': {
        A.call(this.undo(), method); return { scope: 'editor-native-history', scene: this.sceneInfo() };
      }
      default: return this.inspector.execute(method, args);
    }
  }
}

let scene: Creator2Scene | undefined;
export = {
  dispatch(event: SceneEvent, request: { method: string; args: unknown[] }): void {
    if (!scene) scene = new Creator2Scene();
    void scene.dispatch(request.method, request.args).then(result => event.reply?.(null, result), error => event.reply?.(CocosError.from(error, 'EDITOR_ERROR').toJSON()));
  },
};
