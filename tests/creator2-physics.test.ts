import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2Features } from '../packages/runtime2-bridge/src/features.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
class PhysicsHarness {
  calls: unknown[][] = [];
  body = { uuid: 'body', kind: 'cc.RigidBody', type: 2, enabled: true, node: { activeInHierarchy: true }, _b2Body: {}, awake: true, linearVelocity: { x: 0, y: 0 }, angularVelocity: 0,
    getMass: () => 1, getWorldCenter: () => ({ x: 0, y: 0 }),
    applyForce: (...args: unknown[]) => { this.calls.push(args); }, applyLinearImpulse: (...args: unknown[]) => { this.calls.push(args); } };
  manager = { enabled: true };
  root = { uuid: 'root', children: [], getComponents: () => [this.body] };
  cc = { ENGINE_VERSION: '2.4.15', RigidBodyType: { Dynamic: 2 }, PhysicsManager: { PTM_RATIO: 32 }, Vec2: class { constructor(public x: number, public y: number) {} },
    director: { getScene: () => this.root, getPhysicsManager: () => this.manager }, js: { getClassName: (v: { kind?: string }) => v.kind ?? 'cc.Node' } };
  features = new Creator2Features(new SceneInspector({ major: 2, cc: this.cc }));
  params = { componentId: 'body', vector: { x: 320, y: 64 }, point: { x: 32, y: 64 }, wake: true };
}
test('Creator 2 force preserves native units and rejects invalid input before applying effects', () => {
  const h = new PhysicsHarness();
  h.features.execute('runtime.rigidbody2d.force', h.params);
  assert.deepEqual(h.calls[0], [new h.cc.Vec2(320, 64), new h.cc.Vec2(32, 64), true]);
  assert.throws(() => h.features.execute('runtime.rigidbody2d.impulse', { ...h.params, point: { x: Infinity, y: 0 } }));
  assert.equal(h.calls.length, 1);
  h.body.type = 0;
  assert.throws(() => h.features.execute('runtime.rigidbody2d.force', h.params), /dynamic/);
  h.body.type = 2; h.manager.enabled = false;
  assert.throws(() => h.features.execute('runtime.rigidbody2d.force', h.params), /initialized/);
  assert.equal(h.calls.length, 1);
});

import { Creator2Joint } from '../packages/runtime2-bridge/src/joint.js';
test('uninitialized joint does not fabricate world anchors or rebuild native constraints', () => {
  let reads = 0;
  const joint = { uuid: 'joint', kind: 'cc.DistanceJoint', node: {}, enabled: true, connectedBody: null,
    getWorldAnchor: () => { reads++; return { x: 0, y: 0 }; }, apply: () => { throw new Error('Must not rebuild'); } };
  const root = { uuid: 'root', children: [], getComponents: () => [joint] };
  const inspector = new SceneInspector({ major: 2, cc: { director: { getScene: () => root }, js: { getClassName: (v: { kind?: string }) => v.kind ?? 'cc.Node' } } });
  joint.node = root;
  const state = new Creator2Joint(inspector).inspect({ componentId: 'joint' });
  assert.equal(state.nativeReady, false); assert.equal(state.worldAnchor, null); assert.equal(reads, 0);
  assert.ok((state.issues as Array<{ code: string }>).some(row => row.code === 'CONNECTED_BODY_MISSING'));
});
test('Creator 2 joint anchor bridge supplies Box2D output vectors and converts meters once', () => {
  const joint = { uuid: 'joint', kind: 'cc.DistanceJoint', node: {}, enabled: true, connectedBody: null,
    _joint: { GetAnchorA: (out: { x: number; y: number }) => { out.x = 2; out.y = 3; }, GetAnchorB: (out: { x: number; y: number }) => { out.x = 4; out.y = 5; } } };
  const root = { uuid: 'root', children: [], getComponents: () => [joint] }; joint.node = root;
  const inspector = new SceneInspector({ major: 2, cc: { PhysicsManager: { PTM_RATIO: 32 }, director: { getScene: () => root }, js: { getClassName: (v: { kind?: string }) => v.kind ?? 'cc.Node' } } });
  const result = new Creator2Joint(inspector).inspect({ componentId: 'joint' });
  assert.deepEqual(result.worldAnchor, { x: 64, y: 96 }); assert.deepEqual(result.worldConnectedAnchor, { x: 128, y: 160 });
});
