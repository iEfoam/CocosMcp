import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2Features } from '../packages/runtime2-bridge/src/features.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import type { JsonObject } from '../packages/contracts/src/index.js';

class ResourceHarness {
  referenceWrites = 0;
  asset = { _uuid: 'asset-a', name: 'A', kind: 'cc.Texture2D', refCount: 1, isValid: true,
    addRef: () => { this.referenceWrites++; }, decRef: () => { this.referenceWrites++; } };
  assets = new Map([['asset-a', this.asset]]);
  dependencies = ['dep-b', 'dep-a', 'dep-b'];
  cc = { ENGINE_VERSION: '2.4.15', director: { getScene: () => ({ uuid: 'scene' }) },
    js: { getClassName: (value: { kind: string }) => value.kind },
    assetManager: { assets: this.assets, bundles: new Map([['main', { name: 'main', base: '/assets/' }]]), dependUtil: { getDeps: () => this.dependencies } } };
  features = new Creator2Features(new SceneInspector({ major: 2, cc: this.cc }));
  snapshot(): JsonObject { return this.features.execute('runtime.resources.snapshot', {}) as JsonObject; }
  diff(baseline: JsonObject): JsonObject { return this.features.execute('runtime.resources.diff', { baseline }) as JsonObject; }
}

test('Creator 2 resource diff tracks cache residency and ref counts without releasing shared assets', () => {
  const h = new ResourceHarness(), baseline = h.snapshot();
  assert.deepEqual((baseline.rows as JsonObject[])[0]!.dependencies, ['dep-a', 'dep-b']);
  h.asset.refCount++;
  let diff = h.diff(baseline);
  assert.equal((diff.rows as JsonObject[])[0]!.status, 'changed');
  assert.equal(diff.leakDetected, null); assert.equal(diff.sameRuntimeVerified, true);
  h.assets.delete('asset-a'); h.assets.set('asset-c', { ...h.asset, _uuid: 'asset-c' });
  diff = h.diff(baseline);
  assert.deepEqual((diff.rows as JsonObject[]).map(row => row.status), ['added', 'removed']);
  assert.equal(h.referenceWrites, 0);
});

test('resource baseline provenance survives scene changes but rejects replacement runtime, alteration and eviction', () => {
  const h = new ResourceHarness(), baseline = h.snapshot();
  h.cc.director.getScene = () => ({ uuid: 'next-scene' });
  const diff = h.diff(baseline);
  assert.equal(diff.sameRuntimeVerified, true);
  assert.equal(diff.beforeSceneId, 'scene'); assert.equal(diff.afterSceneId, 'next-scene');
  assert.equal(new ResourceHarness().diff(baseline).sameRuntimeVerified, false);
  const altered = { ...baseline, sceneId: 'fabricated' };
  assert.equal(h.diff(altered).baselineVerification, 'modified-or-expired-baseline');
  for (let index = 0; index < 4; index++) h.snapshot();
  assert.equal(h.diff(baseline).sameRuntimeVerified, false);
});

test('resource trends preserve missing versus unknown counts and require ordered native baselines', () => {
  const h = new ResourceHarness(), first = h.snapshot();
  h.asset.refCount = 3; const second = h.snapshot();
  h.assets.delete('asset-a'); const third = h.snapshot();
  const snapshotIds = [first.snapshotId!, second.snapshotId!, third.snapshotId!];
  const trend = h.features.execute('runtime.resources.trend', { snapshotIds }) as JsonObject;
  const row = (trend.rows as JsonObject[])[0]!;
  assert.deepEqual(row.refCounts, [1, 3, null]); assert.deepEqual(row.present, [true, true, false]);
  assert.equal(row.disappeared, true); assert.equal(row.persistent, false); assert.equal(trend.leakDetected, null);
  assert.throws(() => h.features.execute('runtime.resources.trend', { snapshotIds: [second.snapshotId!, first.snapshotId!] }), /order/);
  assert.throws(() => h.features.execute('runtime.resources.trend', { snapshotIds: [first.snapshotId!, first.snapshotId!] }), /distinct/);
  assert.throws(() => new ResourceHarness().features.execute('runtime.resources.trend', { snapshotIds }), /expired/);
  for (let index = 0; index < 4; index++) h.snapshot();
  assert.throws(() => h.features.execute('runtime.resources.trend', { snapshotIds }), /expired/);
});

test('Creator 2 resource baseline rejects incomplete, duplicate and excessive dependencies', () => {
  const h = new ResourceHarness(), baseline = h.snapshot(), row = (baseline.rows as JsonObject[])[0]!;
  assert.throws(() => h.diff({ ...baseline, complete: false }), /complete/);
  assert.throws(() => h.diff({ ...baseline, engineVersion: '3.8.8' }), /2.4.15/);
  assert.throws(() => h.diff({ ...baseline, rows: [row, row] }), /duplicate/);
  assert.throws(() => h.diff({ ...baseline, rows: [{ ...row, refCount: Infinity }] }), /Invalid/);
  assert.throws(() => h.diff({ ...baseline, rows: [{ ...row, dependencies: Array(100001).fill('dep') }] }), /oversized/);
  const reordered = { ...baseline, rows: [{ ...row, dependencies: ['dep-b', 'dep-a', 'dep-b'], ignored: true }] };
  assert.equal(h.diff(reordered).unchanged, 1);
  h.dependencies = Array(100001).fill('dep');
  assert.throws(() => h.snapshot(), /limit/);
});
