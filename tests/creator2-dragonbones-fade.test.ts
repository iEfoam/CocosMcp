import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2DragonBonesFade } from '../packages/runtime2-bridge/src/dragonbones-fade.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import type { JsonObject } from '../packages/contracts/src/index.js';
class FadeHarness {
  writes = 0; cached = false; fail = false; states: JsonObject[] = [];
  animation = { animationNames: ['walk', 'run'], getStates: () => this.states,
    fadeIn: (name: string, duration: number, playTimes: number, layer: number, group: string, mode: number) => {
      this.writes++;
      if (mode === 5) { const existing = this.states.find(state => state.name === name); if (existing) return existing; }
      const state = { name, fadeTotalTime: duration, playTimes, layer, group };
      this.states.push(state); if (this.fail) throw new Error('partial fade'); return state;
    },
  };
  component = { uuid: 'dragon', kind: 'dragonBones.ArmatureDisplay', isAnimationCached: () => this.cached, armature: () => ({ animation: this.animation }) };
  root = { uuid: 'root', children: [], getComponents: () => [this.component] };
  control = new Creator2DragonBonesFade(new SceneInspector({ major: 2, cc: { director: { getScene: () => this.root }, js: { getClassName: (v: { kind?: string }) => v.kind ?? 'cc.Node' } } }));
  fade(params: JsonObject = {}): JsonObject { return this.control.fade({ componentId: 'dragon', name: 'walk', duration: 0.5, ...params }); }
}
test('DragonBones fade snapshots mutable native arrays and reports single-mode reuse without inventing values', () => {
  const h = new FadeHarness(); const first = h.fade({ group: 'base', layer: 2 });
  assert.equal((first.before as unknown[]).length, 0); assert.equal(first.reused, false);
  assert.equal((first.after as unknown[]).length, 1);
  const reused = h.fade({ fadeOutMode: 'single', group: 'other', layer: 4, duration: 1 });
  assert.equal(reused.reused, true); assert.equal((reused.selected as JsonObject).group, 'base'); assert.equal((reused.selected as JsonObject).fadeTotalTime, 0.5);
});
test('DragonBones fade validates names, bounds, mode and cache before any native writes', () => {
  const h = new FadeHarness();
  for (const params of [{ duration: NaN }, { duration: -1 }, { duration: 31 }, { layer: 32 }, { layer: 1.5 }, { group: 'x'.repeat(65) }, { playTimes: -1 }, { fadeOutMode: 'bad' }]) assert.throws(() => h.fade(params), /Invalid/);
  assert.throws(() => h.fade({ name: '__proto__' }), /not found/);
  h.cached = true; assert.throws(() => h.fade(), /realtime/); h.cached = false;
  h.states = Array.from({ length: 32 }, () => ({ name: 'walk' })); assert.throws(() => h.fade(), /32/); assert.equal(h.writes, 0);
});
test('DragonBones fade reports uncertain partial mutation and preserves its before snapshot', () => {
  const h = new FadeHarness(); h.fail = true;
  assert.throws(() => h.fade(), /fade or readback failed/); assert.equal(h.states.length, 1);
});
