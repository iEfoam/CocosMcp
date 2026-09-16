import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { TwoDClipModel } from '../packages/animation-core/src/two-d.js';
import { TwoDPlanning } from '../packages/gameplay2d-core/src/planning.js';
import { GameplayTemplates } from '../packages/gameplay2d-core/src/templates.js';
import { PhysicsQueries } from '../packages/runtime3-bridge/src/physics.js';
import { TwoDControl } from '../packages/runtime3-bridge/src/two-d-control.js';
import { TwoDInspector } from '../packages/runtime3-bridge/src/two-d-inspector.js';
import { FrameSession } from '../packages/runtime3-bridge/src/frame-session.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
import { TwoDProduction } from '../packages/creator3-adapter/src/two-d-production.js';
import { PreviewService } from '../packages/creator3-adapter/src/preview.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';

test('2D catalog validates bounded gestures, production schemas and Creator 3-only support', () => {
  const catalog = new CapabilityCatalog();
  catalog.validate('preview.input', { action: 'drag', x: 5, y: 5, endX: 50, endY: 80, durationMs: 100 });
  catalog.validate('animation2d.plan', { rootId: 'root', url: 'db://assets/test.anim', document: { name: 'Walk', duration: 1, tracks: [{ path: '', kind: 'spriteFrame', keys: [{ time: 0, value: 'frame' }] }] } });
  assert.throws(() => catalog.validate('preview.input', { action: 'key', x: 0, y: 0, key: 'F12' }));
  assert.throws(() => catalog.validate('spriteframe.plan', { url: 'x', settings: { uuid: 'overwrite' } }));
  assert.deepEqual(catalog.describe('gameplay2d.apply').supportedMajors, [3]);
});
test('2D animation rejects duplicate bindings, traversal, non-discrete SpriteFrames and invalid times', () => {
  const model = new TwoDClipModel(), track = { path: '', kind: 'spriteFrame', keys: [{ time: 0, value: 'uuid' }] };
  const document = { name: 'Run', duration: 1, tracks: [track] };
  assert.equal(model.parse(document).tracks.length, 1);
  assert.equal(model.parse({ ...document, events: [{ time: 0.5, method: 'attack', params: ['left'] }] }).events?.length, 1);
  assert.throws(() => model.parse({ ...document, events: [{ time: 0.5, method: 'onDestroy' }] }));
  assert.throws(() => model.parse({ ...document, events: [{ time: 2, method: 'attack' }] }));
  for (const tracks of [[track, track], [{ ...track, path: '../Player' }], [{ ...track, keys: [{ time: 0, value: 'uuid', interpolation: 'linear' }] }], [{ ...track, keys: [{ time: 2, value: 'uuid' }] }]]) assert.throws(() => model.parse({ ...document, tracks }), { code: 'INVALID_ARGUMENT' });
});
test('level layouts are reproducible and grid routes cannot cross blocked cells or wrap rows', () => {
  const planner = new TwoDPlanning(), params = { name: 'Coin', count: 10, columns: 4, spacing: 32, seed: 8, jitter: 5 };
  assert.deepEqual(planner.layout(params), planner.layout(params));
  assert.notDeepEqual(planner.layout(params), planner.layout({ ...params, seed: 9 }));
  assert.throws(() => planner.layout({ ...params, jitter: 20 }));
  const path = planner.path({ width: 3, height: 2, start: { x: 0, y: 0 }, end: { x: 2, y: 0 }, blocked: [{ x: 1, y: 0 }] });
  assert.equal(path.reached, true); assert.equal((path.rows as unknown[]).length, 5);
  assert.equal(planner.path({ width: 3, height: 2, start: { x: 0, y: 0 }, end: { x: 2, y: 0 }, blocked: [{ x: 1, y: 0 }, { x: 1, y: 1 }] }).reached, false);
});
test('UI recipes validate through existing document model and script templates reject source injection', () => {
  for (const kind of ['menu', 'inventory', 'hud', 'dialogue']) assert.ok(new TwoDPlanning().ui({ kind, name: 'Example' }).root.children?.length);
  assert.throws(() => new GameplayTemplates().source('camera', "Bad');eval('x"));
  assert.throws(() => new GameplayTemplates().source('__proto__', 'Example'));
});
test('point queries detach pooled collider arrays and deduplicate native fixtures', () => {
  class Vec { constructor(public x: number, public y: number) {} }
  const collider = { uuid: 'c', node: { uuid: 'n' } }, rows = [collider, collider];
  const physics = new PhysicsQueries({ Vec2: Vec, PhysicsSystem2D: { instance: { testPoint: () => rows } } });
  const result = Json.object(physics.execute('runtime.physics2d.test_point', { point: { x: 2, y: 3 } }));
  rows.length = 0; assert.deepEqual(result.rows, [{ colliderId: 'c', nodeId: 'n' }]);
});
test('Creator 3.8.8 empty JS Box2D world avoids the native null-stack exception without hiding errors', () => {
  class Vec { constructor(public x: number, public y: number) {} }
  let count = 0;
  const system = { physicsWorld: { impl: { GetProxyCount: () => count } }, testPoint: () => { throw new Error('native fault'); }, testAABB: () => { throw new Error('native fault'); } };
  const physics = new PhysicsQueries({ VERSION: '3.8.8', Vec2: Vec, PhysicsSystem2D: { PHYSICS_BOX2D: true, instance: system } });
  assert.equal(Json.object(physics.execute('runtime.physics2d.test_point', { point: { x: 0, y: 0 } })).total, 0);
  assert.equal(Json.object(physics.execute('runtime.physics2d.test_aabb', { x: 0, y: 0, width: 1, height: 1 })).total, 0);
  assert.throws(() => physics.execute('runtime.physics2d.test_point', { point: { x: NaN, y: 0 } }));
  count = 1; assert.throws(() => physics.execute('runtime.physics2d.test_point', { point: { x: 0, y: 0 } }), /native fault/);
});
test('atlas diagnostic preserves nearest sampling and does not mutate manager', () => {
  const manager = { enabled: true, maxFrameSize: 512 }, scene = { environment: { cc: { dynamicAtlasManager: manager, gfx: { Filter: { LINEAR: 1, NONE: 0 } } } } } as unknown as SceneInspector;
  const frame = { uuid: 'frame', packable: true, rect: { width: 32, height: 32 }, texture: { getSamplerInfo: () => ({ minFilter: 0, magFilter: 0, mipFilter: 0 }) } };
  const result = new TwoDInspector(scene).sprite(frame);
  assert.deepEqual(result.reasons, ['SAMPLER_INCOMPATIBLE']); assert.equal(result.atlasCandidate, false); assert.deepEqual(manager, { enabled: true, maxFrameSize: 512 });
});
test('UI assertions distinguish subtree membership, text and effective active state', () => {
  const node = { uuid: 'button', activeInHierarchy: true };
  const scene = { node: () => node, all: () => [node], components: () => [{ type: 'cc.Label', string: 'Ready' }, { type: 'cc.Button', interactable: false }], type: (c: { type: string }) => c.type } as unknown as SceneInspector;
  const inspect = new TwoDInspector(scene);
  assert.equal(Json.object(inspect.execute('runtime.ui.assert', { rootId: 'button', rows: [{ nodeId: 'button', text: 'Ready', active: true, interactable: false }] })).passed, true);
  assert.equal(Json.object(inspect.execute('runtime.ui.assert', { rootId: 'button', rows: [{ nodeId: 'outside', active: true }] })).passed, false);
  assert.equal(Json.object(inspect.execute('runtime.ui.assert', { rootId: 'button', rows: [{ nodeId: 'button', text: 'Wrong' }] })).passed, false);
});

class TileLayer {
  uuid = 'layer'; grid = [1, 2, 3, 4]; writes = 0;
  getLayerSize() { return { width: 2, height: 2 }; }
  getTileGIDAt(x: number, y: number) { return this.grid[y * 2 + x]; }
  getTileFlagsAt() { return 0; }
  getPositionAt(x: number, y: number) { return { x: x * 16, y: y * 16 }; }
  setTileGIDAt(gid: number, x: number, y: number) { this.writes++; this.grid[y * 2 + x] = gid === 99 ? 0 : gid; }
}
class TwoDFixture {
  readonly layer = new TileLayer(); readonly director = new EventEmitter();
  readonly cc = { TiledLayer: TileLayer, Director: { EVENT_AFTER_DRAW: 'draw' }, director: Object.assign(this.director, { getScene: () => this }) };
  readonly frames = new FrameSession(this.cc);
  readonly scene = { environment: { cc: this.cc }, component: () => this.layer } as unknown as SceneInspector;
  readonly control = new TwoDControl(this.scene, this.frames);
}
test('tile plans reject changed regions, duplicates and invalid flags before writes', () => {
  const fixture = new TwoDFixture(), p = { componentId: 'layer', rows: [{ x: 0, y: 0, gid: 3 }] };
  const plan = Json.object(fixture.control.tilemap('runtime.tilemap.plan', p)); fixture.layer.grid[0] = 2;
  assert.throws(() => fixture.control.tilemap('runtime.tilemap.apply', { ...p, planHash: plan.planHash! }), { code: 'STALE_REVISION' }); assert.equal(fixture.layer.writes, 0);
  assert.throws(() => fixture.control.tilemap('runtime.tilemap.plan', { ...p, rows: [...p.rows, ...p.rows] }));
  assert.throws(() => fixture.control.tilemap('runtime.tilemap.plan', { ...p, rows: [{ x: 0, y: 0, gid: 1, flags: 1 }] }));
});
test('tile invalid native GID produces partial outcome evidence instead of success', () => {
  const fixture = new TwoDFixture(), p = { componentId: 'layer', rows: [{ x: 0, y: 0, gid: 2 }, { x: 1, y: 0, gid: 99 }] };
  const plan = Json.object(fixture.control.tilemap('runtime.tilemap.plan', p));
  assert.throws(() => fixture.control.tilemap('runtime.tilemap.apply', { ...p, planHash: plan.planHash! }), (error: unknown) => {
    const value = error as { code: string; details: JsonObject }; assert.equal(value.code, 'OUTCOME_UNKNOWN'); assert.equal((value.details.completed as unknown[]).length, 1); assert.ok(value.details.pending); return true;
  });
});
test('contact sampling removes only owned listeners on disconnect', async () => {
  class Collider extends EventEmitter { uuid = 'collider'; }
  const fixture = new TwoDFixture(), collider = new Collider(), cc = { ...fixture.cc, Collider2D: Collider, Contact2DType: { BEGIN_CONTACT: 'begin' } };
  const frames = new FrameSession(cc), scene = { environment: { cc }, component: () => collider } as unknown as SceneInspector;
  const original = () => {}; collider.on('begin', original);
  const pending = new TwoDControl(scene, frames).contacts({ componentIds: ['collider'], frames: 2 });
  assert.equal(collider.listenerCount('begin'), 2); frames.dispose(); await assert.rejects(pending, { code: 'STALE_HANDLE' });
  assert.equal(collider.listenerCount('begin'), 1); assert.equal(collider.listeners('begin')[0], original);
});
test('production plan guards scene changes and queries asset location before creation', async () => {
  let revision = 1; const calls: string[] = [];
  const port = { version: '3.8.8', scene: async (method: string) => method === 'nodeExists' ? true : { revision } } as unknown as EditorPort;
  const service = new TwoDProduction(port, async id => { calls.push(id); return { url: 'db://assets/Scripts/FollowCamera.ts' }; });
  const p = { template: 'camera', className: 'FollowCamera', nodeId: 'node', url: 'db://assets/FollowCamera.ts' };
  const plan = Json.object(await service.execute('gameplay2d.plan', p)); revision++;
  await assert.rejects(service.execute('gameplay2d.apply', { ...p, planHash: plan.planHash! }), { code: 'STALE_REVISION' });
  assert.deepEqual(calls, ['asset.location', 'asset.location']);
});
test('viewport batches restore after failure but never resize a replacement session on the same scene', async () => {
  for (const replaced of [false, true]) {
    let session = 'first'; const sizes: unknown[] = [];
    const port = { version: '3.8.8', preview: async (method: string, params: JsonObject) => {
      if (method === 'status') return { running: true, sceneId: 'same-scene', diagnosticSessionId: session, viewport: [800, 600] };
      sizes.push([params.width, params.height]);
      if (params.width === 390) { if (replaced) session = 'replacement'; throw new Error('capture failed'); }
      return {};
    } } as unknown as EditorPort;
    await assert.rejects(new PreviewService(port).execute('preview.validate_viewports', { rows: [{ width: 390, height: 844 }] }), { code: 'OUTCOME_UNKNOWN' });
    assert.deepEqual(sizes, replaced ? [[390, 844]] : [[390, 844], [800, 600]]);
  }
});
