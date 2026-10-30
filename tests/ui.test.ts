import assert from 'node:assert/strict';
import test from 'node:test';
import { Json, type JsonObject, type JsonValue } from '../packages/contracts/src/index.js';
import { UiDocumentModel } from '../packages/ui-core/src/index.js';
import { UiService } from '../packages/creator3-adapter/src/ui.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { OutputContracts } from '../packages/capability-catalog/src/output-contracts.js';

class UiHarness {
  readonly document: JsonObject = { version: 1, root: { key: 'panel', name: 'Panel', components: [{ type: 'cc.UITransform', properties: { contentSize: { width: 400, height: 300 } } }], children: [
    { key: 'scroll', name: 'Scroll', components: [{ type: 'cc.ScrollView', properties: { content: { nodeKey: 'content' } } }], children: [{ key: 'content', name: 'Content', components: [{ type: 'cc.Label', properties: { string: 'Hello' } }] }] },
  ] } };
  nodes: JsonObject[] = []; writes = 0; revision = 'initial'; fail = false; mutateOnFailure = false; simulateWidgetResize = false;
  port = {
    version: '3.8.8',
    scene: async (method: string, ...args: unknown[]): Promise<unknown> => {
      const p = Json.object(args[0] ?? {});
      if (method === 'fingerprint') return { revision: this.revision, nodes: this.nodes };
      if (method === 'ui.preflight') return { valid: true };
      if (method === 'ui.flush_label') return { flushed: true };
      if (method === 'ui.snapshot') return this.nodes;
      if (method === 'ui.inspect_layout') return { rows: [] };
      if (method === 'ui.validate_interaction') return { rows: [], runtimeClickVerified: false };
      if (method === 'hierarchy') return { rows: this.nodes.filter(n => n.nodeId === p.rootId) };
      throw new Error(method);
    },
  } as EditorPort;
  service = new UiService(this.port, async (id, p) => {
    this.writes++;
    if (id === 'node.create') {
      const nodeId = `node-${this.nodes.length}`; this.nodes.push({ nodeId, name: p.name!, components: [] }); return { nodeId };
    }
    if (id === 'node.set') return {};
    if (id === 'component.add') {
      const node = this.nodes.find(n => n.nodeId === p.nodeId)!;
      (node.components as JsonObject[]).push({ componentId: `${p.nodeId}:${p.type}`, type: p.type!, properties: {} }); return {};
    }
    if (id === 'component.set') {
      if (this.fail) { if (this.mutateOnFailure) this.nodes.push({ nodeId: 'external-child', name: 'User content' }); throw new Error('Injected failure'); }
      const component = this.nodes.flatMap(n => n.components as JsonObject[]).find(c => c.componentId === p.componentId)!;
      if (this.simulateWidgetResize && component.type === 'cc.UITransform') {
        const node = this.nodes.find(n => (n.components as JsonObject[]).includes(component))!;
        const widget = (node.components as JsonObject[]).find(c => c.type === 'cc.Widget');
        // 模拟 Creator 编辑态在尺寸改变后按原位置反算边距，捕获先启用 Widget 再写尺寸的回归。
        if (widget && Json.object(widget.properties).isAlignTop) Json.object(widget.properties).top = -0.098;
      }
      component.properties = p.properties!; return {};
    }
    if (id === 'node.delete') { this.nodes = []; return {}; }
    throw new Error(id);
  });
  params(): JsonObject { return { parentId: 'parent', document: this.document }; }
  async build(): Promise<JsonValue> {
    const p = this.params(), contracts = new OutputContracts(), plan = await this.service.plan(p);
    contracts.validate('ui.plan', plan);
    const result = await this.service.execute('ui.build', { ...p, planHash: plan.planHash! });
    contracts.validate('ui.build', result); return result;
  }
}

test('UI build sets explicit dimensions before enabling Widget alignment', async () => {
  const h = new UiHarness(); h.simulateWidgetResize = true;
  h.document.root = { key: 'panel', name: 'Panel', components: [
    { type: 'cc.UITransform', properties: { contentSize: { width: 260, height: 90 } } },
    { type: 'cc.Label', properties: { string: 'Before', fontSize: 36, overflow: 1 } },
    { type: 'cc.Widget', properties: { isAlignTop: true, isAbsoluteTop: false, top: 0.1, isAlignLeft: true, isAbsoluteLeft: true, left: 24 } },
  ] };
  await h.build();
  const widget = (h.nodes[0]!.components as JsonObject[]).find(c => c.type === 'cc.Widget')!;
  assert.equal(Json.object(widget.properties).top, 0.1);
  assert.equal(Json.object(widget.properties).left, 24);
});

test('UI document rejects duplicate keys, unsafe properties, invalid references and excessive depth', () => {
  const model = new UiDocumentModel(), h = new UiHarness();
  assert.equal(model.parse(h.document).length, 3);
  const root = Json.object(h.document.root);
  assert.throws(() => model.parse({ version: 1, root: { ...root, children: [root] } }), /Duplicate/);
  assert.throws(() => model.parse({ version: 1, root: { key: 'x', name: 'x', components: [{ type: 'cc.Button', properties: { constructor: 'escape' } }] } }), /Invalid UI/);
  assert.throws(() => model.parse({ version: 1, root: { key: 'x', name: 'x', components: [{ type: 'cc.ScrollView', properties: { content: { nodeKey: 'x' } } }] } }), /descendant/);
  let deep: JsonObject = { key: 'leaf', name: 'Leaf' }; for (let i = 0; i < 18; i++) deep = { key: `n${i}`, name: 'Deep', children: [deep] };
  assert.throws(() => model.parse({ version: 1, root: deep }), /levels|deep/);
});

test('UI schemas validate recursive documents and Creator 3 build requires a reviewed plan', async () => {
  const h = new UiHarness(), catalog = new CapabilityCatalog();
  catalog.validate('ui.plan', h.params());
  assert.throws(() => catalog.validate('ui.build', h.params()), /planHash/);
  assert.deepEqual(catalog.describe('ui.build').supportedMajors, [2, 3]);
  await assert.rejects(() => h.service.execute('ui.build', { ...h.params(), planHash: 'old' }), /plan changed/);
  assert.equal(h.writes, 0);
  const plan = await h.service.plan(h.params()); h.revision = 'user-change';
  await assert.rejects(() => h.service.execute('ui.build', { ...h.params(), planHash: plan.planHash! }), /plan changed/);
  assert.equal(h.writes, 0);
});

test('UI build returns stable key mappings, one transform per node and resolves forward references', async () => {
  const h = new UiHarness(), result = Json.object(await h.build());
  assert.equal(result.needsSave, true); assert.equal((result.rows as JsonValue[]).length, 3);
  for (const node of h.nodes) assert.equal((node.components as JsonObject[]).filter(c => c.type === 'cc.UITransform').length, 1);
  const scroll = (h.nodes[1]!.components as JsonObject[]).find(c => c.type === 'cc.ScrollView')!;
  assert.deepEqual(Json.object(scroll.properties).content, { uuid: 'node-2' });
});

test('UI failure compensates only an unchanged owned subtree and preserves uncertain external changes', async () => {
  const clean = new UiHarness(); clean.fail = true;
  await assert.rejects(() => clean.build(), error => { assert.equal(Json.object(Json.object(error).details).rootId, 'node-0'); return true; });
  assert.equal(clean.nodes.length, 0);
  const changed = new UiHarness(); changed.fail = true; changed.mutateOnFailure = true;
  await assert.rejects(() => changed.build(), /UI build failed/);
  assert.ok(changed.nodes.some(n => n.nodeId === 'external-child'));
  assert.equal(changed.nodes.length, 4);
});

test('UI read tools route without writes and reject unadapted Creator versions', async () => {
  const h = new UiHarness(); assert.deepEqual(await h.service.execute('ui.inspect_layout', { rootId: 'x' }), { rows: [] });
  assert.equal(Json.object(await h.service.execute('ui.validate_interaction', { rootId: 'x' })).runtimeClickVerified, false);
  h.port.version = '3.7.0'; await assert.rejects(() => h.service.execute('ui.plan', h.params()), /3.8.8/); assert.equal(h.writes, 0);
});

test('UI colors and layout values are bounded before creation, including invalid alpha and enum values', () => {
  const catalog = new CapabilityCatalog();
  const validate = (type: string, properties: JsonObject): void => { catalog.validate('ui.plan', { parentId: 'canvas', document: { version: 1, root: { key: 'r', name: 'Panel', components: [{ type, properties }] } } }); };
  for (const color of [{ r: -1, g: 0, b: 0, a: 255 }, { r: 0, g: 256, b: 0, a: 255 }, { r: 1.5, g: 0, b: 0, a: 255 }, { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0, a: 256 }]) {
    assert.throws(() => validate('cc.Label', { color }), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(() => validate('cc.Label', { horizontalAlign: 3 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => validate('cc.Layout', { startAxis: 2 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => validate('cc.Widget', { isAbsoluteTop: 'false' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => validate('cc.RichText', { color: { r: 0, g: 0, b: 0, a: 255 } }), { code: 'INVALID_ARGUMENT' });
  validate('cc.Label', { color: { r: 0, g: 128, b: 255, a: 0 }, horizontalAlign: 2, verticalAlign: 1, spacingX: -2 });
});

test('UI build preserves RGBA, alignment and layout settings and writes Widget units before offsets', async () => {
  const h = new UiHarness(), color = { r: 10, g: 20, b: 30, a: 128 };
  Json.object(h.document.root).children = [];
  Json.object(h.document.root).components = [
    { type: 'cc.Label', properties: { color, horizontalAlign: 1, verticalAlign: 2, spacingX: 2 } },
    { type: 'cc.Button', properties: { transition: 1, normalColor: color, hoverColor: color, pressedColor: color, disabledColor: color, duration: 0.2, zoomScale: 1.1 } },
    { type: 'cc.Layout', properties: { startAxis: 1, horizontalDirection: 1, verticalDirection: 0, affectedByScale: true } },
    { type: 'cc.Widget', properties: { top: 0.1, isAbsoluteTop: false, isAlignTop: true } },
  ];
  await h.build();
  const components = h.nodes[0]!.components as JsonObject[];
  assert.deepEqual(Json.object(components.find(c => c.type === 'cc.Label')!.properties).color, color);
  assert.equal(Json.object(components.find(c => c.type === 'cc.Label')!.properties).horizontalAlign, 1);
  assert.deepEqual(Json.object(components.find(c => c.type === 'cc.Button')!.properties).pressedColor, color);
  assert.equal(Json.object(components.find(c => c.type === 'cc.Layout')!.properties).startAxis, 1);
  const widget = Json.object(components.find(c => c.type === 'cc.Widget')!.properties);
  assert.ok(Object.keys(widget).indexOf('isAlignTop') < Object.keys(widget).indexOf('isAbsoluteTop'));
  assert.ok(Object.keys(widget).indexOf('isAbsoluteTop') < Object.keys(widget).indexOf('top'));
  assert.equal(widget.top, 0.1);
});
