import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2Tween } from '../packages/runtime2-bridge/src/tween.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import type { FrameSession } from '../packages/runtime3-bridge/src/frame-session.js';
class TweenHarness {
  stopped = 0; started = 0;
  node = { uuid: 'root', activeInHierarchy: true, isValid: true, x: 0, y: 0, children: [], getComponents: () => [], stopAllActions: () => { throw new Error('Must preserve business actions'); } };
  cc = { director: { getScene: () => this.node }, tween: () => ({ then() {}, to() {}, by() {}, delay() {}, parallel() {}, union() {}, repeat() {}, call() {}, start: () => { this.started++; }, stop: () => { this.stopped++; } }) };
  control = new Creator2Tween(new SceneInspector({ major: 2, cc: this.cc }));
  params = { nodeId: 'root', steps: [{ action: 'to', duration: 1, properties: { x: 10 } }] };
}
test('tween planning rejects conflicting parallel writes and excessive duration before native effects', () => {
  const h = new TweenHarness(); assert.equal(h.control.plan(h.params).duration, 1);
  assert.throws(() => h.control.plan({ ...h.params, steps: [{ action: 'parallel', steps: [h.params.steps[0]!, h.params.steps[0]!] }] }), /same property/);
  assert.throws(() => h.control.plan({ ...h.params, repeat: 30 }), /repeat/);
  assert.throws(() => h.control.plan({ ...h.params, steps: [{ action: 'to', duration: 1, properties: { constructor: 1 } }] }), /property/);
  assert.equal(h.started, 0);
});
test('tween failure stops only its owned action and allows subsequent acquisition', async () => {
  const h = new TweenHarness();
  const frames = { token: () => 0, wait: async () => { throw new Error('cancelled'); } } as unknown as FrameSession;
  await assert.rejects(h.control.run(h.params, frames, () => {}), /cancelled/);
  await assert.rejects(h.control.run(h.params, frames, () => {}), /cancelled/);
  assert.equal(h.started, 2); assert.equal(h.stopped, 2);
});
