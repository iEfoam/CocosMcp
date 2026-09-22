import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2DragonBonesEvents } from '../packages/runtime2-bridge/src/dragonbones-events.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import type { FrameSession } from '../packages/runtime3-bridge/src/frame-session.js';
class EventsHarness {
  callbacks = new Map<string, Set<(value?: unknown) => void>>(); cached = false; failRemoval = false;
  component = { uuid: 'dragon', kind: 'dragonBones.ArmatureDisplay', _cacheMode: 0, isValid: true,
    isAnimationCached: () => this.cached,
    addEventListener: (event: string, callback: (value?: unknown) => void) => { if (!this.callbacks.has(event)) this.callbacks.set(event, new Set()); this.callbacks.get(event)!.add(callback); },
    removeEventListener: (event: string, callback: (value?: unknown) => void) => { if (this.failRemoval) throw new Error('remove failed'); this.callbacks.get(event)?.delete(callback); },
  };
  root = { uuid: 'root', children: [], getComponents: () => [this.component] };
  control = new Creator2DragonBonesEvents(new SceneInspector({ major: 2, cc: { director: { getScene: () => this.root }, js: { getClassName: (v: { kind?: string }) => v.kind ?? 'cc.Node' } } }));
  emit(event: string, value?: unknown): void { for (const callback of this.callbacks.get(event) ?? []) callback(value); }
  frames(run: () => void): FrameSession { return { token: () => 0, wait: async () => run() } as unknown as FrameSession; }
}
test('DragonBones trace copies pooled payloads, bounds records and preserves business listeners', async () => {
  const h = new EventsHarness(); let business = 0;
  h.component.addEventListener('start', () => business++);
  const payload = { name: 'event', animationState: { name: 'walk', currentTime: 0.2 } };
  const result = await h.control.trace({ componentId: 'dragon', frames: 2, limit: 1 }, h.frames(() => { h.emit('start', payload); payload.animationState.name = 'recycled'; }), () => {});
  assert.equal(result.dropped, 1); assert.equal((result.rows as Array<Record<string, unknown>>)[0]!.animation, 'walk');
  assert.equal(h.callbacks.get('start')!.size, 1); assert.equal(business, 2);
  h.emit('start'); assert.equal(business, 3);
});
test('cached DragonBones trace reports absent payload and rejects unsupported events before registration', async () => {
  const h = new EventsHarness(); h.cached = true;
  await assert.rejects(h.control.trace({ componentId: 'dragon', events: ['frameEvent'] }, h.frames(() => {}), () => {}), /only emits/);
  assert.equal(h.callbacks.size, 0);
  const result = await h.control.trace({ componentId: 'dragon', frames: 1 }, h.frames(() => h.emit('complete')), () => {});
  const row = (result.rows as Array<Record<string, unknown>>)[0]!;
  assert.equal(row.animation, null); assert.equal(row.hasNativePayload, false);
});
test('DragonBones trace copies and bounds pooled custom UserData', async () => {
  const h = new EventsHarness(); const data = { ints: [7], floats: [1.25], strings: ['custom'] };
  const result = await h.control.trace({ componentId: 'dragon', frames: 1, events: ['frameEvent'] }, h.frames(() => {
    h.emit('frameEvent', { name: 'marker', data }); data.ints[0] = 99; data.strings[0] = 'recycled';
    h.emit('frameEvent', { data: { ints: Array(9).fill(1), strings: ['x'.repeat(257)] } });
  }), () => {});
  const rows = result.rows as Array<Record<string, unknown>>;
  assert.deepEqual(rows[0]!.payload, { ints: [7], floats: [1.25], strings: ['custom'], truncated: false });
  const payload = rows[1]!.payload as Record<string, unknown>;
  assert.equal(payload.truncated, true); assert.equal((payload.ints as unknown[]).length, 8); assert.equal((payload.strings as string[])[0]!.length, 256);
});
test('DragonBones trace cleans up cancellation and mode changes, leaves failed cleanup callbacks inert', async () => {
  const h = new EventsHarness();
  await assert.rejects(h.control.trace({ componentId: 'dragon' }, h.frames(() => { throw new Error('cancel'); }), () => {}), /cancel/);
  assert.ok([...h.callbacks.values()].every(set => set.size === 0));
  await assert.rejects(h.control.trace({ componentId: 'dragon' }, h.frames(() => { h.component._cacheMode = 1; }), () => {}), /mode changed/);
  assert.ok([...h.callbacks.values()].every(set => set.size === 0));
  h.failRemoval = true; let progress: Record<string, unknown> = {};
  await assert.rejects(h.control.trace({ componentId: 'dragon', frames: 1 }, h.frames(() => h.emit('start')), p => { progress = p; }), /cleanup failed/);
  const rows = progress.rows as unknown[]; assert.equal(rows.length, 1); h.emit('start'); assert.equal(rows.length, 1);
});
