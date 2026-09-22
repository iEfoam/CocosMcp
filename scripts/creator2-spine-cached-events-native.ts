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
  const location = await call('asset.location', { url: 'db://assets/Scripts/CocosMcpSpineCacheEventsProbe.js' });
  if (!location.targetExists) await call('asset.create', { url: location.url!, content: "cc.Class({ name: 'CocosMcpSpineCacheEventsProbe', extends: cc.Component, properties: { completes: 0, replacements: 0 }, onLoad: function() { var self = this; this.businessCallback = function() { self.completes++; }; this.getComponent(sp.Skeleton).setCompleteListener(this.businessCallback); }, callbackRestored: function() { return this.getComponent(sp.Skeleton)._listener.complete === this.businessCallback; }, replaceCallback: function() { var self = this; this.businessCallback = function() { self.replacements++; }; this.getComponent(sp.Skeleton).setCompleteListener(this.businessCallback); } });" });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (((await call('component.types')).rows as JsonObject[]).some(row => row.name === 'CocosMcpSpineCacheEventsProbe')) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Business fixture must compile');
  const data = await call('asset.resolve', { reference: 'db://assets/Textures/Creator2SkeletonFixtures/Spine/raptor.json' });
  const scene = Json.object((await call('scene.query')).scene).sceneId!;
  const nodeId = (await call('node.create', { parentId: scene, name: `SpineDetails-${Date.now()}` })).nodeId!;
  const editorComponent = (await call('component.add', { nodeId, type: 'sp.Skeleton' })).componentId!;
  await call('component.set', { componentId: editorComponent, properties: { skeletonData: { uuid: data.uuid! }, timeScale: 1 } });
  await call('component.add', { nodeId, type: 'CocosMcpSpineCacheEventsProbe' });
  await call('scene.save'); await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const hierarchy = (await call('runtime.hierarchy', { limit: 2000 })).rows as JsonObject[];
  const componentId = ((hierarchy.find(row => row.nodeId === nodeId)!.components as JsonObject[]).find(row => row.type === 'sp.Skeleton'))!.componentId!;
  const name = ((await call('runtime.spine.inspect', { componentId })).animations as string[])[0]!;
  const businessId = ((hierarchy.find(row => row.nodeId === nodeId)!.components as JsonObject[]).find(row => row.type === 'CocosMcpSpineCacheEventsProbe'))!.componentId!;
  const restored = async () => assert.equal((await call('runtime.invoke', { target: 'component:' + businessId, method: 'callbackRestored' })).value, true);
  const counter = async (path: string) => Number((await call('runtime.get', { target: 'component:' + businessId, path })).value);
  await call('runtime.set', { target: 'component:' + componentId, path: 'timeScale', value: 10 });
  for (const mode of [1, 2]) {
    await call('runtime.invoke', { target: 'component:' + componentId, method: 'setAnimationCacheMode', args: [mode] });
    const taskId = (await call('runtime.spine.trace_start', { componentId, frames: 100 })).taskId!;
    await call('runtime.spine.play', { componentId, name, loop: false });
    let state: JsonObject = {};
    for (let attempt = 0; attempt < 60; attempt++) {
      state = await call('runtime.task.poll', { taskId });
      if (state.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(state.status, 'completed');
    const events = Json.object(state.result).rows as JsonObject[];
    for (const event of ['start', 'complete', 'end']) assert.ok(events.some(row => row.event === event), event);
    assert.ok(events.every(row => row.syntheticEntry === true && row.trackTime === null && row.animation === name));
    await restored(); assert.ok(await counter('completes') > 0);
  }
  const cancelId = (await call('runtime.spine.trace_start', { componentId, frames: 300, limit: 1 })).taskId!;
  const duplicate = (await call('runtime.spine.trace_start', { componentId, frames: 300 })).taskId!;
  assert.equal(Json.object((await call('runtime.task.poll', { taskId: duplicate })).error).code, 'RESOURCE_BUSY');
  await call('runtime.spine.play', { componentId, name, loop: true });
  await call('runtime.shader.profile', { frames: 40, warmupFrames: 1 });
  const stopped = await call('runtime.task.stop', { taskId: cancelId });
  assert.equal(stopped.status, 'cancelled'); assert.ok(Number(Json.object(stopped.progress).dropped) > 0); await restored();
  const before = await counter('completes'); await call('runtime.shader.profile', { frames: 40, warmupFrames: 1 });
  assert.ok(await counter('completes') > before); assert.deepEqual(await call('runtime.task.poll', { taskId: cancelId }), stopped);
  const changed = (await call('runtime.spine.trace_start', { componentId, frames: 300 })).taskId!;
  await call('runtime.invoke', { target: 'component:' + businessId, method: 'replaceCallback' });
  await call('runtime.shader.profile', { frames: 2, warmupFrames: 1 });
  assert.equal(Json.object((await call('runtime.task.poll', { taskId: changed })).error).code, 'OPERATION_CONFLICT'); await restored();
  await call('runtime.shader.profile', { frames: 40, warmupFrames: 1 }); assert.ok(await counter('replacements') > 0);
  const unsupported = (await call('runtime.spine.trace_start', { componentId, events: ['event'], frames: 1 })).taskId!;
  assert.equal(Json.object((await call('runtime.task.poll', { taskId: unsupported })).error).code, 'UNSUPPORTED_CAPABILITY');
  await call('runtime.set', { target: `node:${nodeId}`, path: 'active', value: false });
  rows.push({ passed: true, cachedEventsVerified: true, cancellationVerified: true, businessCallbacksVerified: true, callbackIdentityRestored: true, externalReplacementPreserved: true, cacheModeBoundaryVerified: true });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/spine-cached-events.json'), JSON.stringify({ project, rows }, null, 2)); } }
