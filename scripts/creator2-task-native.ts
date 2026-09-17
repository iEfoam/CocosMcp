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
  const old = (await call('scene.hierarchy', { limit: 2000 })).rows as JsonObject[];
  for (const row of old) if (String(row.name).startsWith('TaskCoverage-')) await call('node.set', { nodeId: row.nodeId!, properties: { active: false } });
  const scene = Json.object((await call('scene.query')).scene).sceneId!;
  const root = (await call('node.create', { parentId: scene, name: `TaskCoverage-${Date.now()}` })).nodeId!;
  const a = (await call('node.create', { parentId: root, name: 'A' })).nodeId!;
  const b = (await call('node.create', { parentId: root, name: 'B' })).nodeId!;
  for (const nodeId of [a, b]) {
    const componentId = (await call('component.add', { nodeId, type: 'cc.CircleCollider' })).componentId!;
    await call('component.set', { componentId, properties: { radius: 25 } });
  }
  await call('node.set', { nodeId: b, properties: { position: { x: 200, y: 0, z: 0 } } });
  await call('scene.save'); await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const manager = Json.object((await call('runtime.invoke', { target: 'cc.director', method: 'getCollisionManager' })).value).handle!;
  await call('runtime.set', { target: manager, path: 'enabled', value: true });
  const baseline = await call('runtime.hierarchy', { limit: 2000 });
  const task = await call('runtime.collision2d.trace_start', { rootId: root, frames: 300, limit: 1000 });
  assert.equal((await call('runtime.task.poll', { taskId: task.taskId! })).status, 'running');
  await call('runtime.set', { target: `node:${b}`, path: 'position', value: { x: 0, y: 0, z: 0 } });
  await call('runtime.shader.profile', { frames: 3, warmupFrames: 1 });
  await call('runtime.set', { target: `node:${b}`, path: 'position', value: { x: 200, y: 0, z: 0 } });
  await call('runtime.shader.profile', { frames: 3, warmupFrames: 1 });
  const stopped = await call('runtime.task.stop', { taskId: task.taskId! });
  assert.equal(stopped.status, 'cancelled');
  const events = Json.object(stopped.progress).rows as JsonObject[];
  for (const event of ['enter', 'stay', 'exit']) assert.ok(events.some(row => row.event === event && [a, b].includes(row.receiverNodeId!) && [a, b].includes(row.otherNodeId!)), event);
  assert.equal((await call('runtime.task.stop', { taskId: task.taskId! })).status, 'cancelled');
  await call('runtime.shader.profile', { frames: 2, warmupFrames: 1 });
  const after = await call('runtime.hierarchy', { limit: 2000 });
  const count = (value: JsonObject) => (value.rows as JsonObject[]).filter(row => [a, b].includes(row.nodeId!)).map(row => (row.components as unknown[]).length);
  assert.deepEqual(count(after), count(baseline));
  const short = await call('runtime.collision2d.trace_start', { rootId: root, frames: 2, limit: 10 });
  await call('runtime.shader.profile', { frames: 4, warmupFrames: 1 });
  assert.equal((await call('runtime.task.poll', { taskId: short.taskId! })).status, 'completed');
  const rate = (await call('runtime.invoke', { target: 'cc.game', method: 'getFrameRate' })).value!;
  await call('runtime.invoke', { target: 'cc.game', method: 'setFrameRate', args: [5] });
  const deadline = await call('runtime.collision2d.trace_start', { rootId: root, frames: 300, limit: 10 });
  let expired: JsonObject = {};
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      expired = await call('runtime.task.poll', { taskId: deadline.taskId! });
      if (expired.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(expired.status, 'failed');
    assert.match(String(Json.object(expired.error).message), /30 seconds/);
  } finally { await call('runtime.invoke', { target: 'cc.game', method: 'setFrameRate', args: [rate] }); }
  await call('runtime.shader.profile', { frames: 2, warmupFrames: 1 });
  assert.deepEqual(count(await call('runtime.hierarchy', { limit: 2000 })), count(baseline));
  await call('runtime.invoke', { target: 'cc.game', method: 'addPersistRootNode', args: [{ $node: root }] });
  const crossing = await call('runtime.collision2d.trace_start', { rootId: root, frames: 300, limit: 10 });
  await call('asset.location', { url: 'db://assets/Scenes/TaskCleanupTransition.fire' });
  const next = Json.object((await call('runtime.create', { type: 'cc.Scene', args: ['TaskCleanupTransition'] })).object).handle!;
  await call('runtime.invoke', { target: 'cc.director', method: 'runSceneImmediate', args: [{ $handle: next }] });
  await assert.rejects(() => call('runtime.task.poll', { taskId: crossing.taskId! }), error => CocosError.from(error).code === 'STALE_HANDLE');
  await call('runtime.shader.profile', { frames: 2, warmupFrames: 1 });
  const persistent = await call('runtime.hierarchy', { limit: 2000 });
  assert.deepEqual(count(persistent), count(baseline));
  await call('runtime.invoke', { target: 'cc.game', method: 'removePersistRootNode', args: [{ $node: root }] });
  const disconnected = await call('runtime.collision2d.trace_start', { rootId: root, frames: 300, limit: 10 });
  await call('preview.stop'); preview = false;
  await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  await assert.rejects(() => call('runtime.task.poll', { taskId: disconnected.taskId! }), error => CocosError.from(error).code === 'STALE_HANDLE');
  assert.deepEqual(count(await call('runtime.hierarchy', { limit: 2000 })), count(baseline));
  rows.push({ deadlineVerified: true, persistentNodeSceneCleanupVerified: true, previewRestartExpiresTask: true });
  await call('runtime.set', { target: `node:${root}`, path: 'active', value: false });
  rows.push({ passed: true, assertions: 'nonblocking native movement during trace, enter/stay/exit, cancellation and idempotent stop, observer component cleanup, natural completion' });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/tasks.json'), JSON.stringify({ project, rows }, null, 2)); } }
