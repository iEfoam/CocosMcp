import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2SpineCachedEvents } from '../packages/runtime2-bridge/src/spine-cached-events.js';
import type { RuntimeObject } from '../packages/runtime3-bridge/src/access.js';
import type { FrameSession } from '../packages/runtime3-bridge/src/frame-session.js';
class CachedEventsHarness {
  business = 0; receivers: unknown[] = [];
  original = (..._args: unknown[]) => { this.business++; return 'business-result'; };
  owner: RuntimeObject = { start: null, complete: this.original, end: null };
  component: RuntimeObject = { _listener: this.owner, _cacheMode: 1, isValid: true, _ensureListener: () => {} };
  control = new Creator2SpineCachedEvents();
  frames(run: () => void): FrameSession { return { token: () => 0, wait: async () => run() } as unknown as FrameSession; }
  emit(): unknown { return (this.owner.complete as (entry: unknown) => unknown).call(this.owner, { animation: { name: 'walk' }, trackIndex: 0 }); }
}
test('cached Spine forwards native callback arguments, receiver and return value and restores identity', async () => {
  const h = new CachedEventsHarness(); let receiver: unknown, argument: unknown;
  const original = function (this: unknown, entry: unknown) { receiver = this; argument = entry; return 7; }; h.owner.complete = original;
  const result = await h.control.trace(h.component, ['complete'], 2, 1, h.frames(() => assert.equal(h.emit(), 7)), () => {});
  assert.equal(receiver, h.owner); assert.ok(argument); assert.equal(h.owner.complete, original); assert.equal(result.dropped, 1);
  assert.deepEqual((result.rows as Array<Record<string, unknown>>)[0]!.trackTime, null);
});
test('cached Spine preserves replacement callbacks and rejects concurrent ownership', async () => {
  const h = new CachedEventsHarness(); const replacement = () => {};
  await assert.rejects(h.control.trace(h.component, ['complete'], 1, 10, h.frames(() => {
    h.owner.complete = replacement;
  }), () => {}), /callback changed/);
  assert.equal(h.owner.complete, replacement);
  let release!: () => void;
  const pending = h.control.trace(h.component, ['complete'], 1, 10, { token: () => 0, wait: () => new Promise<void>(resolve => { release = resolve; }) } as unknown as FrameSession, () => {});
  await assert.rejects(h.control.trace(h.component, ['complete'], 1, 10, h.frames(() => {}), () => {}), /already has/);
  release(); await pending; assert.equal(h.owner.complete, replacement);
});
test('cached Spine cancellation restores callbacks, preserves business exceptions and retains failed-cleanup lock', async () => {
  const h = new CachedEventsHarness();
  await assert.rejects(h.control.trace(h.component, ['complete'], 1, 10, h.frames(() => { throw new Error('cancel'); }), () => {}), /cancel/);
  assert.equal(h.owner.complete, h.original);
  const failure = () => { throw new Error('business failed'); }; h.owner.complete = failure;
  await assert.rejects(h.control.trace(h.component, ['complete'], 1, 10, h.frames(() => { h.emit(); }), () => {}), /business failed/);
  assert.equal(h.owner.complete, failure); h.owner.complete = h.original;
  let rows: unknown[] = [];
  await assert.rejects(h.control.trace(h.component, ['complete'], 1, 10, h.frames(() => { h.emit(); Object.freeze(h.owner); }), p => { rows = p.rows as unknown[]; }), /restoration failed/);
  assert.equal(rows.length, 1); h.emit(); assert.equal(rows.length, 1);
  await assert.rejects(h.control.trace(h.component, ['complete'], 1, 10, h.frames(() => {}), () => {}), /already has/);
});
