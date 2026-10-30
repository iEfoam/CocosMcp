import assert from 'node:assert/strict';
import test from 'node:test';
import { UiUpdateService } from '../packages/creator3-adapter/src/ui-update.js';
import { UiDocumentModel } from '../packages/ui-core/src/index.js';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';

class UpdateHarness {
  name = 'Before'; text = 'Original'; extra = false; writes = 0; failAt = 0; foreignChange = false;
  color: JsonObject = { r: 255, g: 255, b: 255, a: 255 }; horizontalAlign = 0; verticalAlign = 0;
  document: JsonObject = { version: 1, root: { key: 'root', name: 'After', components: [{ type: 'cc.Label', properties: { string: 'Updated' } }] } };
  params(): JsonObject { return { rootId: 'r', mapping: [{ key: 'root', nodeId: 'r' }], document: this.document }; }
  snapshot(): JsonObject { return { name: this.name, text: this.text, extra: this.extra, color: this.color, horizontalAlign: this.horizontalAlign, verticalAlign: this.verticalAlign }; }
  readonly port = { version: '3.8.8', scene: async (method: string) => {
    if (method === 'ui.flush_label') return { flushed: true };
      if (method === 'fingerprint' || method === 'ui.snapshot') return this.snapshot();
    if (method === 'ui.preflight_update') return { valid: true };
    if (method === 'hierarchy') return { total: 1, rows: [{ nodeId: 'r', parentId: 'canvas', name: this.name, components: [{ componentId: 'label', type: 'cc.Label' }, { componentId: 'user', type: 'ProjectScript' }] }] };
    throw new Error(method);
  }, request: async (_channel: string, method: string) => {
    if (method === 'query-node') return { name: { type: 'String', value: this.name } };
    if (method === 'query-component') return { string: { type: 'String', value: this.text }, color: { type: 'cc.Color', value: this.color }, horizontalAlign: { type: 'Enum', value: this.horizontalAlign }, verticalAlign: { type: 'Enum', value: this.verticalAlign } };
    throw new Error(method);
  } } as EditorPort;
  service = new UiUpdateService(this.port, async (id, p) => {
    this.writes++;
    if (this.writes === this.failAt) { if (this.foreignChange) this.extra = true; throw new Error('Injected setter failure'); }
    const properties = Json.object(p.properties);
    if (id === 'node.set') this.name = String(properties.name);
    else if (id === 'component.set') {
      if ('string' in properties) this.text = String(properties.string);
      if ('color' in properties) this.color = Json.object(properties.color);
      if ('horizontalAlign' in properties) this.horizontalAlign = Number(properties.horizontalAlign);
      if ('verticalAlign' in properties) this.verticalAlign = Number(properties.verticalAlign);
    }
    else throw new Error(`Unexpected structural operation: ${id}`);
    return {};
  });
  async apply(): Promise<JsonObject> { const plan = await this.service.diff(this.params()); return Json.object(await this.service.apply({ ...this.params(), planHash: plan.planHash! })); }
}

test('UI diff and apply preserve UUIDs and undeclared components without structural operations', async () => {
  const h = new UpdateHarness(), catalog = new CapabilityCatalog(); catalog.validate('ui.diff', h.params());
  const plan = await h.service.diff(h.params()); assert.equal(h.writes, 0); assert.equal((plan.rows as JsonObject[]).length, 2);
  const result = await h.apply(); assert.equal(h.writes, 2); assert.equal(h.name, 'After'); assert.equal(h.text, 'Updated');
  assert.deepEqual(result.mapping, [{ key: 'root', nodeId: 'r' }]);
  const repeat = await h.apply(); assert.equal(repeat.changed, false); assert.equal(h.writes, 2);
});

test('UI RGBA and alignment updates preserve mappings, repeat as no-op and restore on a later failure', async () => {
  const h = new UpdateHarness(), original = h.snapshot(), color = { r: 10, g: 20, b: 30, a: 128 };
  h.document = { version: 1, root: { key: 'root', name: 'Before', components: [{ type: 'cc.Label', properties: { color, horizontalAlign: 1, verticalAlign: 2 } }] } };
  h.failAt = 3;
  await assert.rejects(h.apply(), /UI update failed/);
  assert.deepEqual(h.snapshot(), original);
  h.failAt = 0;
  const result = await h.apply(); assert.deepEqual(result.mapping, [{ key: 'root', nodeId: 'r' }]);
  assert.deepEqual(h.color, color); assert.equal(h.horizontalAlign, 1); assert.equal(h.verticalAlign, 2);
  assert.equal((await h.apply()).changed, false);
});

class WidgetUpdateHarness {
  absolute = true; aligned = false; top = 0.1; left = 5; failLeft = false;
  document: JsonObject = { version: 1, root: { key: 'root', name: 'Panel', components: [{ type: 'cc.Widget', properties: { top: 0.1, isAbsoluteTop: false, left: 10, isAlignTop: true } }] } };
  snapshot(): JsonObject { return { absolute: this.absolute, aligned: this.aligned, top: this.top, left: this.left }; }
  readonly port = { version: '3.8.8', scene: async (method: string) => {
    if (method === 'ui.flush_label' || method === 'ui.preflight_update') return {};
    if (method === 'fingerprint' || method === 'ui.snapshot') return this.snapshot();
    if (method === 'hierarchy') return { total: 1, rows: [{ nodeId: 'r', parentId: 'canvas', components: [{ componentId: 'w', type: 'cc.Widget' }] }] };
    throw new Error(method);
  }, request: async (_channel: string, method: string) => {
    if (method === 'query-node') return { name: { type: 'String', value: 'Panel' } };
    return { isAlignTop: { type: 'Boolean', value: this.aligned }, isAbsoluteTop: { type: 'Boolean', value: this.absolute }, top: { type: 'Number', value: this.top }, left: { type: 'Number', value: this.left } };
  } } as EditorPort;
  service = new UiUpdateService(this.port, async (id, p) => {
    assert.equal(id, 'component.set');
    for (const [key, value] of Object.entries(Json.object(p.properties))) {
      if (key === 'isAlignTop') { if (value !== this.aligned) this.top = 40; this.aligned = Boolean(value); }
      if (key === 'isAbsoluteTop') { if (value !== this.absolute) this.top *= value ? 100 : 0.01; this.absolute = Boolean(value); }
      if (key === 'top') this.top = Number(value);
      if (key === 'left') { if (this.failLeft) throw new Error('Injected failure'); this.left = Number(value); }
    }
    return {};
  });
  async apply(): Promise<JsonObject> {
    const p = { rootId: 'r', mapping: [{ key: 'root', nodeId: 'r' }], document: this.document };
    return Json.object(await this.service.apply({ ...p, planHash: (await this.service.diff(p)).planHash! }));
  }
}

test('Widget unit changes rewrite numerically unchanged offsets and compensate in native setter order', async () => {
  const h = new WidgetUpdateHarness(), before = h.snapshot(); h.failLeft = true;
  await assert.rejects(h.apply(), /UI update failed/); assert.deepEqual(h.snapshot(), before);
  h.failLeft = false; await h.apply();
  assert.equal(h.aligned, true); assert.equal(h.absolute, false); assert.equal(h.top, 0.1); assert.equal(h.left, 10);
  assert.equal((await h.apply()).changed, false);
  const undeclared = new WidgetUpdateHarness();
  delete Json.object((Json.object(undeclared.document.root).components as JsonObject[])[0]!.properties).top;
  await undeclared.apply(); assert.equal(undeclared.top, 0.1);
});

test('UI update rejects stale plans, duplicate UUID mappings and unsupported component structure before writes', async () => {
  const h = new UpdateHarness(), plan = await h.service.diff(h.params()); h.text = 'User edit';
  await assert.rejects(() => h.service.apply({ ...h.params(), planHash: plan.planHash! }), /diff changed/); assert.equal(h.writes, 0);
  await assert.rejects(() => h.service.diff({ ...h.params(), mapping: [{ key: 'root', nodeId: 'outside' }] }), /root and keys/);
  Json.object(h.document.root).components = [{ type: 'cc.Button', properties: { interactable: false } }];
  const blocked = await h.service.diff(h.params()); assert.equal(blocked.applicable, false);
  await assert.rejects(() => h.service.apply({ ...h.params(), planHash: blocked.planHash! }), /structural changes/); assert.equal(h.writes, 0);
});

test('UI partial update restores confirmed properties only when the subtree has not changed externally', async () => {
  const clean = new UpdateHarness(); clean.failAt = 2; await assert.rejects(() => clean.apply(), /UI update failed/);
  assert.equal(clean.name, 'Before'); assert.equal(clean.text, 'Original');
  const changed = new UpdateHarness(); changed.failAt = 2; changed.foreignChange = true; await assert.rejects(() => changed.apply(), /UI update failed/);
  assert.equal(changed.name, 'After'); assert.equal(changed.extra, true); assert.equal(changed.writes, 2);
});

test('expanded UI documents validate component references and reject inherited duplicates and inline script callbacks', () => {
  const model = new UiDocumentModel();
  const root = { key: 'root', name: 'Edit', components: [{ type: 'cc.EditBox', properties: { textLabel: { nodeKey: 'text', componentType: 'cc.Label' }, placeholder: 'Name' } }], children: [{ key: 'text', name: 'Text', components: [{ type: 'cc.Label' }] }] };
  assert.equal(model.parse({ version: 1, root }).length, 2);
  assert.throws(() => model.parse({ version: 1, root: { ...root, children: [] } }), /component is absent/);
  assert.throws(() => model.parse({ version: 1, root: { key: 'r', name: 'R', components: [{ type: 'cc.Toggle' }, { type: 'cc.Button' }] } }), /subclass/);
  assert.throws(() => model.parse({ version: 1, root: { key: 'r', name: 'R', components: [{ type: 'cc.RichText', properties: { string: '<on click="launch">Go</on>' } }] } }), /inline callbacks/);
  for (const type of ['cc.Toggle', 'cc.PageView', 'cc.RichText']) assert.equal(model.parse({ version: 1, root: { key: 'r', name: 'R', components: [{ type }] } }).length, 1);
});
