import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetUuid } from '../packages/asset-policy/src/uuid.js';

test('Creator resource UUID normalization preserves subasset identity and rejects malformed compressed forms', () => {
  const uuids = new AssetUuid(), full = 'fc991dd7-0033-4b80-9d41-c8a86a702e59';
  assert.equal(uuids.normalize('fcmR3XADNLgJ1ByKhqcC5Z'), full);
  assert.equal(uuids.normalize('fcmR3XADNLgJ1ByKhqcC5Z@AbCd@part'), `${full}@AbCd@part`);
  assert.equal(uuids.normalize(`${full.toUpperCase()}@AbCd`), `${full}@AbCd`);
  for (const value of ['gcAAAAAAAAAAAAAAAAAAAA', 'fcAAAAAAAAAAAAAAAAAAA=', 'fcAAAAAAAAAAAAAAAAAAA_', 'builtin-white', '', '@part']) assert.equal(uuids.normalize(value), value);
  assert.equal(uuids.normalize('00////////////////////'), '00ffffff-ffff-ffff-ffff-ffffffffffff');
});
