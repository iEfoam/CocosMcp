import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrefabDiff } from '../packages/ui-core/src/prefab-diff.js';
import { PrefabService } from '../packages/creator3-adapter/src/prefab.js';
import { PrefabChanges } from '../packages/creator3-adapter/src/prefab-changes.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';
import { type JsonObject, type JsonValue } from '../packages/contracts/src/index.js';
import { TestWorkspace } from './workspace.js';
import { OutputContracts } from '../packages/capability-catalog/src/output-contracts.js';
import { Creator3PrefabSnapshot } from '../extensions/creator3/src/prefab-snapshot.js';
import type { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';

class PrefabTable {
  readonly rows: JsonObject[] = [];
  readonly root: number;
  constructor(readonly instance: boolean) {
    if (!instance) this.rows.push({ __type__: 'cc.Prefab', data: { __id__: 1 } });
    this.root = this.node('root', 'Root');
  }
  node(fileId: string, name: string, parent?: number, nested?: string): number {
    const index = this.rows.length;
    this.rows.push({ __type__: 'cc.Node', _id: `${this.instance ? 'instance' : 'source'}-${index}`, _name: name,
      _children: [], _components: [], _parent: parent === undefined ? null : { __id__: parent }, _prefab: null });
    if (fileId) {
      const metadata = this.rows.length;
      this.rows.push({ __type__: 'cc.PrefabInfo', fileId, asset: { __uuid__: nested ? 'nested-asset' : 'asset' }, root: { __id__: this.root ?? index } });
      this.rows[index]!._prefab = { __id__: metadata };
      if (nested) { const instance = this.rows.length; this.rows.push({ __type__: 'cc.PrefabInstance', fileId: nested }); this.rows[metadata]!.instance = { __id__: instance }; }
    }
    if (parent !== undefined) (this.rows[parent]!._children as JsonValue[]).push({ __id__: index });
    return index;
  }
  component(node: number, fileId: string, target: number, speed = 1): number {
    const index = this.rows.length;
    this.rows.push({ __type__: 'custom.Component', _id: `${this.instance ? 'runtime' : 'saved'}-${index}`, node: { __id__: node }, target: { __id__: target }, speed, __prefab: { __id__: index + 1 } });
    this.rows.push({ __type__: 'cc.CompPrefabInfo', fileId });
    (this.rows[node]!._components as JsonValue[]).push({ __id__: index }); return index;
  }
}

class PrefabChangeFixture {
  async create() {
    const root = await new TestWorkspace().create('prefab-change-'); await mkdir(join(root, 'assets'));
    const source = new PrefabTable(false), live = new PrefabTable(true), path = join(root, 'assets/Panel.prefab');
    source.rows[source.root]!.value = 1; live.rows[live.root]!.value = 2;
    live.rows[live.root]!._name = 'Custom'; await writeFile(path, JSON.stringify(source.rows));
    const state = { writes: 0, acknowledgeOnly: false, failAfterWrite: false, readonly: false };
    const mutate = async (action: string) => {
      state.writes++;
      if (!state.acknowledgeOnly) {
        if (action === 'apply-prefab') await writeFile(path, JSON.stringify(live.rows));
        else live.rows[live.root]!.value = 1;
      }
      if (state.failAfterWrite) throw new Error('native reply lost');
      return false; // 原生 false 本身不能推翻独立的收敛证据。
    };
    const port = { version: '3.8.8', projectPath: root,
      request: async (channel: string, method: string) => {
        if (method === 'apply-prefab' || method === 'restore-prefab') { assert.equal(channel, 'scene'); return mutate(method); }
        assert.equal(channel, 'asset-db'); assert.equal(method, 'query-asset-info');
        return { uuid: 'asset', type: 'cc.Prefab', url: 'db://assets/Panel.prefab', readonly: state.readonly };
      },
      scene: async (method: string) => {
        if (method === 'prefabReference') return { assetUuid: 'asset', rootId: 'instance-root' };
        assert.equal(method, 'prefab.snapshot');
        return { assetUuid: 'asset', rootId: 'instance-root', serialized: live.rows, observedNodeCount: 1, observedComponentCount: 0, componentIssues: [] };
      },
    } as unknown as EditorPort;
    return { live, source, path, state, changes: new PrefabChanges(port) };
  }
}

test('Prefab change guards reject stale instance/source, changed action, and incomplete comparisons before writing', async () => {
  const f = await new PrefabChangeFixture().create(), plan = await f.changes.plan('instance-root', 'restore');
  const execute = () => f.changes.execute('instance-root', 'restore', String(plan.expectedHash), String(plan.planHash));
  f.live.rows[f.live.root]!._name = 'Newer'; await assert.rejects(execute(), { code: 'STALE_REVISION' });
  f.live.rows[f.live.root]!._name = 'Custom';
  await assert.rejects(f.changes.execute('instance-root', 'apply', String(plan.expectedHash), String(plan.planHash)), { code: 'STALE_REVISION' });
  await writeFile(f.path, JSON.stringify(f.source.rows, null, 2)); await assert.rejects(execute(), { code: 'STALE_REVISION' });
  delete f.live.rows[f.live.root]!._children;
  await assert.rejects(f.changes.plan('instance-root', 'restore'), { code: 'VERIFICATION_FAILED' });
  assert.equal(f.state.writes, 0);
});

test('guarded apply and restore require post-write source/instance convergence', async () => {
  for (const action of ['apply', 'restore'] as const) {
    const f = await new PrefabChangeFixture().create(), plan = await f.changes.plan('instance-root', action);
    const contracts = new OutputContracts(); contracts.validate('prefab.change.plan', plan);
    const result = await f.changes.execute('instance-root', action, String(plan.expectedHash), String(plan.planHash));
    contracts.validate('prefab.change.apply', result);
    assert.throws(() => contracts.validate('prefab.change.apply', { ...result, sceneSavedByTool: true }), { code: 'VERIFICATION_FAILED' });
    assert.throws(() => contracts.validate('prefab.change.plan', { ...plan, planHash: 'invalid' }), { code: 'VERIFICATION_FAILED' });
    if (action === 'restore') {
      assert.throws(() => contracts.validate('prefab.change.apply', { ...result, action: 'apply' }), { code: 'VERIFICATION_FAILED' });
      assert.throws(() => contracts.validate('prefab.change.apply', { ...result, verification: 'source-instance-converged' }), { code: 'VERIFICATION_FAILED' });
    }
    assert.equal(result.verification, action === 'restore' ? 'source-instance-converged-with-preserved-properties' : 'source-instance-converged');
    assert.equal((result.preservedRows as JsonObject[]).length, action === 'restore' ? 1 : 0);
    assert.equal(result.sceneSavedByTool, false); assert.equal(f.state.writes, 1);
  }
});

test('dispatched failures and non-convergence remain unknown; readonly sources cannot receive apply', async () => {
  for (const behavior of ['acknowledgeOnly', 'failAfterWrite'] as const) {
    const f = await new PrefabChangeFixture().create(), plan = await f.changes.plan('instance-root', 'restore'); f.state[behavior] = true;
    await assert.rejects(f.changes.execute('instance-root', 'restore', String(plan.expectedHash), String(plan.planHash)), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(f.state.writes, 1);
  }
  const f = await new PrefabChangeFixture().create(); f.state.readonly = true;
  await assert.rejects(f.changes.plan('instance-root', 'apply'), { code: 'INVALID_ARGUMENT' }); assert.equal(f.state.writes, 0);
});

test('native snapshot enforces a UTF-8 output budget without detaching the inspected node', () => {
  const parent = { uuid: 'parent' }, root: Record<string, unknown> = { uuid: 'root', _parent: parent, children: [] };
  root._prefab = { root, asset: { uuid: 'asset' } };
  const inspector = { node: () => root, components: () => [], environment: {} } as unknown as SceneInspector;
  const snapshot = new Creator3PrefabSnapshot(inspector, () => '你好').capture('root');
  assert.equal(snapshot.serializedBytes, 6); assert.equal(snapshot.serializationScope, 'native-context-with-external-references');
  assert.throws(() => new Creator3PrefabSnapshot(inspector, () => 'x'.repeat(16 * 1024 * 1024 + 1)).capture('root'), { code: 'RESOURCE_BUSY' });
  assert.equal(root._parent, parent); assert.deepEqual(root.children, []);
});

test('native component inspection detects missing scripts even when serialization preserves original class data', () => {
  const root: Record<string, unknown> = { uuid: 'root', children: [] };
  root._prefab = { root, asset: { uuid: 'asset' } };
  const components = [{ uuid: 'missing', type: 'cc.MissingScript' }, { uuid: 'custom', type: 'GameController' }, { uuid: 'unknown', type: 'Object' }];
  const inspector = { node: () => root, components: () => components, type: (value: { type: string }) => value.type, environment: {} } as unknown as SceneInspector;
  const serialized = [{ __type__: 'original-script-uuid', speed: 1 }];
  const result = new Creator3PrefabSnapshot(inspector, () => serialized).capture('root');
  assert.deepEqual(result.serialized, serialized);
  assert.equal(result.observedComponentCount, 3);
  assert.deepEqual((result.componentIssues as JsonObject[]).map(row => [row.componentId, row.code]), [
    ['missing', 'MISSING_COMPONENT_SCRIPT'], ['unknown', 'COMPONENT_TYPE_UNVERIFIED'],
  ]);
});

test('Prefab comparison normalizes table offsets and runtime UUIDs while retaining property, add and remove differences', () => {
  const source = new PrefabTable(false), live = new PrefabTable(true);
  const oldChild = source.node('child', 'Child', source.root), child = live.node('child', 'Child', live.root);
  source.component(source.root, 'component', oldChild); const component = live.component(live.root, 'component', child);
  assert.deepEqual(new PrefabDiff().compare(source.rows, live.rows).rows, []);
  source.node('removed', 'Removed', source.root); live.node('', 'Added', live.root); live.rows[component]!.speed = 2;
  const before = JSON.stringify([source.rows, live.rows]), result = new PrefabDiff().compare(source.rows, live.rows), rows = result.rows as JsonObject[];
  assert.equal(result.comparisonComplete, true); assert.equal(result.automaticRepairAllowed, false);
  assert.ok(rows.some(row => row.status === 'added')); assert.ok(rows.some(row => row.status === 'removed'));
  assert.ok(rows.some(row => row.status === 'property-override' && (row.change as JsonObject).path === 'properties/speed'));
  assert.equal((result.tree as unknown[]).length, 1); assert.equal(JSON.stringify([source.rows, live.rows]), before);
});

test('nested Prefab instances use independent instance-fileId scopes even when their node/component fileIds repeat', () => {
  const source = new PrefabTable(false), live = new PrefabTable(true);
  for (const table of [source, live]) for (const slot of ['slot-a', 'slot-b']) {
    const nested = table.node('nested-root', 'Nested', table.root, slot), child = table.node('same-child', 'Child', nested);
    table.component(nested, 'same-component', child, table.instance && slot === 'slot-b' ? 3 : 1);
  }
  const result = new PrefabDiff().compare(source.rows, live.rows), rows = result.rows as JsonObject[];
  assert.equal(result.comparisonComplete, true); assert.equal(rows.length, 1); assert.match(String(rows[0]!.key), /slot-b/);
});

test('compact nested source attributes are unverified differences rather than confirmed overrides', () => {
  const source = new PrefabTable(false), live = new PrefabTable(true);
  const child = source.node('nested', 'Child', source.root, 'slot');
  live.node('nested', 'Child', live.root, 'slot');
  delete source.rows[child]!._children; delete source.rows[child]!._components; delete source.rows[child]!._name;
  const result = new PrefabDiff().compare(source.rows, live.rows);
  assert.equal(result.comparisonComplete, false);
  const rows = result.rows as JsonObject[];
  assert.ok(rows.some(row => row.status === 'unverified-property-difference'));
  assert.equal(rows.some(row => row.status === 'property-override'), false);
});

test('asset reference UUID representations compare equally without normalizing arbitrary string properties', () => {
  const source = new PrefabTable(false), live = new PrefabTable(true);
  source.rows[source.root]!.texture = { __uuid__: 'fcmR3XADNLgJ1ByKhqcC5Z@part' };
  live.rows[live.root]!.texture = { __uuid__: 'fc991dd7-0033-4b80-9d41-c8a86a702e59@part' };
  assert.deepEqual(new PrefabDiff().compare(source.rows, live.rows).rows, []);
  source.rows[source.root]!.text = 'fcmR3XADNLgJ1ByKhqcC5Z';
  live.rows[live.root]!.text = 'fc991dd7-0033-4b80-9d41-c8a86a702e59';
  assert.equal((new PrefabDiff().compare(source.rows, live.rows).rows as JsonObject[]).length, 1);
  live.rows[live.root]!.texture = { __uuid__: 'fc991dd7-0033-4b80-9d41-c8a86a702e59@other' };
  assert.equal((new PrefabDiff().compare(source.rows, live.rows).rows as JsonObject[]).length, 2);
});

test('reference validation issues invalidate apparently equal Prefab data and retain exact reference locations', () => {
  const source = new PrefabTable(false), live = new PrefabTable(true);
  source.rows[source.root]!.texture = live.rows[live.root]!.texture = { __uuid__: 'missing-texture' };
  live.rows.push({ __type__: 'cc.Node', texture: { __uuid__: 'unrelated-parent-context' } });
  const diff = new PrefabDiff(), first = diff.compare(source.rows, live.rows);
  const refs = first.assetReferences as JsonObject[];
  assert.equal(refs.length, 2); assert.ok(refs.every(row => row.assetUuid === 'missing-texture' && row.path === 'texture'));
  const invalid = diff.compare(source.rows, live.rows, undefined, undefined, undefined, refs.map(row => ({ ...row, code: 'ASSET_REFERENCE_UNVERIFIED', reason: 'not-found' })));
  assert.equal(invalid.comparisonComplete, false); assert.deepEqual(invalid.rows, []); assert.equal((invalid.issues as JsonObject[]).length, 2);
});

test('broken references, duplicate identities and incomplete native snapshots cannot prove deletions', () => {
  const source = new PrefabTable(false), live = new PrefabTable(true);
  source.node('removed', 'Child', source.root); live.component(live.root, 'component', 99999);
  let result = new PrefabDiff().compare(source.rows, live.rows, 10);
  assert.equal(result.comparisonComplete, false); assert.ok((result.issues as JsonObject[]).some(row => row.code === 'BROKEN_PROPERTY_REFERENCE'));
  assert.ok((result.rows as JsonObject[]).some(row => row.status === 'unverified-missing'));
  source.node('removed', 'Duplicate', source.root);
  result = new PrefabDiff().compare(source.rows, live.rows);
  assert.ok((result.issues as JsonObject[]).some(row => row.code === 'AMBIGUOUS_FILE_ID'));
});

test('missing hierarchy lists and inconsistent ownership remain incomplete instead of proving structural changes', () => {
  const source = new PrefabTable(false), live = new PrefabTable(true);
  const oldChild = source.node('child', 'Child', source.root), child = live.node('child', 'Child', live.root);
  source.component(source.root, 'component', oldChild);
  const component = live.component(live.root, 'component', child);
  live.rows[child]!._parent = null;
  live.rows[component]!.node = { __id__: child };
  delete source.rows[oldChild]!._children;
  const result = new PrefabDiff().compare(source.rows, live.rows);
  assert.equal(result.comparisonComplete, false);
  const issues = result.issues as JsonObject[];
  assert.equal(issues.filter(row => row.code === 'HIERARCHY_OWNER_MISMATCH').length, 2);
  assert.ok(issues.some(row => row.code === 'HIERARCHY_LIST_MISSING'));
});

test('source Prefab self references normalize to the verified AssetDB UUID', () => {
  const source = new PrefabTable(false), live = new PrefabTable(true);
  source.node('child', 'Child', source.root); live.node('child', 'Child', live.root);
  for (const row of source.rows) if (row.__type__ === 'cc.PrefabInfo') row.asset = { __id__: 0 };
  const result = new PrefabDiff().compare(source.rows, live.rows, 2, 0, 'asset');
  assert.equal(result.comparisonComplete, true); assert.deepEqual(result.rows, []);
  assert.equal(new PrefabDiff().compare(source.rows, live.rows).comparisonComplete, false);
});

test('native editor extras and unrelated parent-context records do not become Prefab property overrides', () => {
  const source = new PrefabTable(false), live = new PrefabTable(true);
  live.rows[live.root]!.__editorExtras__ = { inspector: 'editor-only state' };
  const parent = live.node('', 'External parent'); live.rows[live.root]!._parent = { __id__: parent };
  const result = new PrefabDiff().compare(source.rows, live.rows, 1, 0);
  assert.equal(result.comparisonComplete, true); assert.deepEqual(result.rows, []);
});

test('node objects cannot masquerade as serialized components', () => {
  const source = new PrefabTable(false), live = new PrefabTable(true);
  const child = live.node('child', 'Child');
  (live.rows[live.root]!._components as JsonValue[]).push({ __id__: child });
  const result = new PrefabDiff().compare(source.rows, live.rows);
  assert.equal(result.comparisonComplete, false);
  assert.ok((result.issues as JsonObject[]).some(row => row.code === 'BROKEN_HIERARCHY_REFERENCE'));
});

test('Prefab adapter binds source hashes and instance identity without apply/restore calls', async () => {
  const root = await new TestWorkspace().create('prefab-diff-'); await mkdir(join(root, 'assets'));
  const source = new PrefabTable(false), live = new PrefabTable(true), path = join(root, 'assets/Panel.prefab');
  await writeFile(path, JSON.stringify(source.rows)); const before = await readFile(path); const calls: string[] = [];
  let mutate = false; let snapshotOverrides: JsonObject = {};
  const port = { version: '3.8.8', projectPath: root,
    request: async (channel: string, method: string) => { calls.push(`${channel}:${method}`); return { uuid: 'asset', type: 'cc.Prefab', url: 'db://assets/Panel.prefab' }; },
    scene: async (method: string) => {
      calls.push(method);
      if (method === 'prefabReference') return { assetUuid: 'asset', rootId: 'instance-root' };
      if (mutate) await writeFile(path, '[]');
      return { assetUuid: 'asset', rootId: 'instance-root', serialized: live.rows, observedNodeCount: 1, observedComponentCount: 0, componentIssues: [], source: 'fixture', ...snapshotOverrides };
    },
  } as unknown as EditorPort;
  const result = await new PrefabService(port).diff('instance-root');
  const contracts = new OutputContracts(); contracts.validate('prefab.diff', result);
  assert.throws(() => contracts.validate('prefab.diff', { ...result, automaticRepairAllowed: true }), { code: 'VERIFICATION_FAILED' });
  assert.equal(result.comparisonComplete, true); assert.match(String(result.sourceHash), /^[a-f0-9]{64}$/); assert.deepEqual(await readFile(path), before);
  assert.deepEqual(calls, ['prefabReference', 'asset-db:query-asset-info', 'prefab.snapshot', 'asset-db:query-asset-info']);
  for (const invalid of [{ observedNodeCount: '1' }, { observedNodeCount: 0 }, { observedComponentCount: -1 }, { serialized: null }, { componentIssues: null }, { componentIssues: [{}] }] as JsonObject[]) {
    snapshotOverrides = invalid; await assert.rejects(new PrefabService(port).diff('instance-root'), { code: 'VERIFICATION_FAILED' });
  }
  for (const componentIssues of [undefined, [{ code: 'MISSING_COMPONENT_SCRIPT', side: 'instance', componentId: 'missing' }]]) {
    snapshotOverrides = componentIssues === undefined ? {} : { componentIssues };
    if (componentIssues === undefined) Object.defineProperty(snapshotOverrides, 'componentIssues', { value: undefined, enumerable: true });
    const unavailable = await new PrefabService(port).diff('instance-root');
    assert.equal(unavailable.comparisonComplete, false);
    assert.deepEqual(unavailable.rows, []);
    await assert.rejects(new PrefabChanges(port).plan('instance-root', 'restore'), { code: 'VERIFICATION_FAILED' });
  }
  snapshotOverrides = {};
  source.rows[source.root]!.texture = live.rows[live.root]!.texture = { __uuid__: 'unresolved-texture' };
  await writeFile(path, JSON.stringify(source.rows));
  const unresolved = await new PrefabService(port).diff('instance-root');
  assert.equal(unresolved.comparisonComplete, false);
  assert.ok((unresolved.issues as JsonObject[]).some(row => row.code === 'ASSET_REFERENCE_UNVERIFIED' && row.reason === 'identity-mismatch'));
  await assert.rejects(new PrefabChanges(port).plan('instance-root', 'restore'), { code: 'VERIFICATION_FAILED' });
  mutate = true; await assert.rejects(new PrefabService(port).diff('instance-root'), { code: 'STALE_REVISION' });
  await assert.rejects(new PrefabService({ ...port, version: '3.8.7' }).diff('instance-root'), { code: 'UNSUPPORTED_VERSION' });
});
