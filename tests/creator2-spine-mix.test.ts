import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2SpineMix } from '../packages/runtime2-bridge/src/spine-mix.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import type { JsonObject } from '../packages/contracts/src/index.js';
class MixHarness {
  writes = 0; cached = false; fail = false;
  animations = ['walk', 'run']; table: Record<string, number> = {};
  data = { defaultMix: 0.1, animationToMixTime: this.table,
    skeletonData: { animations: this.animations.map(name => ({ name })), findAnimation: (name: string) => this.data.skeletonData.animations.find(row => row.name === name) },
    getMix: (from: { name: string }, to: { name: string }) => this.table[from.name + '.' + to.name] ?? this.data.defaultMix,
  };
  state = { data: this.data };
  component = { uuid: 'spine', kind: 'sp.Skeleton', isAnimationCached: () => this.cached, getState: () => this.state,
    setMix: (from: string, to: string, duration: number) => { this.writes++; this.table[from + '.' + to] = duration; if (this.fail) throw new Error('native failure after write'); },
  };
  root = { uuid: 'root', children: [], getComponents: () => [this.component] };
  control = new Creator2SpineMix(new SceneInspector({ major: 2, cc: { director: { getScene: () => this.root }, js: { getClassName: (v: { kind?: string }) => v.kind ?? 'cc.Node' } } }));
  expected(): JsonObject { const result = this.control.execute({ componentId: 'spine', from: 'walk', to: 'run' }, false); return { duration: result.duration!, defaultDuration: result.defaultDuration!, overrideDuration: result.overrideDuration! }; }
  update(duration: number | null, expected = this.expected()): JsonObject { return this.control.execute({ componentId: 'spine', from: 'walk', to: 'run', duration, expected }, true); }
}
test('Spine mix native update and removal preserve default inheritance and unrelated pairs', () => {
  const h = new MixHarness(); h.table['run.walk'] = 0.7;
  assert.equal(h.expected().overrideDuration, null);
  const changed = h.update(0.5); assert.deepEqual(changed.after, { duration: 0.5, defaultDuration: 0.1, overrideDuration: 0.5 });
  h.update(null); assert.equal(Object.hasOwn(h.table, 'walk.run'), false);
  h.data.defaultMix = 0.3; assert.equal(h.expected().duration, 0.3); assert.equal(h.table['run.walk'], 0.7);
});
test('Spine mix rejects stale expected state, invalid values, missing animations and cache mode without writes', () => {
  const h = new MixHarness(), before = h.expected(); h.data.defaultMix = 0.2;
  assert.throws(() => h.update(0.5, before), /changed since/);
  for (const duration of [-1, 31, NaN, Infinity]) assert.throws(() => h.update(duration), /0..30/);
  assert.throws(() => h.control.execute({ componentId: 'spine', from: 'missing', to: 'run' }, false), /not found/);
  h.cached = true; assert.throws(() => h.expected(), /realtime/); assert.equal(h.writes, 0);
});
test('Spine mix rejects native dotted-name key collisions and reports partially applied errors', () => {
  const h = new MixHarness(); h.data.skeletonData.animations = ['a.b', 'c', 'a', 'b.c'].map(name => ({ name }));
  assert.throws(() => h.control.execute({ componentId: 'spine', from: 'a.b', to: 'c' }, false), /ambiguous/); assert.equal(h.writes, 0);
  h.data.skeletonData.animations = ['walk', 'run'].map(name => ({ name })); h.fail = true;
  assert.throws(() => h.update(0.5), /update or verification failed/); assert.equal(h.table['walk.run'], 0.5);
});
