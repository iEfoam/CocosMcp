import test from 'node:test';
import assert from 'node:assert/strict';
import { PrefabReferenceValidation } from '../packages/creator3-adapter/src/prefab-reference-validation.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';
import type { JsonObject } from '../packages/contracts/src/index.js';

test('AssetDB reference checks distinguish unresolved, unavailable, mismatched and failed lookups with locations', async () => {
  const port = { request: async (_channel: string, _method: string, uuid: string) => {
    if (uuid === 'missing') return null;
    if (uuid === 'failed') throw new Error('transport failure');
    if (uuid === 'mismatch') return { uuid: 'other' };
    return { uuid, invalid: uuid === 'invalid', url: `db://assets/${uuid}.png` };
  } } as unknown as EditorPort;
  const references = ['valid', 'missing', 'failed', 'mismatch', 'invalid'].map(assetUuid => ({ assetUuid, side: 'source', key: 'component', path: 'texture' }));
  const result = await new PrefabReferenceValidation(port).inspect(references);
  assert.deepEqual(Object.fromEntries(result.rows.map(row => [row.assetUuid, row.status])), {
    valid: 'resolved', missing: 'not-found', failed: 'lookup-failed', mismatch: 'identity-mismatch', invalid: 'unavailable',
  });
  assert.equal(result.issues.length, 4); assert.ok(result.issues.every(row => row.path === 'texture' && row.code === 'ASSET_REFERENCE_UNVERIFIED'));
});

test('reference lookups deduplicate UUID aliases, cap concurrency and refuse excessive queries before dispatch', async () => {
  let active = 0, maximum = 0, calls = 0;
  const port = { request: async (_channel: string, _method: string, uuid: string) => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return { uuid };
  } } as unknown as EditorPort;
  const references: JsonObject[] = Array.from({ length: 12 }, (_, i) => ({ assetUuid: `asset-${i}` }));
  references.push({ assetUuid: 'fcmR3XADNLgJ1ByKhqcC5Z' }, { assetUuid: 'fc991dd7-0033-4b80-9d41-c8a86a702e59' });
  const result = await new PrefabReferenceValidation(port).inspect(references);
  assert.equal(calls, 13); assert.equal(maximum, 4); assert.equal(result.issues.length, 0);
  await assert.rejects(new PrefabReferenceValidation(port).inspect(Array.from({ length: 501 }, (_, i) => ({ assetUuid: `too-many-${i}` }))), { code: 'RESOURCE_BUSY' });
  assert.equal(calls, 13);
});
