import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeController } from '../packages/runtime3-bridge/src/index.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';

class RuntimeFixture {
  listeners = new Map<string, (...args: unknown[]) => void>();
  child = { uuid: 'child', children: [], getComponents: () => [], destroy: () => { throw new Error('Borrowed node must not be destroyed'); } };
  scene = { uuid: 'root', children: [this.child], getComponents: () => [], on: (event: string, callback: (...args: unknown[]) => void) => this.listeners.set(event, callback), off: (event: string) => this.listeners.delete(event) };
  runtime = new RuntimeController({ major: 3, cc: { ENGINE_VERSION: '3.8.8', director: { getScene: () => this.scene } } });
}
test('disconnect invalidates generic handles, clears events and unsubscribes borrowed scene without destruction', async () => {
  const f = new RuntimeFixture(), runtime = f.runtime;
  const before = Json.object(await runtime.execute('runtime.query', {}));
  const result = Json.object(await runtime.execute('runtime.get', { target: 'scene', path: 'children' }));
  const handle = (result.value as JsonObject[])[0]!.handle;
  await runtime.execute('runtime.subscribe', { event: 'test' }); f.listeners.get('test')!('first');
  assert.equal((Json.object(await runtime.execute('runtime.events', {})).rows as unknown[]).length, 1);
  runtime.connectionLost(); runtime.connectionLost();
  assert.equal(f.listeners.size, 0);
  await assert.rejects(runtime.execute('runtime.inspect', { target: handle! }), { code: 'STALE_HANDLE' });
  assert.deepEqual(Json.object(await runtime.execute('runtime.events', {})).rows, []);
  assert.ok(Number(Json.object(await runtime.execute('runtime.query', {})).generation) > Number(before.generation));
  await runtime.execute('runtime.subscribe', { event: 'again' }); assert.equal(f.listeners.size, 1);
  runtime.dispose(); assert.equal(f.listeners.size, 0);
});

test('failed native unsubscribe cannot keep delivering stale events and retries remain bounded', async () => {
  const f = new RuntimeFixture(); let fail = true;
  f.scene.off = (event: string) => { if (fail) throw new Error('native off failed'); return f.listeners.delete(event); };
  await f.runtime.execute('runtime.subscribe', { event: 'test' });
  const callback = f.listeners.get('test')!;
  f.runtime.connectionLost(); callback('late');
  assert.deepEqual(Json.object(await f.runtime.execute('runtime.events', {})).rows, []);
  const errors = Json.object(await f.runtime.execute('runtime.query', {})).cleanupErrors as JsonObject[];
  assert.equal(errors[0]!.scope, 'subscriptions');
  fail = false; f.runtime.connectionLost(); assert.equal(f.listeners.size, 0);
  for (let i = 0; i < 128; i++) await f.runtime.execute('runtime.subscribe', { event: `event${i}` });
  await assert.rejects(f.runtime.execute('runtime.subscribe', { event: 'overflow' }), { code: 'RESOURCE_BUSY' });
  f.runtime.dispose(); assert.equal(f.listeners.size, 0);
});

test('partially registered listener remains inert when both registration and compensation fail', async () => {
  const f = new RuntimeFixture();
  f.scene.on = (event: string, callback: (...args: unknown[]) => void) => { f.listeners.set(event, callback); throw new Error('on failed after registration'); };
  f.scene.off = () => { throw new Error('off failed'); };
  await assert.rejects(f.runtime.execute('runtime.subscribe', { event: 'partial' }), { code: 'OUTCOME_UNKNOWN' });
  f.listeners.get('partial')!('unexpected');
  assert.deepEqual(Json.object(await f.runtime.execute('runtime.events', {})).rows, []);
  f.scene.off = (event: string) => f.listeners.delete(event);
  f.runtime.connectionLost(); assert.equal(f.listeners.size, 0);
});
