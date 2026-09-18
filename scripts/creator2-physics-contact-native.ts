import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';

const project = resolve('.codex-work/build/creator2-test-project'), registry = new ProjectRegistry(), { projectId } = await registry.add(project);
const gateway = new RuntimeGateway(registry), gatewayPort = await gateway.start(), app = new CocosApplication(registry, undefined, undefined, true, gateway);
const rows: JsonObject[] = []; let preview = false;
const call = async (id: string, params: JsonObject = {}): Promise<JsonObject> => { const result = Json.object((await app.execute({ projectId, capabilityId: id, params })).result); rows.push({ id, result }); console.log(`PASS ${id}`); return result; };
try {
  const type = 'CocosMcpPhysicsContactProbe';
  const location = await call('asset.location', { url: 'db://assets/Scripts/' + type + '.js' });
  if (!location.targetExists) await call('asset.create', { url: location.url!, content: "cc.Class({ name: 'CocosMcpPhysicsContactProbe', extends: cc.Component, properties: { begins: 0, ends: 0, pres: 0, posts: 0, maxNormal: 0 }, onBeginContact: function() { this.begins++; }, onEndContact: function() { this.ends++; }, onPreSolve: function() { this.pres++; }, onPostSolve: function(contact) { this.posts++; var impulse = contact.getImpulse(); if (impulse) this.maxNormal = Math.max(this.maxNormal, impulse.normalImpulses.reduce(function(sum,value) { return sum + value; },0)); } });" });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) { if (((await call('component.types')).rows as JsonObject[]).some(row => row.name === type)) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 500)); }
  assert.ok(ready);
  for (const node of (await call('scene.hierarchy', { limit: 2000 })).rows as JsonObject[]) if (String(node.name).startsWith('PhysicsContact-')) await call('node.set', { nodeId: node.nodeId!, properties: { active: false } });
  const scene = Json.object((await call('scene.query')).scene).sceneId!;
  const root = (await call('node.create', { parentId: scene, name: 'PhysicsContact-' + Date.now() })).nodeId!;
  await call('node.set', { nodeId: root, properties: { active: false } });
  const fixtures: JsonObject[] = [];
  for (const config of [{ name: 'floor', x: 2000, y: 0, dynamic: false, sensor: false }, { name: 'body', x: 2000, y: 70, dynamic: true, sensor: false }, { name: 'sensorFloor', x: 2400, y: 0, dynamic: false, sensor: true }, { name: 'sensorBody', x: 2400, y: 70, dynamic: true, sensor: false }]) {
    const nodeId = (await call('node.create', { parentId: root, name: config.name })).nodeId!;
    await call('node.set', { nodeId, properties: { position: { x: config.x, y: config.y, z: 0 } } });
    const bodyId = (await call('component.add', { nodeId, type: 'cc.RigidBody' })).componentId!;
    await call('component.set', { componentId: bodyId, properties: { type: config.dynamic ? 2 : 0, enabledContactListener: true, gravityScale: 1, allowSleep: false } });
    const colliderId = (await call('component.add', { nodeId, type: 'cc.PhysicsBoxCollider' })).componentId!;
    await call('component.set', { componentId: colliderId, properties: { size: { width: config.dynamic ? 20 : 200, height: 20 }, sensor: config.sensor } });
    if (config.name === 'body') await call('component.add', { nodeId, type });
    fixtures.push({ ...config, nodeId });
  }
  await call('scene.save'); await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const physics = Json.object((await call('runtime.invoke', { target: 'cc.director', method: 'getPhysicsManager' })).value).handle!;
  await call('runtime.set', { target: physics, path: 'enabled', value: true });
  await call('runtime.set', { target: physics, path: 'gravity', value: { x: 0, y: -320 } });
  await call('runtime.set', { target: 'node:' + root, path: 'active', value: true });
  await call('runtime.shader.profile', { frames: 2, warmupFrames: 1 });
  const baseline = await call('runtime.hierarchy', { limit: 2000 });
  const dynamic = fixtures.find(row => row.name === 'body')!;
  const components = ((baseline.rows as JsonObject[]).find(row => row.nodeId === dynamic.nodeId)!.components as JsonObject[]);
  const bodyId = components.find(row => row.type === 'cc.RigidBody')!.componentId!;
  const colliderId = components.find(row => row.type === 'cc.PhysicsBoxCollider')!.componentId!;
  const business = components.find(row => row.type === type)!.componentId!;
  const taskId = (await call('runtime.physics2d.contact_trace_start', { rootId: root, frames: 300, limit: 3000 })).taskId!;
  await call('runtime.shader.profile', { frames: 120, warmupFrames: 1 });
  await call('runtime.set', { target: 'node:' + dynamic.nodeId, path: 'y', value: 200 });
  await call('runtime.invoke', { target: 'component:' + bodyId, method: 'syncPosition', args: [true] });
  await call('runtime.set', { target: 'component:' + bodyId, path: 'linearVelocity', value: { x: 0, y: 0 } });
  await call('runtime.shader.profile', { frames: 4, warmupFrames: 1 });
  const stopped = await call('runtime.task.stop', { taskId }); assert.equal(stopped.status, 'cancelled');
  assert.equal(Json.object(stopped.progress).impulseUnits, 'Box2D-native-impulse');
  assert.equal(Json.object(stopped.progress).coordinateSpace, 'world-pixels');
  const events = Json.object(stopped.progress).rows as JsonObject[];
  const solid = events.filter(row => row.selfColliderId === colliderId && !row.sensor);
  for (const phase of ['begin','end','preSolve','postSolve']) assert.ok(solid.some(row => row.event === phase), phase);
  assert.ok(events.some(row => row.sensor && row.event === 'begin')); assert.ok(events.some(row => row.sensor && row.event === 'end'));
  assert.ok(events.filter(row => row.sensor).every(row => row.event === 'begin' || row.event === 'end'));
  assert.ok(events.filter(row => row.sensor).every(row => Json.object(row.manifold).normal === null));
  assert.ok(events.filter(row => (Json.object(row.manifold).points as unknown[]).length === 0).every(row => Json.object(row.manifold).normal === null));
  assert.ok(events.filter(row => row.event !== 'postSolve').every(row => row.impulse === null));
  const post = solid.filter(row => row.event === 'postSolve'); assert.ok(post.length > 0);
  const maxImpulse = Math.max(...post.map(row => (Json.object(row.impulse).normal as number[]).reduce((sum,n) => sum+n,0))); assert.ok(maxImpulse > 0);
  const businessMax = Number((await call('runtime.get', { target: 'component:' + business, path: 'maxNormal' })).value);
  const ratio = Number((await call('runtime.get', { target: 'cc.PhysicsManager', path: 'PTM_RATIO' })).value);
  assert.ok(Math.abs(maxImpulse - businessMax / ratio) < 1e-6);
  assert.ok(post.some(row => (Json.object(row.manifold).points as JsonObject[]).some(point => Math.abs(Number(point.y) - 10) < 2)));
  for (const path of ['begins','ends','pres','posts']) assert.ok(Number((await call('runtime.get', { target: 'component:' + business, path })).value) > 0);
  await call('runtime.shader.profile', { frames: 2, warmupFrames: 1 });
  const restored = await call('runtime.hierarchy', { limit: 2000 });
  const counts = (value: JsonObject) => (value.rows as JsonObject[]).filter(row => fixtures.some(fixture => fixture.nodeId === row.nodeId)).map(row => (row.components as unknown[]).length);
  assert.deepEqual(counts(restored), counts(baseline));
  assert.equal((await call('runtime.get', { target: 'component:' + bodyId, path: 'enabledContactListener' })).value, true);
  const beginsBefore = Number((await call('runtime.get', { target: 'component:' + business, path: 'begins' })).value);
  // 再次触地必须由业务组件自身继续接收；取消任务的记录保持不变。
  await call('runtime.shader.profile', { frames: 100, warmupFrames: 1 });
  assert.ok(Number((await call('runtime.get', { target: 'component:' + business, path: 'begins' })).value) > beginsBefore);
  assert.equal((Json.object((await call('runtime.task.poll', { taskId })).progress).rows as unknown[]).length, events.length);
  const boundedId = (await call('runtime.physics2d.contact_trace_start', { rootId: root, frames: 10, limit: 1 })).taskId!;
  await call('runtime.shader.profile', { frames: 15, warmupFrames: 1 });
  const bounded = await call('runtime.task.poll', { taskId: boundedId }); assert.equal(bounded.status, 'completed');
  assert.equal((Json.object(bounded.result).rows as unknown[]).length, 1); assert.ok(Number(Json.object(bounded.result).dropped) > 0);
  assert.deepEqual(counts(await call('runtime.hierarchy', { limit: 2000 })), counts(baseline));
  await call('runtime.set', { target: 'node:' + root, path: 'active', value: false });
  rows.push({ passed: true, fourContactPhasesVerified: true, sensorBoundaryVerified: true, emptyManifoldNormalVerified: true, impulseUnitsVerified: true, worldPointsVerified: true, businessCallbacksPreserved: true, businessContinuesAfterCancellation: true, observerCleanupVerified: true, boundedCompletionVerified: true });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/physics-contact.json'), JSON.stringify({ project, rows }, null, 2)); } }
