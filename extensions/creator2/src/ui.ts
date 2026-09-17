import { Creator2ReferenceAudit } from './reference-audit.js';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { UiDocumentModel, type UiRow } from '../../../packages/ui-core/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../../packages/runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../../packages/runtime3-bridge/src/scene.js';
import { Creator2Features } from '../../../packages/runtime2-bridge/src/features.js';
import { Creator2UiStructure } from './ui-structure.js';

/** 声明文档保持跨版本语义，UITransform/UIOpacity 映射到 2.x Node 原生属性。 */
export class Creator2Ui {
  constructor(private readonly inspector: SceneInspector, private readonly undo: RuntimeObject, private readonly load: (uuid: string) => Promise<unknown>) {}
  private type(name: string): unknown { return A.call(this.inspector.environment.cc.js, 'getClassByName', name); }
  private virtual(type: string): boolean { return ['cc.UITransform', 'cc.UIOpacity'].includes(type); }
  private validate(rows: UiRow[]): void {
    for (const row of rows) for (const component of row.node.components ?? []) {
      if (!this.virtual(component.type) && !this.type(component.type)) throw new CocosError('UNSUPPORTED_CAPABILITY', `Creator 2 component unavailable: ${component.type}`);
      if (component.type === 'cc.Canvas' && component.properties?.alignCanvasWithScreen !== undefined) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Creator 2 Canvas uses designResolution/fitWidth/fitHeight');
      if (component.type === 'cc.Mask' && component.properties?.type === 3) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Creator 2 Mask type 3 is unavailable');
    }
  }
  private async resolve(value: JsonValue, mapping: Map<string, RuntimeObject>): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map(row => this.resolve(row, mapping)));
    if (!value || typeof value !== 'object') return value;
    if (typeof value.assetUuid === 'string') return this.load(value.assetUuid);
    if (typeof value.nodeKey === 'string') {
      const node = mapping.get(value.nodeKey);
      if (!node) throw new CocosError('NOT_FOUND', `Unknown node key ${value.nodeKey}`);
      return value.componentType ? A.call(node, 'getComponent', this.type(String(value.componentType))) : node;
    }
    if (typeof value.componentId === 'string' && typeof value.handler === 'string') {
      const component = this.inspector.component(value.componentId), method = component[value.handler];
      if (this.inspector.components(A.object(component.node)).filter(row => this.inspector.type(row) === this.inspector.type(component)).length !== 1) throw new CocosError('INVALID_ARGUMENT', 'Serialized event cannot distinguish multiple components of the same class');
      if (typeof method !== 'function') throw new CocosError('INVALID_ARGUMENT', 'Event handler does not exist');
      const event = A.construct(A.object(this.inspector.environment.cc.Component).EventHandler, []);
      event.target = component.node; event.component = this.inspector.type(component); event.handler = value.handler; event.customEventData = value.customEventData ?? ''; return event;
    }
    if ('width' in value && 'height' in value) return A.construct(this.inspector.environment.cc.Size, [value.width, value.height]);
    if ('x' in value && 'y' in value) return A.construct(this.inspector.environment.cc.Vec2, [value.x, value.y]);
    return value;
  }
  private target(node: RuntimeObject, type: string): RuntimeObject { return this.virtual(type) ? node : A.object(A.call(node, 'getComponent', this.type(type))); }
  private property(type: string, key: string): string { return type === 'cc.UITransform' ? ({ contentSize: '_contentSize', anchorPoint: '_anchorPoint' }[key] ?? key) : key; }
  private assign(target: RuntimeObject, type: string, key: string, value: unknown): void {
    if (type === 'cc.UITransform' && key === 'contentSize') A.call(target, 'setContentSize', value);
    else if (type === 'cc.UITransform' && key === 'anchorPoint') A.call(target, 'setAnchorPoint', value);
    else target[key] = value;
  }
  private mapping(rows: UiRow[], p: JsonObject): Map<string, RuntimeObject> {
    const root = this.inspector.node(Json.string(p.rootId, 'rootId')), subtree = this.inspector.all(root);
    const mapping = new Map<string, RuntimeObject>();
    for (const raw of p.mapping as JsonObject[]) {
      const key = Json.string(raw.key, 'key'), node = this.inspector.node(Json.string(raw.nodeId, 'nodeId'));
      if (mapping.has(key) || [...mapping.values()].includes(node) || !subtree.includes(node)) throw new CocosError('INVALID_ARGUMENT', 'Mapping must be unique and inside root');
      mapping.set(key, node);
    }
    if (mapping.size !== rows.length || mapping.get(rows[0]!.key) !== root) throw new CocosError('UNSUPPORTED_CAPABILITY', 'UI structural updates require an explicit separate operation');
    for (const row of rows) {
      const node = mapping.get(row.key);
      if (!node || (row.parentKey && node.parent !== mapping.get(row.parentKey))) throw new CocosError('UNSUPPORTED_CAPABILITY', 'UI hierarchy does not match declaration');
      for (const component of row.node.components ?? []) this.target(node, component.type);
    }
    return mapping;
  }
  async execute(method: string, p: JsonObject): Promise<JsonValue> {
    if (method.startsWith('ui.structure.')) return new Creator2UiStructure(this.inspector, this.undo).execute(method, p);
    if (method === 'ui.inspect_layout') return new Creator2Features(this.inspector).ui(p, 'inspect');
    if (method === 'ui.validate_interaction') {
      const owners = new Set(this.inspector.all(this.inspector.node(Json.string(p.rootId, 'rootId'))).flatMap(node => this.inspector.components(node).map(c => A.uuid(c))));
      const audit = new Creator2ReferenceAudit().scene(this.inspector);
      const rows = (audit.events as JsonObject[]).filter(event => owners.has(String(event.sourceId)));
      return { rows, valid: rows.every(row => row.valid === true), callbacksInvoked: false, scope: 'serialized-event-handlers' };
    }
    const rows = new UiDocumentModel().parse(p.document); this.validate(rows);
    const update = method === 'ui.diff' || method === 'ui.apply';
    const parent = update ? null : this.inspector.node(Json.string(p.parentId, 'parentId'));
    if (parent && (parent.children as RuntimeObject[]).some(node => node.name === rows[0]!.node.name)) throw new CocosError('OPERATION_CONFLICT', 'UI root name already exists');
    const mapping = update ? this.mapping(rows, p) : new Map<string, RuntimeObject>();
    if (method === 'ui.plan') {
      // 资源与事件引用在计划阶段就校验；不创建临时场景对象。
      for (const row of rows) for (const component of row.node.components ?? []) for (const value of Object.values(component.properties ?? {})) {
        if (value && typeof value === 'object' && !Array.isArray(value) && 'assetUuid' in value) await this.resolve(value, mapping);
        if (Array.isArray(value)) await this.resolve(value, mapping);
      }
      return { rows: rows.map(row => ({ key: row.key, name: row.node.name })), mapping: 'Creator2.Node-size-anchor-opacity', nativeVersion: '2.4.15' };
    }
    let root: RuntimeObject | undefined;
    const changes: Array<{ target: RuntimeObject; type: string; key: string; before: unknown; after: unknown }> = [];
    try {
      if (!update) for (const row of rows) {
        const node = A.construct(this.inspector.environment.cc.Node, [row.node.name]); mapping.set(row.key, node); root ??= node;
        if (row.parentKey) A.call(mapping.get(row.parentKey), 'addChild', node);
        for (const component of row.node.components ?? []) if (!this.virtual(component.type)) A.call(node, 'addComponent', this.type(component.type));
      }
      for (const row of rows) {
        const node = mapping.get(row.key)!;
        changes.push({ target: node, type: '', key: 'name', before: node.name, after: row.node.name });
        if (row.node.position) changes.push({ target: node, type: '', key: 'position', before: A.call(node.position, 'clone'), after: A.construct(this.inspector.environment.cc.Vec3, [row.node.position.x, row.node.position.y, row.node.position.z]) });
        for (const component of [...row.node.components ?? []].sort((a,b) => Number(a.type === 'cc.UITransform') - Number(b.type === 'cc.UITransform'))) {
          const target = this.target(node, component.type);
          for (const [key, value] of Object.entries(component.properties ?? {})) {
            const property = this.property(component.type, key);
            if (!A.descriptor(target, property)) throw new CocosError('UNSUPPORTED_CAPABILITY', `Creator 2 property unavailable: ${component.type}.${key}`);
            changes.push({ target, type: component.type, key, before: target[property] && typeof target[property] === 'object' && typeof A.object(target[property]).clone === 'function' ? A.call(target[property], 'clone') : target[property], after: await this.resolve(value, mapping) });
          }
        }
      }
      if (method === 'ui.diff') return { rows: changes.map(change => ({ objectId: A.uuid(change.target), property: change.key, before: A.safeData(change.before), after: A.safeData(change.after) })), structuralChanges: false };
      if (update) for (const target of new Set(changes.map(change => change.target))) A.call(this.undo, 'recordObject', A.uuid(target));
      for (const change of changes) this.assign(change.target, change.type, change.key, change.after);
      if (root) { A.call(parent, 'addChild', root); A.call(this.undo, 'recordCreateNode', A.uuid(root)); }
      for (const node of mapping.values()) for (const c of this.inspector.components(node)) {
        if (this.inspector.type(c) === 'cc.Layout') A.call(c, 'updateLayout');
        if (this.inspector.type(c) === 'cc.Widget') A.call(c, 'updateAlignment');
      }
      A.call(this.undo, 'commit');
      return { rootId: A.uuid(root ?? mapping.get(rows[0]!.key)), rows: rows.map(row => ({ key: row.key, nodeId: A.uuid(mapping.get(row.key)) })), needsSave: true, undoScope: 'editor-native-history' };
    } catch (error) {
      if (root) { A.call(root, 'removeFromParent'); A.call(root, 'destroy'); }
      else for (const change of changes.reverse()) this.assign(change.target, change.type, change.key, change.before);
      A.call(this.undo, 'cancel'); throw error;
    }
  }
}
