import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';

export interface SceneEnvironment {
  cc: RuntimeObject;
  major: 2 | 3;
  serialize?: (value: unknown) => unknown;
  editor?: boolean;
}

export class SceneInspector {
  constructor(readonly environment: SceneEnvironment) {}

  current(): RuntimeObject {
    return A.object(A.call(this.environment.cc.director, 'getScene'), 'active scene');
  }

  all(root = this.current(), includeInternal = false): RuntimeObject[] {
    const rows: RuntimeObject[] = []; const pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (!includeInternal && this.environment.editor && (Number(node._objFlags ?? 0) & 8)) continue;
      rows.push(node);
      const children = node.children as RuntimeObject[] | undefined;
      if (children) for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]!);
    }
    return rows;
  }

  node(id: string): RuntimeObject {
    // 编辑器节点缓存保留已删除对象；只能以当前场景树判断节点是否存在。
    const node = this.all().find(row => A.uuid(row) === id);
    if (!node) throw new CocosError('NOT_FOUND', `Node not found: ${id}`);
    return node;
  }

  components(node: RuntimeObject): RuntimeObject[] {
    return A.call(node, 'getComponents', this.environment.cc.Component) as RuntimeObject[];
  }

  component(id: string): RuntimeObject {
    for (const node of this.all()) {
      const component = this.components(node).find(row => A.uuid(row) === id);
      if (component) return component;
    }
    throw new CocosError('NOT_FOUND', `Component not found: ${id}`);
  }

  type(value: unknown): string {
    try { return String(A.call(this.environment.cc.js, 'getClassName', value)); }
    catch { return 'Object'; }
  }

  properties(component: RuntimeObject): JsonObject {
    const constructor = A.object(component.constructor);
    const props = Array.isArray(constructor.__props__) ? constructor.__props__ as string[] : [];
    const result: JsonObject = {};
    for (const key of props) {
      if (['node', '_name', '_objFlags'].includes(key)) continue;
      const value = component[key];
      if (value && typeof value === 'object' && A.uuid(value)) result[key] = { uuid: A.uuid(value) };
      else result[key] = A.safeData(value);
    }
    return result;
  }

  summary(node: RuntimeObject, includeComponents = true, includeInternal = false): JsonObject {
    const result: JsonObject = { nodeId: A.uuid(node), name: String(node.name ?? ''), active: Boolean(node.active),
      parentId: node.parent ? A.uuid(node.parent) : null, children: (node.children as RuntimeObject[] ?? []).filter(child => includeInternal || !this.environment.editor || !(Number(child._objFlags ?? 0) & 8)).map(child => A.uuid(child)),
      position: A.safeData(node.position), rotation: A.safeData(node.eulerAngles ?? node.angle), scale: A.safeData(node.scale),
      layer: A.safeData(node.layer ?? node.groupIndex) };
    if (includeComponents) result.components = this.components(node).map(component => ({ componentId: A.uuid(component), type: this.type(component), enabled: Boolean(component.enabled), properties: this.properties(component) }));
    return result;
  }

  sceneInfo(): JsonObject {
    const scene = this.current(); return { sceneId: A.uuid(scene), name: String(scene.name), nodeCount: this.all().length - 1 };
  }

  hierarchy(p: JsonObject): JsonValue {
    const root = p.rootId ? this.all(this.current(), p.includeInternal === true).find(row => A.uuid(row) === p.rootId) : this.current();
    if (!root) throw new CocosError('NOT_FOUND', 'Hierarchy root is not in the active scene');
    const rows = this.all(root, p.includeInternal === true); const offset = Number(p.offset ?? 0); const limit = Number(p.limit ?? 100);
    return { rows: rows.slice(offset, offset + limit).map(row => this.summary(row, p.includeComponents !== false, p.includeInternal === true)), total: rows.length,
      nextOffset: offset + limit < rows.length ? offset + limit : null };
  }

  fingerprint(): JsonValue {
    try {
      if (this.environment.serialize) {
        // 使用编辑器序列化结果覆盖属性、引用和预制体关系，避免只对层级名字计算版本。
        return Json.value(this.environment.serialize(this.current()));
      }
      return this.all().map(node => this.summary(node));
    } catch (error) {
      if (error instanceof CocosError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  findNodes(p: JsonObject): JsonValue {
    if (!p.name && !p.path) throw new CocosError('INVALID_ARGUMENT', 'Specify name or path');
    const pathFor = (node: RuntimeObject): string => {
      const segments: string[] = []; let current: RuntimeObject | null = node;
      while (current?.parent) { segments.unshift(String(current.name)); current = current.parent as RuntimeObject; }
      return segments.join('/');
    };
    const rows = this.all().filter(node => (!p.name || node.name === p.name) && (!p.path || pathFor(node) === p.path));
    return { rows: rows.map(node => this.summary(node)), total: rows.length };
  }

  createSceneAsset(p: JsonObject): JsonValue {
    if (!this.environment.serialize) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Editor serializer is not available');
    const scene = A.construct(this.environment.cc.Scene, []);
    const asset = A.construct(this.environment.cc.SceneAsset, []);
    const name = String(p.url ?? 'Untitled').split('/').pop()!.replace(/\.(scene|fire)$/, '');
    scene.name = name; asset.name = name; asset.scene = scene;
    try {
      const data = this.environment.serialize(asset);
      return typeof data === 'string' ? JSON.parse(data) as JsonValue : Json.value(data);
    } finally { A.call(asset, 'destroy'); A.call(scene, 'destroy'); }
  }

  subtreeIdentity(id: string): JsonObject {
    const root = this.node(id);
    const rows: JsonObject[] = [];
    const visit = (node: RuntimeObject, path: string): void => {
      rows.push({ path, nodeId: A.uuid(node), name: String(node.name) });
      (node.children as RuntimeObject[] ?? []).forEach((child, index) => visit(child, `${path}/${index}`));
    };
    visit(root, '');
    const parent = root.parent as RuntimeObject | undefined;
    return { rows, parentId: parent ? A.uuid(parent) : null, index: parent ? (parent.children as RuntimeObject[]).indexOf(root) : -1 };
  }

  serializeCurrentScene(): JsonValue {
    if (!this.environment.serialize) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Editor serializer is not available');
    const asset = A.construct(this.environment.cc.SceneAsset, []);
    const scene = this.current(); asset.scene = scene; asset.name = scene.name;
    // 包装器关联活动场景，不能销毁它，否则会连带销毁用户正在编辑的场景。
    const data = this.environment.serialize(asset);
    return typeof data === 'string' ? JSON.parse(data) as JsonValue : Json.value(data);
  }

  validateScene(): JsonValue {
    const rows: JsonObject[] = [];
    for (const node of this.all()) {
      const components = node._components;
      if (Array.isArray(components)) components.forEach((component, index) => {
        if (!component) rows.push({ code: 'MISSING_COMPONENT', nodeId: A.uuid(node), index });
      });
      for (const component of this.components(node)) {
        for (const [key, value] of Object.entries(component)) {
          if (key.startsWith('_') || !value || typeof value !== 'object') continue;
          const object = A.object(value);
          if ('isValid' in object && object.isValid === false) rows.push({ code: 'INVALID_REFERENCE', nodeId: A.uuid(node), componentId: A.uuid(component), property: key });
        }
      }
    }
    return { rows, valid: rows.length === 0, scope: 'missing-components-and-invalid-loaded-references' };
  }

  execute(method: string, args: unknown[]): JsonValue {
    switch (method) {
      case 'fingerprint': return this.fingerprint();
      case 'sceneInfo': return this.sceneInfo();
      case 'hierarchy': return this.hierarchy(Json.object(args[0] ?? {}));
      case 'findNodes': return this.findNodes(Json.object(args[0]));
      case 'serializeCurrentScene': return this.serializeCurrentScene();
      case 'subtreeIdentity': return this.subtreeIdentity(String(args[0]));
      case 'childAt': return A.uuid((this.node(String(args[0])).children as RuntimeObject[])[Number(args[1])]);
      case 'nodeExists': return this.all().some(node => A.uuid(node) === String(args[0]));
      case 'componentLocation': {
        for (const node of this.all()) {
          // 属性路径按原始组件槽位编号，缺失脚本占位不能被 getComponents 过滤后压缩。
          const components = Array.isArray(node._components) ? node._components : this.components(node);
          const index = components.findIndex(component => component && A.uuid(component) === String(args[0]));
          if (index >= 0) return { nodeId: A.uuid(node), index };
        }
        throw new CocosError('NOT_FOUND', `Component not found: ${String(args[0])}`);
      }
      case 'componentIds': return this.components(this.node(String(args[0]))).map(component => A.uuid(component));
      case 'createSceneAsset': return this.createSceneAsset(Json.object(args[0]));
      case 'validateScene': return this.validateScene();
      default: throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown scene method: ${method}`);
    }
  }
}
