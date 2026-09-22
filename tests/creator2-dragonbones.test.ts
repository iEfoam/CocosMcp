import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2DragonBones } from '../packages/runtime2-bridge/src/dragonbones.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
class DragonBonesHarness {
  reads = 0; cached = false;
  armature = {
    armatureData: { sortedBones: [{ name: 'root', transform: { rotation: 0.5 } }, { name: 'child', parent: { name: 'root' } }], sortedSlots: [{ name: 'body', parent: { name: 'root' }, displayIndex: 0 }] },
    getBone: () => { this.reads++; return { globalTransformMatrix: { a: 1, tx: 12 } }; },
    getSlot: () => { this.reads++; return { displayIndex: 1 }; },
    animation: { getStates: () => { this.reads++; return [{ name: 'walk', currentTime: 0.2, isPlaying: true }]; } },
  };
  component = { uuid: 'dragon', kind: 'dragonBones.ArmatureDisplay', armatureName: 'rig', armature: (): unknown => this.armature, isAnimationCached: () => this.cached };
  root = { uuid: 'root', children: [], getComponents: () => [this.component] };
  control = new Creator2DragonBones(new SceneInspector({ major: 2, cc: { director: { getScene: () => this.root }, js: { getClassName: (v: { kind?: string }) => v.kind ?? 'cc.Node' } } }));
}
test('DragonBones separates setup, evaluated matrices and bounded animation state', () => {
  const h = new DragonBonesHarness(); const result = h.control.details({ componentId: 'dragon', limit: 1 });
  assert.equal(result.truncated, true); assert.equal(result.livePoseAvailable, true);
  assert.deepEqual((result.states as Array<Record<string, unknown>>)[0]?.name, 'walk');
  assert.equal((result.bones as Array<Record<string, any>>)[0]?.pose.tx, 12);
  assert.equal((result.slots as Array<Record<string, unknown>>)[0]?.displayIndex, 1);
});
test('cached DragonBones never queries shared pose or animation state', () => {
  const h = new DragonBonesHarness(); h.cached = true;
  const result = h.control.details({ componentId: 'dragon' });
  assert.equal(h.reads, 0); assert.equal(result.states, null); assert.equal(result.livePoseAvailable, false);
  for (const bone of result.bones as Array<Record<string, unknown>>) assert.equal(bone.pose, null);
  for (const slot of result.slots as Array<Record<string, unknown>>) assert.equal(slot.displayIndex, null);
});
test('DragonBones rejects invalid limits, wrong type and uninitialized armature', () => {
  const h = new DragonBonesHarness();
  for (const limit of [0, 1001, 1.5, Infinity]) assert.throws(() => h.control.details({ componentId: 'dragon', limit }), /limit/);
  assert.equal(h.reads, 0);
  h.component.kind = 'cc.Node'; assert.throws(() => h.control.details({ componentId: 'dragon' }), /Expected/);
  h.component.kind = 'dragonBones.ArmatureDisplay'; h.component.armature = () => null;
  assert.throws(() => h.control.details({ componentId: 'dragon' }), /not initialized/);
});
