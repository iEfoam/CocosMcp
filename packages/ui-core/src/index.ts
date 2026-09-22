import { Ajv } from 'ajv';
import { CocosError, type JsonObject, type JsonSchema } from '../../contracts/src/index.js';
import { Schema as S } from '../../capability-catalog/src/schema.js';

export interface UiComponent { type: string; properties?: JsonObject }
export interface UiNode { key: string; name: string; position?: { x: number; y: number; z: number }; components?: UiComponent[]; children?: UiNode[] }
export interface UiDocument { version: 1; root: UiNode }
export interface UiRow { key: string; parentKey: string | null; node: UiNode }

/** 白名单限制持久化编辑范围；节点引用只能指向本批逻辑 key，资源使用 AssetDB UUID。 */
export class UiDocumentModel {
  static readonly ref = S.object({ nodeKey: S.string() }, ['nodeKey']);
  static readonly componentRef = (type: string): JsonSchema => S.object({ nodeKey: S.string(), componentType: { const: type } }, ['nodeKey', 'componentType']);
  static readonly events: JsonSchema = { type: 'array', maxItems: 8, items: S.object({ componentId: S.string(), handler: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9]{0,63}$' }, customEventData: { type: 'string', maxLength: 1024 } }, ['componentId', 'handler']) };
  static readonly eventProperties = new Set(['clickEvents', 'checkEvents', 'pageEvents', 'editingDidBegan', 'textChanged', 'editingDidEnded', 'editingReturn']);
  static readonly asset = S.object({ assetUuid: S.string() }, ['assetUuid']);
  static readonly number = { type: 'number', minimum: -100000, maximum: 100000 };
  static readonly positive = { type: 'number', minimum: 0, maximum: 100000 };
  static readonly size = S.object({ width: this.positive, height: this.positive }, ['width', 'height']);
  static readonly componentProperties: Record<string, Record<string, JsonSchema>> = {
    'cc.SafeArea': {},
    'cc.BlockInputEvents': {},
    'cc.UIOpacity': { opacity: { type: 'number', minimum: 0, maximum: 255 } },
    'cc.UITransform': { contentSize: this.size, anchorPoint: S.object({ x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, ['x', 'y']) },
    'cc.Canvas': { alignCanvasWithScreen: S.boolean() },
    'cc.Sprite': { spriteFrame: this.asset, sizeMode: { type: 'integer', enum: [0, 1, 2] }, type: { type: 'integer', enum: [0, 1, 2, 3] } },
    'cc.Label': { string: { type: 'string', maxLength: 10000 }, fontSize: this.positive, lineHeight: this.positive, font: this.asset, useSystemFont: S.boolean(), overflow: { type: 'integer', enum: [0, 1, 2, 3] }, enableWrapText: S.boolean() },
    'cc.Button': { interactable: S.boolean(), transition: { type: 'integer', enum: [0, 1, 2, 3] }, target: this.ref,
      clickEvents: this.events },
    'cc.Layout': { type: { type: 'integer', enum: [0, 1, 2, 3] }, resizeMode: { type: 'integer', enum: [0, 1, 2] }, spacingX: this.number, spacingY: this.number, paddingLeft: this.positive, paddingRight: this.positive, paddingTop: this.positive, paddingBottom: this.positive, cellSize: this.size },
    'cc.Widget': { isAlignTop: S.boolean(), isAlignBottom: S.boolean(), isAlignLeft: S.boolean(), isAlignRight: S.boolean(), isAlignHorizontalCenter: S.boolean(), isAlignVerticalCenter: S.boolean(), top: this.number, bottom: this.number, left: this.number, right: this.number, horizontalCenter: this.number, verticalCenter: this.number, alignMode: { type: 'integer', enum: [0, 1, 2] } },
    'cc.ScrollView': { content: this.ref, horizontal: S.boolean(), vertical: S.boolean(), elastic: S.boolean(), inertia: S.boolean(), brake: { type: 'number', minimum: 0, maximum: 1 } },
    'cc.Toggle': { interactable: S.boolean(), checkMark: this.componentRef('cc.Sprite'), checkEvents: this.events },
    'cc.EditBox': { string: { type: 'string', maxLength: 10000 }, placeholder: { type: 'string', maxLength: 1000 }, textLabel: this.componentRef('cc.Label'), placeholderLabel: this.componentRef('cc.Label'), backgroundImage: this.asset, maxLength: { type: 'integer', minimum: 0, maximum: 10000 }, tabIndex: { type: 'integer', minimum: 0, maximum: 1000 }, editingDidBegan: this.events, textChanged: this.events, editingDidEnded: this.events, editingReturn: this.events },
    'cc.PageView': { content: this.ref, direction: { type: 'integer', enum: [0, 1] }, sizeMode: { type: 'integer', enum: [0, 1] }, scrollThreshold: { type: 'number', minimum: 0, maximum: 1 }, pageTurningSpeed: { type: 'number', minimum: 0, maximum: 60 }, pageEvents: this.events },
    'cc.RichText': { string: { type: 'string', maxLength: 10000 }, fontSize: this.positive, lineHeight: this.positive, maxWidth: this.positive, useSystemFont: S.boolean(), font: this.asset },
    'cc.Mask': { type: { type: 'integer', enum: [0, 1, 2, 3] }, inverted: S.boolean() },
  };
  static readonly schema: JsonSchema = {
    ...S.object({ version: { const: 1 }, root: { $ref: '#/$defs/node' } }, ['version', 'root']),
    $defs: { node: S.object({ key: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' }, name: { type: 'string', minLength: 1, maxLength: 128 },
      position: S.object({ x: this.number, y: this.number, z: this.number }, ['x', 'y', 'z']),
      components: { type: 'array', maxItems: 13, items: { oneOf: Object.entries(this.componentProperties).map(([type, properties]) => S.object({ type: { const: type }, properties: S.object(properties) }, ['type'])) } },
      children: { type: 'array', maxItems: 200, items: { $ref: '#/$defs/node' } },
    }, ['key', 'name']) },
  };
  private readonly validate = new Ajv({ strict: false, allErrors: true }).compile(UiDocumentModel.schema);
  parse(value: unknown): UiRow[] {
    // 先限制序列化体积；深度检查先于递归 Schema，避免恶意树耗尽栈。
    let bytes: string;
    try { bytes = JSON.stringify(value); } catch { throw new CocosError('INVALID_ARGUMENT', 'UI document must be JSON'); }
    if (!bytes || bytes.length > 200000) throw new CocosError('INVALID_ARGUMENT', 'UI document exceeds 200000 characters');
    const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    while (pending.length) { const row = pending.pop()!; if (row.depth > 40) throw new CocosError('INVALID_ARGUMENT', 'UI document nesting is too deep');
      if (row.value && typeof row.value === 'object') for (const child of Object.values(row.value)) pending.push({ value: child, depth: row.depth + 1 }); }
    if (!this.validate(value)) throw new CocosError('INVALID_ARGUMENT', 'Invalid UI document', { errors: JSON.stringify(this.validate.errors) });
    const document = value as UiDocument, rows: UiRow[] = [], keys = new Set<string>();
    const visit = (node: UiNode, parentKey: string | null, depth: number): void => {
      if (depth > 16 || rows.length >= 200) throw new CocosError('INVALID_ARGUMENT', 'UI tree is limited to 200 nodes and 16 levels');
      if (keys.has(node.key)) throw new CocosError('INVALID_ARGUMENT', `Duplicate UI key: ${node.key}`);
      keys.add(node.key); rows.push({ key: node.key, parentKey, node });
      const types = (node.components ?? []).map(c => c.type);
      if (new Set(types).size !== types.length) throw new CocosError('INVALID_ARGUMENT', `Duplicate component on ${node.key}`);
      if (types.filter(type => ['cc.Sprite', 'cc.Label', 'cc.RichText'].includes(type)).length > 1) throw new CocosError('INVALID_ARGUMENT', 'UI renderers require separate nodes');
      if (types.includes('cc.Button') && types.includes('cc.Toggle') || types.includes('cc.ScrollView') && types.includes('cc.PageView')) throw new CocosError('INVALID_ARGUMENT', 'Do not combine a component with its subclass on the same node');
      if (types.includes('cc.Canvas') && parentKey !== null) throw new CocosError('INVALID_ARGUMENT', 'Canvas must be the document root');
      for (const child of node.children ?? []) visit(child, node.key, depth + 1);
    };
    visit(document.root, null, 1);
    for (const row of rows) for (const component of row.node.components ?? []) for (const [property, value] of Object.entries(component.properties ?? {})) {
      if (component.type === 'cc.RichText' && property === 'string' && /\bclick\s*=|<on\b/i.test(String(value))) throw new CocosError('INVALID_ARGUMENT', 'RichText inline callbacks are not supported; use explicit event bindings');
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.nodeKey === 'string') {
        if (value.componentType && !rows.find(r => r.key === value.nodeKey)?.node.components?.some(c => c.type === value.componentType)) throw new CocosError('INVALID_ARGUMENT', `Referenced UI component is absent: ${value.nodeKey}.${value.componentType}`);
        if (!keys.has(value.nodeKey)) throw new CocosError('INVALID_ARGUMENT', `Unknown UI reference: ${value.nodeKey}`);
        if (['cc.ScrollView', 'cc.PageView'].includes(component.type) && property === 'content') {
          let cursor = rows.find(r => r.key === value.nodeKey);
          while (cursor && cursor.parentKey !== row.key) cursor = rows.find(r => r.key === cursor!.parentKey);
          if (!cursor) throw new CocosError('INVALID_ARGUMENT', 'ScrollView content must be a descendant');
        }
      }
    }
    return rows;
  }
}
