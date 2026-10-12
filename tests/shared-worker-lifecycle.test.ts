import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SharedWorkerLifecycle } from '../apps/server/src/shared-worker-lifecycle.js';
import { Json } from '../packages/contracts/src/index.js';

test('shared leases expire on elapsed time and active work pins the worker after client loss', async () => {
  let now = 0, closed = 0, busy = false;
  const lifecycle = new SharedWorkerLifecycle(60, 90, () => now), first = randomUUID(), second = randomUUID();
  const lease = Json.object(lifecycle.handle('/clients/register', { clientId: first }));
  const other = Json.object(lifecycle.handle('/clients/register', { clientId: second }));
  const close = async () => { closed++; };
  now = 50; lifecycle.handle('/clients/release', { clientId: first, leaseToken: lease.leaseToken! }); await lifecycle.sweep(() => busy, close); assert.equal(closed, 0);
  lifecycle.handle('/clients/heartbeat', { clientId: second, leaseToken: other.leaseToken! });
  now = 111; busy = true; await lifecycle.sweep(() => busy, close); assert.equal(closed, 0);
  assert.equal(Json.object(lifecycle.handle('/clients/status', {})).clients, 0);
  assert.throws(() => lifecycle.handle('/clients/heartbeat', { clientId: second, leaseToken: other.leaseToken! }), { code: 'UNAUTHORIZED' });
  now = 300; await lifecycle.sweep(() => busy, close); assert.equal(closed, 0);
  busy = false; now = 389; await lifecycle.sweep(() => busy, close); assert.equal(closed, 0);
  now = 390; await lifecycle.sweep(() => busy, close); assert.equal(closed, 1);
  assert.throws(() => lifecycle.handle('/clients/register', { clientId: randomUUID() }), { code: 'RESOURCE_BUSY' });
  await lifecycle.sweep(() => busy, close); assert.equal(closed, 1);
});

test('in-flight requests remain protected after lease expiry; forged lease secrets cannot release another client', async () => {
  let now = 0, closed = 0;
  const lifecycle = new SharedWorkerLifecycle(60, 90, () => now), id = randomUUID(), lease = Json.object(lifecycle.handle('/clients/register', { clientId: id }));
  assert.throws(() => lifecycle.handle('/clients/release', { clientId: id, leaseToken: 'wrong' }), { code: 'UNAUTHORIZED' });
  const release = lifecycle.acquire({ headers: { 'x-cocos-client-id': id, 'x-cocos-lease-token': Json.string(lease.leaseToken, 'leaseToken') } });
  now = 1000; await lifecycle.sweep(() => false, async () => { closed++; }); assert.equal(closed, 0);
  release(); release();
  now = 1089; await lifecycle.sweep(() => false, async () => { closed++; }); assert.equal(closed, 0);
  now = 1090; await lifecycle.sweep(() => false, async () => { closed++; }); assert.equal(closed, 1);
});
