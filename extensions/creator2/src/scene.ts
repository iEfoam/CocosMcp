import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../../packages/runtime3-bridge/src/access.js';
import { SceneInspector } from '../../../packages/runtime3-bridge/src/scene.js';

declare const cc: RuntimeObject;
declare const Editor: { serialize(value: unknown): unknown; Undo?: RuntimeObject };
declare const _Scene: RuntimeObject;
interface SceneEvent { reply?(error: unknown, result?: unknown): void }

class Creator2Scene {
  private readonly inspector = new SceneInspector({ cc, major: 2, serialize: value => Editor.serialize(value) });

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
    try { for (const change of prepared) change.owner[change.key] = change.value; }
    catch (error) { for (const change of prepared.reverse()) change.owner[change.key] = change.before; throw error; }
  }

  private type(name: string): unknown { return A.call(cc.js, 'getClassByName', name) ?? A.get(cc, name.replace(/^cc\./, '')); }

  private async mutate(id: string, p: JsonObject): Promise<JsonValue> {
    const str = (key: string): string => Json.string(p[key], key);
    switch (id) {
      case 'node.query': return { node: this.inspector.summary(this.inspector.node(str('nodeId'))) };
      case 'node.create': {
        const node = A.construct(cc.Node, [str('name')]);
        A.call(p.parentId ? this.inspector.node(str('parentId')) : this.inspector.current(), 'addChild', node);
        return { nodeId: A.uuid(node), node: this.inspector.summary(node), undoScope: 'none' };
      }
      case 'node.delete': {
        const node = this.inspector.node(str('nodeId')); A.call(node, 'removeFromParent'); A.call(node, 'destroy'); return { deletedNodeId: str('nodeId'), undoScope: 'none' };
      }
      case 'node.duplicate': {
        const source = this.inspector.node(str('nodeId')); const node = A.object(A.call(cc, 'instantiate', source));
        A.call(source.parent ?? this.inspector.current(), 'addChild', node); return { nodeId: A.uuid(node), node: this.inspector.summary(node), undoScope: 'none' };
      }
      case 'node.reparent': {
        if (p.keepWorldTransform !== false) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Creator 2 world-transform-preserving reparent has not been validated; explicitly use keepWorldTransform=false');
        A.call(this.inspector.node(str('nodeId')), 'setParent', this.inspector.node(str('parentId'))); return this.mutate('node.query', p);
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
        return { componentId: A.uuid(component), component: this.inspector.properties(component), undoScope: 'none' };
      }
      case 'component.query': return { component: this.inspector.properties(this.inspector.component(str('componentId'))) };
      case 'component.delete': A.call(this.inspector.component(str('componentId')), 'destroy'); return { deletedComponentId: str('componentId'), undoScope: 'none' };
      case 'component.set': await this.set(this.inspector.component(str('componentId')), Json.object(p.properties)); return this.mutate('component.query', p);
      case 'component.reset': {
        const target = this.inspector.component(str('componentId'));
        if (typeof target.resetInEditor !== 'function') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Component does not expose resetInEditor');
        A.call(target, 'resetInEditor'); return this.mutate('component.query', p);
      }
      case 'component.invoke': return Json.value(await A.call(this.inspector.component(str('componentId')), str('method'), ...(p.args as JsonValue[] ?? [])));
      case 'prefab.instantiate': {
        const prefab = await this.loadAsset(str('uuid')); const node = A.object(A.call(cc, 'instantiate', prefab));
        if (p.name) node.name = p.name;
        A.call(p.parentId ? this.inspector.node(str('parentId')) : this.inspector.current(), 'addChild', node);
        return { nodeId: A.uuid(node), node: this.inspector.summary(node), undoScope: 'none' };
      }
      default: throw new CocosError('UNSUPPORTED_CAPABILITY', `Creator 2 scene operation is not verified: ${id}`);
    }
  }

  async dispatch(method: string, args: unknown[]): Promise<JsonValue> {
    switch (method) {
      case 'mutate': { const request = Json.object(args[0]); return this.mutate(Json.string(request.capabilityId, 'capabilityId'), Json.object(request.params)); }
      case 'serializeCurrentScene': return this.serializeScene();
      case 'openScene': {
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
        if (!Editor.Undo) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Editor undo manager unavailable');
        A.call(Editor.Undo, method); return { scope: 'editor-native-history', scene: this.inspector.sceneInfo() };
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
