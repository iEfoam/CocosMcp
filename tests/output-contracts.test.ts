import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputContracts } from '../packages/capability-catalog/src/output-contracts.js';
import { Operations } from '../packages/capability-catalog/src/operations.js';

test('catalog exposes the same output contracts used by bridge validation', () => {
  const contracts = new OutputContracts(), rows = new Operations().list();
  for (const id of ['scene.query', 'node.query', 'preview.capture', 'prefab.diff', 'asset.references.scan', 'asset.location', 'asset.organize.plan', 'asset.organize.recovery', 'ui.plan', 'ui.build', 'ui.diff', 'ui.apply']) {
    assert.deepEqual(rows.find(row => row.id === id)?.outputSchema, contracts.schema(id));
    assert.throws(() => contracts.validate(id, {}), { code: 'VERIFICATION_FAILED' });
  }
});

test('capture contracts separate native draw evidence from scoped browser images without claiming business verification', () => {
  const contracts = new OutputContracts();
  const common = { captureId: 'capture', capturedAt: '2026-10-29T00:00:00Z', width: 20, height: 10,
    dataUrl: 'data:image/png;base64,dGVzdA==', imageDelivery: 'image', image: { mimeType: 'image/png', byteLength: 4, sha256: 'a'.repeat(64) } };
  const external = { ...common, source: 'scoped-browser-connector' };
  contracts.validate('preview.capture', external);
  const native = { ...common, source: 'managed-preview-window', stale: false, frameBinding: 'draw-observed-before-composite', exactPixelFrameIndex: null,
    verification: 'rendered-frame-captured', businessOutcomeVerified: false, layoutVerified: false };
  contracts.validate('preview.capture', native);
  contracts.validate('preview.capture', { ...native, stale: true, freshness: 'explicit-last-frame' });
  for (const invalid of [{ ...external, width: 0 }, { ...external, dataUrl: 'not-image' }, { ...native, exactPixelFrameIndex: 7 },
    { ...native, businessOutcomeVerified: true }, { ...native, layoutVerified: true }, { ...common, source: 'managed-preview-window' }]) {
    assert.throws(() => contracts.validate('preview.capture', invalid), { code: 'VERIFICATION_FAILED' });
  }
});

test('UI contracts preserve the two native shapes and reject malformed persistence and identity fields', () => {
  const contracts = new OutputContracts(), planHash = 'a'.repeat(64);
  contracts.validate('ui.plan', { planHash, rows: [{ key: 'root', name: 'Panel' }], mapping: 'Creator2.Node-size-anchor-opacity', nativeVersion: '2.4.15' });
  contracts.validate('ui.plan', { planHash, rows: [], revision: 'revision', parentId: 'parent', assets: [], limitations: [] });
  contracts.validate('ui.diff', { planHash, rows: [], structuralChanges: false });
  contracts.validate('ui.diff', { planHash, rows: [], applicable: true, blocked: [] });
  contracts.validate('ui.apply', { rootId: 'root', rows: [{ key: 'root', nodeId: 'root' }], needsSave: true, undoScope: 'editor-native-history' });
  contracts.validate('ui.apply', { rootId: 'root', rows: [], mapping: [{ key: 'root', nodeId: 'root' }], changed: false, needsSave: false });
  assert.throws(() => contracts.validate('ui.apply', { rootId: 'root', rows: [], needsSave: 'true' }), { code: 'VERIFICATION_FAILED' });
  assert.throws(() => contracts.validate('ui.build', { rootId: 'root', rows: [{ key: 'root' }], needsSave: true }), { code: 'VERIFICATION_FAILED' });
  contracts.validate('scene.query', { context: 'editor', scene: {}, dirty: null });
  assert.throws(() => contracts.validate('scene.query', { context: 'editor', scene: {}, dirty: 'unknown' }), { code: 'VERIFICATION_FAILED' });
});
