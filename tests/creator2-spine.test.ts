import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2Spine } from '../packages/runtime2-bridge/src/spine.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
class SpineHarness {
  reads = 0; cached = false;
  component = { uuid: 'spine', kind: 'sp.Skeleton', _cacheMode: 0,
    skeletonData: { getRuntimeData: () => ({ bones: [{ name: 'root', x: 0 }, { name: 'child', parent: { name: 'root' } }], slots: [{ name: 'body', boneData: { name: 'root' }, attachmentName: 'skin' }] }) },
    isAnimationCached: () => this.cached,
    findBone: () => { this.reads++; return { x: 1, worldX: 2 }; },
    findSlot: () => { this.reads++; return { attachment: { name: 'current', kind: 'RegionAttachment' } }; },
    getState: () => { this.reads++; return { tracks: [null, { animation: { name: 'walk' }, trackTime: 0.5, next: { animation: { name: 'run' } } }] }; } };
  root = { uuid: 'root', children: [], getComponents: () => [this.component] };
  control = new Creator2Spine(new SceneInspector({ major: 2, cc: { director: { getScene: () => this.root }, js: { getClassName: (v: { kind?: string }) => v.kind ?? 'cc.Node' } } }));
}
test('Spine diagnostics separate setup, live pose, sparse tracks and explicit truncation', () => {
  const h = new SpineHarness(); const result = h.control.details({ componentId: 'spine', limit: 1 });
  assert.equal(result.truncated, true); assert.equal(result.livePoseAvailable, true); assert.equal(result.trackStateAvailable, true);
  const tracks = result.tracks as Array<Record<string, unknown>>;
  assert.equal(tracks[0]!.active, false); assert.equal(tracks[1]!.animation, 'walk'); assert.equal(tracks[1]!.queuedAnimation, 'run');
});
test('cached Spine mode never exposes shared skeleton pose or stale realtime tracks', () => {
  const h = new SpineHarness(); h.cached = true; h.component._cacheMode = 1;
  const result = h.control.details({ componentId: 'spine' });
  assert.equal(h.reads, 0); assert.equal(result.tracks, null); assert.equal(result.livePoseAvailable, false);
  for (const bone of result.bones as Array<Record<string, unknown>>) assert.equal(bone.pose, null);
  assert.throws(() => h.control.details({ componentId: 'spine', limit: 0 }), /limit/);
});
