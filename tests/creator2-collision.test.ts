import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2Collision } from '../packages/runtime2-bridge/src/collision.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import type { FrameSession } from '../packages/runtime3-bridge/src/frame-session.js';
class CollisionHarness {
  destroyed = 0; unregistered = 0; callbacks: Record<string, Function> = {}; fail = false;
  collider = { uuid: 'collider', kind: 'cc.BoxCollider', enabled: true, node: { uuid: 'root' }, world: { aabb: { x: 0, y: 0, width: 10, height: 10 } } };
  root = { uuid: 'root', activeInHierarchy: true, children: [], getComponents: () => [this.collider], addComponent: () => ({ destroy: () => { this.destroyed++; } }) };
  cc = { Class: (definition: Record<string, Function>) => { this.callbacks = definition; return class {}; }, Component: class {},
    director: { getScene: () => this.root, getCollisionManager: () => ({ enabled: true }) }, game: { collisionMatrix: [[true]], groupList: ['default'] },
    js: { getClassName: (v: { kind?: string }) => v.kind ?? 'cc.Node', unregisterClass: () => { this.unregistered++; } } };
  control = new Creator2Collision(new SceneInspector({ major: 2, cc: this.cc }));
  frames = { token: () => 1, wait: async () => { this.callbacks.onCollisionEnter!({ uuid: 'other', node: { uuid: 'otherNode' } }, this.collider); if (this.fail) throw new Error('frame timeout'); } } as unknown as FrameSession;
}
test('collision trace bounds deliveries and disposes observers without changing collider callbacks', async () => {
  const h = new CollisionHarness();
  const result = await h.control.trace({ rootId: 'root', frames: 3, limit: 1 }, h.frames);
  assert.equal((result.rows as unknown[]).length, 1); assert.equal(result.dropped, 2);
  assert.equal(h.destroyed, 1); assert.equal(h.unregistered, 1);
  h.callbacks.onCollisionEnter!({}, h.collider);
  assert.equal((result.rows as unknown[]).length, 1);
});
test('collision trace cleans owned observers on frame failure', async () => {
  const h = new CollisionHarness(); h.fail = true;
  await assert.rejects(h.control.trace({ rootId: 'root', frames: 3 }, h.frames), /frame timeout/);
  assert.equal(h.destroyed, 1); assert.equal(h.unregistered, 1);
});
