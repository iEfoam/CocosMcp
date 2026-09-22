import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeTaskSessions } from '../packages/runtime3-bridge/src/task-session.js';
import { CocosError } from '../packages/contracts/src/index.js';

class TaskHarness {
  callbacks = new Set<() => void>();
  scene = {};
  cc = { Director: { EVENT_AFTER_DRAW: 'draw' }, director: {
    getScene: () => this.scene,
    on: (_event: string, callback: () => void) => this.callbacks.add(callback),
    off: (_event: string, callback: () => void) => this.callbacks.delete(callback),
  } };
  tasks = new RuntimeTaskSessions(this.cc);
}
test('runtime tasks return immediately, retain progress and cancel independently with cleanup', async () => {
  const h = new TaskHarness(); let cleaned = 0;
  const work = () => h.tasks.start(async (frames, progress) => {
    try { progress({ ready: true }); await frames.wait(frames.token()); return { finished: true }; }
    finally { cleaned++; }
  });
  const first = work(), second = work();
  await Promise.resolve();
  assert.equal(h.callbacks.size, 2); assert.deepEqual(h.tasks.poll(first).progress, { ready: true });
  assert.equal((await h.tasks.stop(first)).status, 'cancelled');
  assert.equal(cleaned, 1); assert.equal(h.callbacks.size, 1);
  for (const callback of h.callbacks) callback();
  assert.equal((await h.tasks.stop(second)).status, 'completed');
  assert.equal(cleaned, 2); assert.equal(h.callbacks.size, 0);
  assert.equal((await h.tasks.stop(first)).status, 'cancelled');
});
test('runtime task cancellation never hides cleanup failure and disposal expires IDs', async () => {
  const h = new TaskHarness();
  const started = h.tasks.start(async frames => {
    try { await frames.wait(frames.token()); return {}; }
    finally { throw new CocosError('OUTCOME_UNKNOWN', 'observer cleanup failed'); }
  });
  await Promise.resolve();
  assert.equal((await h.tasks.stop(started)).status, 'failed');
  const active = h.tasks.start(async frames => { await frames.wait(frames.token()); return {}; });
  await Promise.resolve(); h.tasks.dispose(); await Promise.resolve();
  assert.equal(h.callbacks.size, 0);
  assert.throws(() => h.tasks.poll(active), /expired/);
});
test('runtime task quotas bound concurrent work and retained results', async () => {
  const h = new TaskHarness();
  const running = Array.from({ length: 4 }, () => h.tasks.start(async frames => { await frames.wait(frames.token()); return {}; }));
  assert.throws(() => h.tasks.start(async () => ({})), /four/);
  for (const task of running) await h.tasks.stop(task);
  for (let index = 0; index < 8; index++) {
    const task = h.tasks.start(async () => ({})); await Promise.resolve(); await h.tasks.stop(task);
  }
  assert.throws(() => h.tasks.poll(running[0]!), /expired/);
});

for (const cleanupFails of [false, true]) test(`runtime deadline survives stop race and preserves cleanup failure=${cleanupFails}`, async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = new TaskHarness(); let cleaned = false;
  const task = h.tasks.start(async frames => {
    try { const token = frames.token(); for (let frame = 0; frame < 100; frame++) await frames.wait(token); return {}; }
    finally { cleaned = true; if (cleanupFails) throw new CocosError('OUTCOME_UNKNOWN', 'deadline cleanup failed'); }
  });
  await Promise.resolve();
  // 每秒完成一帧，保证测试触发总时限而非单帧等待的两秒时限。
  for (let second = 0; second < 29; second++) {
    context.mock.timers.tick(1000);
    for (const callback of [...h.callbacks]) callback();
    await Promise.resolve();
  }
  context.mock.timers.tick(1000);
  const result = await h.tasks.stop(task);
  assert.equal(result.status, 'failed'); assert.equal(cleaned, true); assert.equal(h.callbacks.size, 0);
  assert.equal((result.error as { code: string }).code, cleanupFails ? 'OUTCOME_UNKNOWN' : 'CONTEXT_UNAVAILABLE');
});
