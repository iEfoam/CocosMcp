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
  const nodeId = (await call('node.create', { parentId: scene, name: `TweenCoverage-${Date.now()}` })).nodeId!;
  await call('scene.save'); await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const params = { nodeId, repeat: 2, steps: [
    { action: 'parallel', steps: [{ action: 'to', duration: 0.1, properties: { x: 100 }, easing: 'quadOut' }, { action: 'by', duration: 0.2, properties: { y: 20 } }] },
    { action: 'delay', duration: 0.05 }, { action: 'by', duration: 0.1, properties: { x: 10 } },
  ] };
  const plan = await call('runtime.tween.plan', params); assert.ok(Math.abs(Number(plan.duration) - 0.7) < 0.001);
  const task = await call('runtime.tween.start', params);
  let result: JsonObject = {};
  for (let attempt = 0; attempt < 30; attempt++) {
    result = await call('runtime.task.poll', { taskId: task.taskId! }); if (result.status !== 'running') break;
    await new Promise(accept => setTimeout(accept, 100));
  }
  assert.equal(result.status, 'completed');
  const after = Json.object(Json.object(result.result).after);
  assert.ok(Math.abs(Number(after.x) - 110) < 0.001); assert.ok(Math.abs(Number(after.y) - 40) < 0.001);
  const action = Json.object((await call('runtime.invoke', { target: 'cc', method: 'rotateBy', args: [2, 180] })).value).handle!;
  await call('runtime.invoke', { target: `node:${nodeId}`, method: 'runAction', args: [{ $handle: action }] });
  const cancel = await call('runtime.tween.start', { nodeId, steps: [{ action: 'to', duration: 2, properties: { x: 500 } }] });
  const conflict = await call('runtime.tween.start', { nodeId, steps: [{ action: 'to', duration: 2, properties: { y: 500 } }] });
  const rejected = await call('runtime.task.poll', { taskId: conflict.taskId! });
  assert.equal(rejected.status, 'failed'); assert.equal(Json.object(rejected.error).code, 'RESOURCE_BUSY');
  await call('runtime.shader.profile', { frames: 4, warmupFrames: 1 });
  assert.equal((await call('runtime.task.stop', { taskId: cancel.taskId! })).status, 'cancelled');
  const x = Number((await call('runtime.get', { target: `node:${nodeId}`, path: 'x' })).value);
  const angle = Number((await call('runtime.get', { target: `node:${nodeId}`, path: 'angle' })).value);
  await call('runtime.shader.profile', { frames: 10, warmupFrames: 1 });
  assert.equal(Number((await call('runtime.get', { target: `node:${nodeId}`, path: 'x' })).value), x);
  assert.ok(Math.abs(Number((await call('runtime.get', { target: `node:${nodeId}`, path: 'angle' })).value) - angle) > 1);
  await call('runtime.invoke', { target: `node:${nodeId}`, method: 'stopAction', args: [{ $handle: action }] });
  await call('runtime.invoke', { target: 'cc.game', method: 'addPersistRootNode', args: [{ $node: nodeId }] });
  const crossing = await call('runtime.tween.start', { nodeId, steps: [{ action: 'to', duration: 4, properties: { x: 1000 } }] });
  await call('runtime.shader.profile', { frames: 2, warmupFrames: 1 });
  await call('asset.location', { url: 'db://assets/Scenes/TweenTransition.fire' });
  const next = Json.object((await call('runtime.create', { type: 'cc.Scene', args: ['TweenTransition'] })).object).handle!;
  await call('runtime.invoke', { target: 'cc.director', method: 'runSceneImmediate', args: [{ $handle: next }] });
  await assert.rejects(() => call('runtime.task.poll', { taskId: crossing.taskId! }), error => CocosError.from(error).code === 'STALE_HANDLE');
  const stoppedX = (await call('runtime.get', { target: `node:${nodeId}`, path: 'x' })).value;
  await call('runtime.shader.profile', { frames: 10, warmupFrames: 1 });
  assert.equal((await call('runtime.get', { target: `node:${nodeId}`, path: 'x' })).value, stoppedX);
  assert.equal((await call('runtime.invoke', { target: `node:${nodeId}`, method: 'getNumberOfRunningActions' })).value, 0);
  await call('runtime.invoke', { target: 'cc.game', method: 'removePersistRootNode', args: [{ $node: nodeId }] });
  const ownedNode = Json.object((await call('runtime.create', { type: 'cc.Node', args: ['OwnedTweenTarget'] })).object).handle!;
  await call('runtime.invoke', { target: 'scene', method: 'addChild', args: [{ $handle: ownedNode }] });
  const ownedId = (await call('runtime.get', { target: ownedNode, path: 'uuid' })).value!;
  const destroying = await call('runtime.tween.start', { nodeId: ownedId, steps: [{ action: 'by', duration: 4, properties: { y: 100 } }] });
  await call('runtime.shader.profile', { frames: 2, warmupFrames: 1 });
  await call('runtime.release', { target: ownedNode, destroy: true });
  await call('runtime.shader.profile', { frames: 3, warmupFrames: 1 });
  const destroyed = await call('runtime.task.poll', { taskId: destroying.taskId! });
  assert.equal(destroyed.status, 'failed'); assert.equal(Json.object(destroyed.error).code, 'STALE_HANDLE');
  await call('runtime.set', { target: `node:${nodeId}`, path: 'active', value: false });
  rows.push({ lifecycleVerified: true, concurrentOwnershipRejected: true, persistentNodeTweenStopped: true, destroyedTargetInvalidated: true });
  rows.push({ passed: true, assertions: 'parallel/sequence/delay/relative/repeat/easing composition, actual frame samples, owned cancellation freezes x while business rotation continues' });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/tween.json'), JSON.stringify({ project, rows }, null, 2)); } }
