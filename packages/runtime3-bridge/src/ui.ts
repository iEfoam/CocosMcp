import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { UiDocumentModel } from '../../ui-core/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import type { SceneInspector } from './scene.js';

/** 只读取真实场景，布局检查不强行刷新 Widget/Layout 或执行任何项目回调。 */
export class UiInspector {
  constructor(private readonly inspector: SceneInspector) {}
  private get cc(): RuntimeObject { return this.inspector.environment.cc; }
  preflight(p: JsonObject, update = false): JsonValue {
    const rows = new UiDocumentModel().parse(p.document);
    const root = update ? this.inspector.node(Json.string(p.rootId, 'rootId')) : null;
    const parent = root ? A.object(root.parent) : this.inspector.node(Json.string(p.parentId, 'parentId'));
    if (!update && (parent.children as RuntimeObject[]).some(node => node.name === rows[0]!.node.name)) throw new CocosError('RESOURCE_BUSY', 'UI root name already exists under this parent');
    for (const row of rows) for (const spec of [{ type: 'cc.UITransform', properties: {} }, ...(row.node.components ?? [])]) {
      const type = this.cc[spec.type.slice(3)];
      if (typeof type !== 'function') throw new CocosError('UNSUPPORTED_CAPABILITY', `Creator module unavailable: ${spec.type}`);
      const constructor = A.object(type), prototype = A.object(constructor.prototype), props = constructor.__props__ as string[] ?? [];
      for (const key of Object.keys(spec.properties ?? {})) if (!(key in prototype) && !props.includes(key)) throw new CocosError('UNSUPPORTED_CAPABILITY', `Native UI property unavailable: ${spec.type}.${key}`);
      for (const key of UiDocumentModel.eventProperties) if (spec.properties?.[key]) this.eventBindings({ events: spec.properties[key]! });
    }
    if (update) for (const row of rows) {
      const mapping = (p.mapping as JsonObject[]).find(value => value.key === row.key);
      if (!mapping) throw new CocosError('INVALID_ARGUMENT', 'Missing UI mapping');
      const node = this.inspector.node(String(mapping.nodeId));
      if (node.parent && (A.object(node.parent).children as RuntimeObject[]).some(sibling => sibling !== node && sibling.name === row.node.name)) throw new CocosError('RESOURCE_BUSY', `UI name conflicts with a sibling: ${row.node.name}`);
    }
    return { valid: true, parentId: A.uuid(parent), nodeCount: rows.length };
  }
  eventBindings(p: JsonObject): JsonValue {
    if (!Array.isArray(p.events) || p.events.length > 8) throw new CocosError('INVALID_ARGUMENT', 'At most eight UI event bindings are allowed');
    return p.events.map(value => {
      const event = Json.object(value), component = this.inspector.component(Json.string(event.componentId, 'componentId'));
      // EventHandler 保存的是节点 + 组件类型，不是组件 UUID；同节点同类型多实例会失去精确指向。
      const siblings = this.inspector.components(A.object(component.node)).filter(candidate => this.inspector.type(candidate) === this.inspector.type(component));
      if (siblings.length !== 1) throw new CocosError('AMBIGUOUS_TARGET', 'UI event target must have exactly one component of its type on the node');
      const handler = Json.string(event.handler, 'handler');
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(handler) || ['constructor', 'destroy', 'destroyImmediate'].includes(handler) || typeof component[handler] !== 'function') throw new CocosError('INVALID_ARGUMENT', 'UI callback must name an existing public method');
      // 只持久化 EventHandler 公共字段，禁止在规划或检查时调用项目方法。
      return { target: { uuid: A.uuid(component.node) }, component: this.inspector.type(component), handler, customEventData: String(event.customEventData ?? '') };
    });
  }
  snapshot(p: JsonObject): JsonValue {
    const root = this.inspector.node(Json.string(p.rootId, 'rootId'));
    if (!this.inspector.environment.serialize) throw new CocosError('CONTEXT_UNAVAILABLE', 'Editor serializer is required for guarded UI builds');
    return Json.value(this.inspector.environment.serialize(root));
  }
  private transform(node: RuntimeObject): RuntimeObject | null {
    const result = A.call(node, 'getComponent', this.cc.UITransform); return result ? A.object(result) : null;
  }
  private nodes(p: JsonObject): RuntimeObject[] {
    const nodes = this.inspector.all(this.inspector.node(Json.string(p.rootId, 'rootId')));
    if (nodes.length > 1000) throw new CocosError('INVALID_ARGUMENT', 'Inspect a subtree of at most 1000 nodes');
    return nodes;
  }
  layout(p: JsonObject): JsonValue {
    const rows: JsonObject[] = [], diagnostics: JsonObject[] = [];
    for (const node of this.nodes(p)) {
      const transform = this.transform(node); if (!transform) continue;
      const size = A.object(transform.contentSize), anchor = A.object(transform.anchorPoint), width = Number(size.width), height = Number(size.height);
      const left = -Number(anchor.x) * width, bottom = -Number(anchor.y) * height;
      const corners = [[left, bottom], [left + width, bottom], [left + width, bottom + height], [left, bottom + height]].map(([x, y]) => A.object(A.call(transform, 'convertToWorldSpaceAR', A.construct(this.cc.Vec3, [x, y, 0]))));
      const nodeId = A.uuid(node), xs = corners.map(v => Number(v.x)), ys = corners.map(v => Number(v.y));
      if (width <= 0 || height <= 0) diagnostics.push({ code: 'ZERO_SIZE', nodeId });
      const parentTransform = node.parent ? this.transform(A.object(node.parent)) : null;
      if (parentTransform) {
        const parentSize = A.object(parentTransform.contentSize), parentAnchor = A.object(parentTransform.anchorPoint);
        const x = -Number(parentAnchor.x) * Number(parentSize.width), y = -Number(parentAnchor.y) * Number(parentSize.height);
        const local = corners.map(corner => A.object(A.call(parentTransform, 'convertToNodeSpaceAR', corner)));
        if (local.some(point => Number(point.x) < x - 0.01 || Number(point.y) < y - 0.01 || Number(point.x) > x + Number(parentSize.width) + 0.01 || Number(point.y) > y + Number(parentSize.height) + 0.01)) diagnostics.push({ code: 'OUTSIDE_PARENT', nodeId, severity: 'warning', message: '滚动内容或装饰可有意超出父边界，需结合用途审查' });
      }
      rows.push({ nodeId, name: String(node.name), activeInHierarchy: Boolean(node.activeInHierarchy), size: { width, height }, corners: corners.map(c => ({ x: Number(c.x), y: Number(c.y), z: Number(c.z) })), bounds: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } });
    }
    return { rows, diagnostics, scope: 'current-scene-geometry', limitations: ['未模拟多分辨率', '不判断相机、Mask、遮挡或像素可见性；布局尚未刷新时读到的是当前值'] };
  }
  private inspectEvents(component: RuntimeObject, property: string): JsonObject[] {
    const value = component[property];
    if (!Array.isArray(value)) return [];
    if (value.length > 128) throw new CocosError('INVALID_ARGUMENT', 'UI event list exceeds 128 bindings');
    return value.map(value => {
      if (!value || typeof value !== 'object') return { property, valid: false, reason: 'malformed-event' };
      const event = A.object(value), target = event.target, handler = String(event.handler ?? '');
      let type = String(event.component ?? ''), valid = false;
      try {
        if (event._componentId) {
          const resolved = A.call(this.cc.js, 'getClassById', event._componentId);
          type = resolved ? this.inspector.type(resolved) : '';
        }
        if (target && type && handler && !handler.startsWith('_') && !['constructor', 'destroy', 'destroyImmediate', 'prototype'].includes(handler)) {
          const script = A.call(target, 'getComponent', type);
          valid = Boolean(script && typeof A.object(script)[handler] === 'function' && A.object(script).isValid !== false && A.object(target).isValid !== false);
        }
      } catch { valid = false; }
      return { property, targetNodeId: target ? A.uuid(target) : null, component: type, handler, valid };
    });
  }
  interaction(p: JsonObject): JsonValue {
    const rows: JsonObject[] = [], diagnostics: JsonObject[] = [];
    const eventFields: Record<string, string[]> = { 'cc.Button': ['clickEvents'], 'cc.Toggle': ['checkEvents'], 'cc.PageView': ['pageEvents'], 'cc.EditBox': ['editingDidBegan', 'textChanged', 'editingDidEnded', 'editingReturn'] };
    for (const node of this.nodes(p)) for (const component of this.inspector.components(node)) {
      const type = this.inspector.type(component), nodeId = A.uuid(node), componentId = A.uuid(component);
      const fields = eventFields[type];
      if (fields) {
        const events = fields.flatMap(property => this.inspectEvents(component, property));
        if (!events.length && type === 'cc.Button') diagnostics.push({ code: 'NO_PERSISTED_CLICK_HANDLER', nodeId, componentId, message: '运行时脚本可能另行注册监听，本检查无法证明按钮无行为' });
        for (const event of events) if (!event.valid) diagnostics.push({ code: type === 'cc.Button' ? 'INVALID_CLICK_HANDLER' : 'INVALID_UI_EVENT_HANDLER', nodeId, componentId, property: event.property! });
        rows.push({ nodeId, componentId, type, enabled: Boolean(component.enabledInHierarchy), interactable: typeof component.interactable === 'boolean' ? component.interactable : null, events });
      }
      if (type === 'cc.EditBox') {
        for (const property of ['textLabel', 'placeholderLabel']) {
          const label = component[property];
          if (label && (typeof this.cc.Label !== 'function' || !(label instanceof this.cc.Label) || A.object(label).isValid === false)) diagnostics.push({ code: 'INVALID_EDITBOX_LABEL', nodeId, componentId, property });
        }
        if (!component.textLabel) diagnostics.push({ code: 'MISSING_EDITBOX_TEXT_LABEL', nodeId, componentId });
      }
      if (type === 'cc.ScrollView' || type === 'cc.PageView') {
        const content = component.content;
        const valid = Boolean(content && this.inspector.all(node).includes(A.object(content)) && content !== node && A.object(content).isValid !== false);
        if (!valid) diagnostics.push({ code: 'INVALID_SCROLL_CONTENT', nodeId, componentId });
        const row: JsonObject = { nodeId, componentId, type, contentNodeId: content ? A.uuid(content) : null, contentValid: valid, horizontal: Boolean(component.horizontal), vertical: Boolean(component.vertical) };
        if (type === 'cc.PageView') {
          const pages = A.call(component, 'getPages');
          if (!Array.isArray(pages) || pages.length > 1000) throw new CocosError('INVALID_ARGUMENT', 'PageView must have a bounded native page list');
          row.pageNodeIds = pages.map(page => A.uuid(page));
          if (!pages.length) diagnostics.push({ code: 'EMPTY_PAGEVIEW', nodeId, componentId });
          const seen = new Set<unknown>();
          for (const page of pages) {
            if (!page || !content || A.object(page).parent !== content || A.object(page).isValid === false || seen.has(page)) diagnostics.push({ code: 'INVALID_PAGEVIEW_PAGE', nodeId, componentId, pageNodeId: page ? A.uuid(page) : null });
            seen.add(page);
          }
        }
        rows.push(row);
      }
      if (type === 'cc.RichText') {
        const inline = /\bclick\s*=|<on\b/i.test(String(component.string ?? ''));
        if (inline) diagnostics.push({ code: 'RICHTEXT_INLINE_EVENT_REQUIRES_REVIEW', nodeId, componentId, message: '已有富文本回调需要人工审查；静态检查不执行字符串中的事件' });
        rows.push({ nodeId, componentId, type, enabled: Boolean(component.enabledInHierarchy), hasInlineEvent: inline });
      }
    }
    return { rows, diagnostics, scope: 'static-interaction-configuration', runtimeClickVerified: false, limitations: ['不验证焦点、输入法、遮挡和真实回调', 'PageView 只读检查已有页面列表，不自动增删页面'] };
  }
}
