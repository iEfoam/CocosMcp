import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2SpineEvents } from '../packages/runtime2-bridge/src/spine-events.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import type { FrameSession } from '../packages/runtime3-bridge/src/frame-session.js';
type Listener = Record<string, (...args: unknown[]) => void>;
class SpineEventsHarness {
  cached = false; failAdd = false; retainListener = false;
  state = { listeners: [] as Listener[],
    addListener: (listener: Listener) => { this.state.listeners.push(listener); if (this.failAdd) throw new Error('partial registration'); },
    removeListener: (listener: Listener) => { if (!this.retainListener) this.state.listeners = this.state.listeners.filter(row => row !== listener); },
  };
  component = { uuid: 'spine', kind: 'sp.Skeleton', isValid: true, isAnimationCached: () => this.cached, getState: () => this.state };
  root = { uuid: 'root', children: [], getComponents: () => [this.component] };
  control = new Creator2SpineEvents(new SceneInspector({ major: 2, cc: { director: { getScene: () => this.root }, js: { getClassName: (v: { kind?: string }) => v.kind ?? 'cc.Node' } } }));
  emit(event: string, entry: unknown, data?: unknown): void { for (const listener of this.state.listeners) listener[event]?.(entry, data); }
  frames(run: () => void): FrameSession { return { token: () => 0, wait: async () => run() } as unknown as FrameSession; }
}
test('Spine trace copies pooled event and track data, bounds records and preserves business listeners', async () => {
  const h = new SpineEventsHarness(); let business = 0;
  const listener = { event: () => business++ }; h.state.addListener(listener);
  const entry = { animation: { name: 'walk' }, trackTime: 0.2, trackIndex: 0 }, data = { data: { name: 'footstep' }, stringValue: 'left' };
  const result = await h.control.trace({ componentId: 'spine', frames: 2, limit: 1 }, h.frames(() => { h.emit('event', entry, data); entry.animation.name = 'recycled'; data.stringValue = 'changed'; }), () => {});
  assert.equal(result.dropped, 1); const row = (result.rows as Array<Record<string, unknown>>)[0]!;
  assert.equal(row.animation, 'walk'); assert.equal((row.payload as Record<string, unknown>).stringValue, 'left');
  assert.deepEqual(h.state.listeners, [listener]); assert.equal(business, 2);
});
test('Spine trace rejects cached mode and cleans up cancellation, target destruction and state changes', async () => {
  const h = new SpineEventsHarness(); h.cached = true;
  await assert.rejects(h.control.trace({ componentId: 'spine', events: ['event'] }, h.frames(() => {}), () => {}), /only emits/);
  assert.equal(h.state.listeners.length, 0); h.cached = false;
  await assert.rejects(h.control.trace({ componentId: 'spine' }, h.frames(() => { throw new Error('cancel'); }), () => {}), /cancel/);
  assert.equal(h.state.listeners.length, 0);
  await assert.rejects(h.control.trace({ componentId: 'spine' }, h.frames(() => { h.cached = true; }), () => {}), /state changed/);
  assert.equal(h.state.listeners.length, 0); h.cached = false;
  await assert.rejects(h.control.trace({ componentId: 'spine' }, h.frames(() => { h.component.isValid = false; }), () => {}), /destroyed/);
  assert.equal(h.state.listeners.length, 0);
});
test('Spine trace compensates partial registration and makes unsuccessful removal visible and inert', async () => {
  const h = new SpineEventsHarness(); h.failAdd = true;
  await assert.rejects(h.control.trace({ componentId: 'spine' }, h.frames(() => {}), () => {}), /partial registration/);
  assert.equal(h.state.listeners.length, 0); h.failAdd = false; h.retainListener = true;
  let rows: unknown[] = [];
  await assert.rejects(h.control.trace({ componentId: 'spine', frames: 1 }, h.frames(() => h.emit('start', {})), p => { rows = p.rows as unknown[]; }), /cleanup failed/);
  assert.equal(rows.length, 1); h.emit('start', {}); assert.equal(rows.length, 1);
});
