import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2PhysicsContact } from '../packages/runtime2-bridge/src/physics-contact.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import type { FrameSession } from '../packages/runtime3-bridge/src/frame-session.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
class ContactHarness {
  destroyed = 0; unregistered = 0; impulseReads = 0; fail = false; failCleanup = false;
  callbacks: Record<string, (...args: unknown[]) => void> = {};
  body = { uuid: 'body', kind: 'cc.RigidBody', enabled: true, enabledContactListener: true, _b2Body: {}, node: {} };
  root = { uuid: 'root', activeInHierarchy: true, children: [], getComponents: () => [this.body], addComponent: () => ({ destroy: () => { this.destroyed++; if (this.failCleanup) throw new Error('cleanup'); } }) };
  manifold = { normal: { x: 0, y: 1 }, points: [{ x: 10, y: 20 }], separations: [-1] };
  impulse = { normalImpulses: [64], tangentImpulses: [3] };
  contact = { getWorldManifold: () => this.manifold, getImpulse: () => { this.impulseReads++; return this.impulse; }, disabled: false };
  self = { uuid: 'self', body: this.body };
  other = { uuid: 'other', body: this.body };
  cc = { Class: (definition: Record<string, (...args: unknown[]) => void>) => { this.callbacks = definition; return class {}; }, Component: class {}, PhysicsManager: { PTM_RATIO: 32 },
    director: { getScene: () => this.root, getPhysicsManager: () => ({ enabled: true }) }, js: { getClassName: (v: { kind?: string }) => v.kind ?? 'cc.Node', unregisterClass: () => { this.unregistered++; } } };
  control: Creator2PhysicsContact;
  constructor() { this.body.node = this.root; this.control = new Creator2PhysicsContact(new SceneInspector({ major: 2, cc: this.cc })); }
  frames = { token: () => 0, wait: async () => {
    this.callbacks.onBeginContact!(this.contact, this.self, this.other); this.callbacks.onPostSolve!(this.contact, this.self, this.other);
    if (this.manifold.points[0]) this.manifold.points[0].x = 99;
    this.impulse.normalImpulses[0] = 128;
    if (this.fail) throw new Error('frame failure');
  } } as unknown as FrameSession;
}
test('Box2D trace copies transient contact data and normalizes asymmetric native impulse units only in postSolve', async () => {
  const h = new ContactHarness(); const result = await h.control.trace({ rootId: 'root', frames: 1 }, h.frames, () => {});
  const rows = result.rows as JsonObject[];
  assert.equal(rows[0]!.impulse, null); assert.deepEqual(rows[1]!.impulse, { normal: [2], tangent: [3] });
  assert.equal((Json.object(rows[1]!.manifold).points as JsonObject[])[0]!.x, 10); assert.equal(h.impulseReads, 1);
  assert.equal(h.destroyed, 1); assert.equal(h.unregistered, 1); assert.equal(h.body.enabledContactListener, true);
  h.callbacks.onBeginContact!({}, h.self, h.other); assert.equal(rows.length, 2);
});
test('Box2D empty manifold discards pooled normals and cancellation progress retains units', async () => {
  const h = new ContactHarness(); h.manifold.points = []; h.manifold.separations = []; h.manifold.normal.x = NaN;
  let progress: JsonObject = {};
  const result = await h.control.trace({ rootId: 'root', frames: 1 }, h.frames, value => { progress = value; });
  for (const row of result.rows as JsonObject[]) assert.deepEqual(row.manifold, { points: [], separations: [], normal: null });
  assert.equal(progress.impulseUnits, 'Box2D-native-impulse'); assert.equal(progress.ptmRatio, 32);
  assert.equal(progress.coordinateSpace, 'world-pixels'); assert.equal(progress.receiverBodies, 1);
});
test('Box2D invalid native contact data fails without throwing into business callbacks and cleans observers', async () => {
  for (const invalid of ['vector', 'impulse', 'oversize', 'mismatched']) {
    const h = new ContactHarness();
    if (invalid === 'vector') h.manifold.points[0]!.x = Infinity;
    if (invalid === 'impulse') h.impulse.normalImpulses[0] = NaN;
    if (invalid === 'oversize') h.manifold.points.push({ x: 0, y: 0 }, { x: 0, y: 0 });
    if (invalid === 'mismatched') h.impulse.tangentImpulses = [];
    await assert.rejects(h.control.trace({ rootId: 'root', frames: 1 }, h.frames, () => {}), /capture failed/);
    assert.equal(h.destroyed, 1); assert.equal(h.unregistered, 1);
  }
});
test('Box2D trace bounds callbacks, rejects disabled receivers and cleans cancellation', async () => {
  const h = new ContactHarness(); h.body.enabledContactListener = false;
  await assert.rejects(h.control.trace({ rootId: 'root', frames: 1 }, h.frames, () => {}), /enabledContactListener/); assert.equal(h.destroyed, 0);
  h.body.enabledContactListener = true; const result = await h.control.trace({ rootId: 'root', frames: 2, limit: 1 }, h.frames, () => {});
  assert.equal((result.rows as unknown[]).length, 1); assert.equal(result.dropped, 3);
  h.fail = true; await assert.rejects(h.control.trace({ rootId: 'root', frames: 1 }, h.frames, () => {}), /frame failure/); assert.equal(h.destroyed, 2);
});
test('Box2D trace exposes cleanup failure and stops recording', async () => {
  const h = new ContactHarness(); h.failCleanup = true; let rows: unknown[] = [];
  await assert.rejects(h.control.trace({ rootId: 'root', frames: 1 }, h.frames, p => { rows = p.rows as unknown[]; }), /cleanup failed/);
  const size = rows.length; h.callbacks.onPostSolve!(h.contact, h.self, h.other); assert.equal(rows.length, size); assert.equal(h.unregistered, 1);
});
