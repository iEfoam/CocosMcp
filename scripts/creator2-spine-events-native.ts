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
  const location = await call('asset.location', { url: 'db://assets/Scripts/CocosMcpSpineEventsProbe.js' });
  if (!location.targetExists) await call('asset.create', { url: location.url!, content: "cc.Class({ name: 'CocosMcpSpineEventsProbe', extends: cc.Component, properties: { completes: 0 }, onLoad: function() { var self = this; this.getComponent(sp.Skeleton).setCompleteListener(function() { self.completes++; }); }, listenerCount: function() { var state = this.getComponent(sp.Skeleton).getState(); return state ? state.listeners.length : 0; } });" });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (((await call('component.types')).rows as JsonObject[]).some(row => row.name === 'CocosMcpSpineEventsProbe')) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Business fixture must compile');
  const data = await call('asset.resolve', { reference: 'db://assets/Textures/Creator2SkeletonFixtures/Spine/raptor.json' });
  const scene = Json.object((await call('scene.query')).scene).sceneId!;
  const nodeId = (await call('node.create', { parentId: scene, name: `SpineDetails-${Date.now()}` })).nodeId!;
  const editorComponent = (await call('component.add', { nodeId, type: 'sp.Skeleton' })).componentId!;
  await call('component.set', { componentId: editorComponent, properties: { skeletonData: { uuid: data.uuid! }, timeScale: 1 } });
  await call('component.add', { nodeId, type: 'CocosMcpSpineEventsProbe' });
  await call('scene.save'); await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const hierarchy = (await call('runtime.hierarchy', { limit: 2000 })).rows as JsonObject[];
  const componentId = ((hierarchy.find(row => row.nodeId === nodeId)!.components as JsonObject[]).find(row => row.type === 'sp.Skeleton'))!.componentId!;
  const name = ((await call('runtime.spine.inspect', { componentId })).animations as string[])[0]!;
  const businessId = ((hierarchy.find(row => row.nodeId === nodeId)!.components as JsonObject[]).find(row => row.type === 'CocosMcpSpineEventsProbe'))!.componentId!;
  const listenerCount = async () => Number((await call('runtime.invoke', { target: 'component:' + businessId, method: 'listenerCount' })).value);
  const completes = async () => Number((await call('runtime.get', { target: 'component:' + businessId, path: 'completes' })).value);
  const baseline = await listenerCount(); assert.ok(baseline > 0);
  await call('runtime.set', { target: 'component:' + componentId, path: 'timeScale', value: 0 });
  const taskId = (await call('runtime.spine.trace_start', { componentId, frames: 100 })).taskId!;
  assert.equal(await listenerCount(), baseline + 1);
  await call('runtime.spine.play', { componentId, name, loop: false });
  await call('runtime.spine.play', { componentId, name, loop: false });
  await call('runtime.set', { target: 'component:' + componentId, path: 'timeScale', value: 10 });
  let state: JsonObject = {};
  for (let attempt = 0; attempt < 60; attempt++) {
    state = await call('runtime.task.poll', { taskId });
    if (state.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(state.status, 'completed');
  const events = Json.object(state.result).rows as JsonObject[];
  for (const event of ['start', 'interrupt', 'end', 'dispose', 'complete']) assert.ok(events.some(row => row.event === event), event);
  assert.equal(await listenerCount(), baseline); assert.ok(await completes() > 0);
  const cancelId = (await call('runtime.spine.trace_start', { componentId, frames: 300, limit: 1 })).taskId!;
  await call('runtime.spine.play', { componentId, name, loop: true });
  await call('runtime.shader.profile', { frames: 40, warmupFrames: 1 });
  const stopped = await call('runtime.task.stop', { taskId: cancelId });
  assert.equal(stopped.status, 'cancelled'); assert.ok(Number(Json.object(stopped.progress).dropped) > 0);
  assert.equal(await listenerCount(), baseline);
  const before = await completes(); await call('runtime.shader.profile', { frames: 40, warmupFrames: 1 });
  assert.ok(await completes() > before); assert.deepEqual(await call('runtime.task.poll', { taskId: cancelId }), stopped);
  const changed = (await call('runtime.spine.trace_start', { componentId, frames: 300 })).taskId!;
  await call('runtime.invoke', { target: 'component:' + componentId, method: 'setAnimationCacheMode', args: [1] });
  await call('runtime.shader.profile', { frames: 2, warmupFrames: 1 });
  assert.equal(Json.object((await call('runtime.task.poll', { taskId: changed })).error).code, 'OPERATION_CONFLICT');
  const cached = (await call('runtime.spine.trace_start', { componentId, events: ['event'], frames: 1 })).taskId!;
  assert.equal(Json.object((await call('runtime.task.poll', { taskId: cached })).error).code, 'UNSUPPORTED_CAPABILITY');
  await call('runtime.set', { target: `node:${nodeId}`, path: 'active', value: false });
  rows.push({ passed: true, realtimeEventsVerified: true, cancellationVerified: true, businessCallbacksVerified: true, nativeListenerCleanupVerified: true, cacheModeBoundaryVerified: true });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/spine-events.json'), JSON.stringify({ project, rows }, null, 2)); } }
