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
  const scene = Json.object((await call('scene.query')).scene).sceneId!;
  const nodeId = (await call('node.create', { parentId: scene, name: `RigidBodyCoverage-${Date.now()}` })).nodeId!;
  await call('node.set', { nodeId, properties: { active: false } });
  const body = (await call('component.add', { nodeId, type: 'cc.RigidBody' })).componentId!;
  await call('component.set', { componentId: body, properties: { type: 2, gravityScale: 0, linearDamping: 0, angularDamping: 0 } });
  const collider = (await call('component.add', { nodeId, type: 'cc.PhysicsBoxCollider' })).componentId!;
  await call('component.set', { componentId: collider, properties: { size: { width: 100, height: 100 } } });
  await call('scene.save'); await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const physics = Json.object((await call('runtime.invoke', { target: 'cc.director', method: 'getPhysicsManager' })).value).handle!;
  await call('runtime.set', { target: physics, path: 'enabled', value: true });
  await call('runtime.set', { target: `node:${nodeId}`, path: 'active', value: true });
  await call('runtime.shader.profile', { frames: 3, warmupFrames: 1 });
  const hierarchy = (await call('runtime.hierarchy', { limit: 2000 })).rows as JsonObject[];
  const componentId = ((hierarchy.find(row => row.nodeId === nodeId)!.components as JsonObject[]).find(row => row.type === 'cc.RigidBody'))!.componentId!;
  const state = await call('runtime.rigidbody2d.inspect', { componentId });
  assert.equal(state.nativeReady, true); assert.ok(Number(state.mass) > 0);
  const vector = { x: 320, y: 0 }, center = Json.object(state.worldCenter), point = { x: center.x!, y: center.y! };
  const impulse = await call('runtime.rigidbody2d.impulse', { componentId, vector, point, wake: true });
  const velocity = Number(Json.object(Json.object(impulse.after).linearVelocity).x);
  assert.ok(Math.abs(velocity - 320 / Number(state.mass)) < 0.001, JSON.stringify(impulse));
  await call('runtime.set', { target: `component:${componentId}`, path: 'linearVelocity', value: { x: 0, y: 0 } });
  const current = await call('runtime.rigidbody2d.inspect', { componentId });
  await call('runtime.rigidbody2d.force', { componentId, vector, point: { x: Json.object(current.worldCenter).x!, y: Json.object(current.worldCenter).y! }, wake: true });
  await call('runtime.shader.profile', { frames: 3, warmupFrames: 1 });
  const moved = await call('runtime.rigidbody2d.inspect', { componentId });
  assert.ok(Number(Json.object(moved.linearVelocity).x) > 0);
  await call('runtime.set', { target: `component:${componentId}`, path: 'type', value: 0 });
  await assert.rejects(() => call('runtime.rigidbody2d.impulse', { componentId, vector, point, wake: true }), error => CocosError.from(error).code === 'INVALID_ARGUMENT');
  await call('runtime.set', { target: `node:${nodeId}`, path: 'active', value: false });
  rows.push({ passed: true, assertions: 'native mass and initialization, impulse delta-v equals impulse/mass in native units, force advances velocity over actual frames, static-body rejection' });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/rigid-body.json'), JSON.stringify({ project, rows }, null, 2)); } }
