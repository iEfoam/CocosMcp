import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2ReferenceAudit } from '../extensions/creator2/src/reference-audit.js';
import type { JsonObject } from '../packages/contracts/src/index.js';

test('serialized reference audit retains nested ownership and ignores engine topology', () => {
  const result = new Creator2ReferenceAudit().inspect([
    { __type__: 'cc.Node', _id: 'root', _children: [{ __id__: 1 }], _components: [{ __id__: 2 }] },
    { __type__: 'cc.Node', _id: 'target', _parent: { __id__: 0 } },
    { __type__: 'Custom', _id: 'component', node: { __id__: 0 }, direct: { __id__: 1 }, nested: { __id__: 3 }, sprite: { __uuid__: 'sprite' } },
    { __type__: 'Event', target: { __id__: 1 }, recursive: { __id__: 3 } },
  ]);
  const rows = result.rows as JsonObject[];
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.path), ['direct', 'nested.target', 'sprite']);
  assert.ok(rows.every(row => row.sourceId === 'component'));
  assert.equal(rows[2]!.resolved, null);
  assert.deepEqual(result.issues, []);
});
test('invalid serialized object references are visible and excessive traversal refuses incomplete success', () => {
  const audit = new Creator2ReferenceAudit();
  const result = audit.inspect([{ __type__: 'Custom', _id: 'owner', missing: { __id__: 100 }, negative: { __id__: -1 } }]);
  assert.equal((result.issues as unknown[]).length, 2);
  let nested: JsonObject = {};
  for (let i = 0; i < 70; i++) nested = { nested };
  assert.throws(() => audit.inspect([{ __type__: 'Custom', _id: 'owner', nested }]), /traversal limit/);
  assert.throws(() => audit.inspect('{}'), /object table/);
});

import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
class EventAuditHarness {
  getterCalls = 0;
  callbackCalls = 0;
  component = { uuid: 'receiver', kind: 'Receiver', handler: () => { this.callbackCalls++; } };
  target = { uuid: 'target', children: [], getComponents: () => [this.component] };
  root = { uuid: 'root', children: [this.target], getComponents: () => [] };
  table = [
    { __type__: 'cc.Node', _id: 'target' },
    { __type__: 'cc.Button', _id: 'sender', clickEvents: [{ __type__: 'cc.ClickEvent', target: { __id__: 0 }, _componentId: 'ReceiverID', component: 'WrongLegacyName', handler: 'handler' }] },
  ];
  inspector = new SceneInspector({ major: 2, cc: { director: { getScene: () => this.root }, js: {
    _getClassById: (id: string) => id === 'ReceiverID' ? Object : null,
    getClassByName: () => null, getClassName: (c: { kind?: string }) => c.kind ?? 'cc.Node',
  } }, serialize: () => this.table });
}
test('Creator 2 event audit resolves class IDs, creates component dependencies and never invokes handlers', () => {
  const h = new EventAuditHarness(), audit = new Creator2ReferenceAudit().scene(h.inspector);
  assert.equal((audit.events as JsonObject[])[0]!.valid, true);
  assert.ok((audit.rows as JsonObject[]).some(row => row.kind === 'event-component' && row.sourceId === 'sender' && row.targetId === 'receiver'));
  assert.equal(h.callbackCalls, 0);
});
test('Creator 2 event audit rejects missing, ambiguous and accessor handlers without executing getters', () => {
  const h = new EventAuditHarness(), auditor = new Creator2ReferenceAudit();
  Object.defineProperty(h.component, 'handler', { configurable: true, get: () => { h.getterCalls++; return () => {}; } });
  assert.equal((auditor.scene(h.inspector).issues as JsonObject[])[0]!.code, 'EVENT_HANDLER_ACCESSOR_UNVERIFIED');
  assert.equal(h.getterCalls, 0);
  h.target.getComponents = () => [h.component, h.component];
  assert.equal((auditor.scene(h.inspector).issues as JsonObject[])[0]!.code, 'EVENT_COMPONENT_AMBIGUOUS');
  h.target.getComponents = () => [];
  assert.equal((auditor.scene(h.inspector).issues as JsonObject[])[0]!.code, 'EVENT_COMPONENT_MISSING');
});

import { Creator2AssetReferenceAudit } from '../packages/creator2-adapter/src/reference-audit.js';
import type { Creator2Port } from '../packages/creator2-adapter/src/index.js';
test('asset reference audit deduplicates compressed UUID lookup and distinguishes missing from query failure', async () => {
  const calls: unknown[] = [];
  const uuid = '00112233-4455-6677-8899-aabbccddeeff';
  const compressed = '00' + Buffer.from('112233445566778899aabbccddeeff', 'hex').toString('base64');
  const port: Creator2Port = { version: '2.4.15', projectPath: '.', scene: async () => null, selection: () => [], ipc: async () => null,
    asset: async (_method, id) => { calls.push(id); if (id === 'offline') throw new Error('bridge unavailable'); return id === uuid ? { uuid, url: 'db://internal/default.png/subasset' } : null; } };
  const result = await new Creator2AssetReferenceAudit(port).resolve({ rows: [uuid, compressed, 'missing', 'offline'].map(targetId => ({ kind: 'asset', targetId })), issues: [] });
  assert.deepEqual(calls, [uuid, 'missing', 'offline']);
  assert.deepEqual((result.rows as JsonObject[]).map(row => row.status), ['registered', 'registered', 'missing', 'query-failed']);
  assert.equal(result.assetLookupComplete, false);
  assert.deepEqual((result.issues as JsonObject[]).map(row => row.code), ['ASSET_REFERENCE_MISSING', 'ASSET_LOOKUP_FAILED']);
});
