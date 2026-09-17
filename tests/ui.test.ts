import assert from 'node:assert/strict';
import test from 'node:test';
import { Json, type JsonObject, type JsonValue } from '../packages/contracts/src/index.js';
import { UiDocumentModel } from '../packages/ui-core/src/index.js';
import { UiService } from '../packages/creator3-adapter/src/ui.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';

class UiHarness {
  readonly document: JsonObject = { version: 1, root: { key: 'panel', name: 'Panel', components: [{ type: 'cc.UITransform', properties: { contentSize: { width: 400, height: 300 } } }], children: [
    { key: 'scroll', name: 'Scroll', components: [{ type: 'cc.ScrollView', properties: { content: { nodeKey: 'content' } } }], children: [{ key: 'content', name: 'Content', components: [{ type: 'cc.Label', properties: { string: 'Hello' } }] }] },
  ] } };
  nodes: JsonObject[] = []; writes = 0; revision = 'initial'; fail = false; mutateOnFailure = false;
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
      component.properties = p.properties!; return {};
    }
    if (id === 'node.delete') { this.nodes = []; return {}; }
    throw new Error(id);
  });
  params(): JsonObject { return { parentId: 'parent', document: this.document }; }
  async build(): Promise<JsonValue> { const p = this.params(); return this.service.execute('ui.build', { ...p, planHash: (await this.service.plan(p)).planHash! }); }
}

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
