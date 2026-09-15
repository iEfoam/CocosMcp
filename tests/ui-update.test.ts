import assert from 'node:assert/strict';
import test from 'node:test';
import { UiUpdateService } from '../packages/creator3-adapter/src/ui-update.js';
import { UiDocumentModel } from '../packages/ui-core/src/index.js';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';

class UpdateHarness {
  name = 'Before'; text = 'Original'; extra = false; writes = 0; failAt = 0; foreignChange = false;
  document: JsonObject = { version: 1, root: { key: 'root', name: 'After', components: [{ type: 'cc.Label', properties: { string: 'Updated' } }] } };
  params(): JsonObject { return { rootId: 'r', mapping: [{ key: 'root', nodeId: 'r' }], document: this.document }; }
  snapshot(): JsonObject { return { name: this.name, text: this.text, extra: this.extra }; }
  readonly port = { version: '3.8.8', scene: async (method: string) => {
    if (method === 'ui.flush_label') return { flushed: true };
      if (method === 'fingerprint' || method === 'ui.snapshot') return this.snapshot();
    if (method === 'ui.preflight_update') return { valid: true };
    if (method === 'hierarchy') return { total: 1, rows: [{ nodeId: 'r', parentId: 'canvas', name: this.name, components: [{ componentId: 'label', type: 'cc.Label' }, { componentId: 'user', type: 'ProjectScript' }] }] };
    throw new Error(method);
  }, request: async (_channel: string, method: string) => {
    if (method === 'query-node') return { name: { type: 'String', value: this.name } };
    if (method === 'query-component') return { string: { type: 'String', value: this.text } };
    throw new Error(method);
  } } as EditorPort;
  service = new UiUpdateService(this.port, async (id, p) => {
    this.writes++;
    if (this.writes === this.failAt) { if (this.foreignChange) this.extra = true; throw new Error('Injected setter failure'); }
    const properties = Json.object(p.properties);
    if (id === 'node.set') this.name = String(properties.name);
    else if (id === 'component.set') this.text = String(properties.string);
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
