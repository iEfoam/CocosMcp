import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';
const project = resolve('.codex-work/build/creator2-test-project'), registry = new ProjectRegistry(), { projectId } = await registry.add(project);
const gateway = new RuntimeGateway(registry), gatewayPort = await gateway.start(), app = new CocosApplication(registry, undefined, undefined, true, gateway);
const rows: JsonObject[] = []; let preview = false;
const call = async (id: string, params: JsonObject = {}): Promise<JsonObject> => { const result = Json.object((await app.execute({ projectId, capabilityId: id, params })).result); rows.push({ id, result }); console.log(`PASS ${id}`); return result; };
try {
  const data = await call('asset.resolve', { reference: 'db://assets/Textures/Creator2SkeletonFixtures/DragonBones/NewDragonTest.json' });
  const atlas = await call('asset.resolve', { reference: 'db://assets/Textures/Creator2SkeletonFixtures/DragonBones/texture.json' });
  const fixture = JSON.parse(await readFile(resolve(project, 'assets/Textures/Creator2SkeletonFixtures/DragonBones/NewDragonTest.json'), 'utf8'));
  const scene = Json.object((await call('scene.query')).scene).sceneId!;
  const nodeId = (await call('node.create', { parentId: scene, name: `DragonBonesDetails-${Date.now()}` })).nodeId!;
  const editorComponent = (await call('component.add', { nodeId, type: 'dragonBones.ArmatureDisplay' })).componentId!;
  await call('component.set', { componentId: editorComponent, properties: { dragonAsset: { uuid: data.uuid! }, dragonAtlasAsset: { uuid: atlas.uuid! }, armatureName: fixture.armature[0].name, timeScale: 1 } });
  await call('scene.save'); await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const hierarchy = (await call('runtime.hierarchy', { limit: 2000 })).rows as JsonObject[];
  const componentId = ((hierarchy.find(row => row.nodeId === nodeId)!.components as JsonObject[]).find(row => row.type === 'dragonBones.ArmatureDisplay'))!.componentId!;
  const name = ((await call('runtime.dragonbones.inspect', { componentId })).animations as string[])[0]!;
  await call('runtime.set', { target: 'component:' + componentId, path: 'timeScale', value: 10 });
  const subscriptionId = (await call('runtime.subscribe', { target: 'component:' + componentId, event: 'complete' })).subscriptionId!;
  for (const mode of [0, 1, 2]) {
    await call('runtime.invoke', { target: 'component:' + componentId, method: 'setAnimationCacheMode', args: [mode] });
    const taskId = (await call('runtime.dragonbones.trace_start', { componentId, frames: 80 })).taskId!;
    await call('runtime.dragonbones.play', { componentId, name, playTimes: 1 });
    let state: JsonObject = {};
    for (let attempt = 0; attempt < 60; attempt++) {
      state = await call('runtime.task.poll', { taskId });
      if (state.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(state.status, 'completed');
    const events = Json.object(state.result).rows as JsonObject[];
    for (const event of ['start', 'loopComplete', 'complete']) assert.ok(events.some(row => row.event === event), event);
    assert.ok(events.every(row => row.hasNativePayload === (mode === 0)));
    if (mode !== 0) assert.ok(events.every(row => row.animation === null));
    assert.ok(((await call('runtime.events', { limit: 100 })).rows as JsonObject[]).some(row => row.subscriptionId === subscriptionId));
  }
  const taskId = (await call('runtime.dragonbones.trace_start', { componentId, frames: 300, limit: 1 })).taskId!;
  await call('runtime.dragonbones.play', { componentId, name, playTimes: 1 });
  await call('runtime.shader.profile', { frames: 40, warmupFrames: 1 });
  const stopped = await call('runtime.task.stop', { taskId });
  assert.equal(stopped.status, 'cancelled');
  assert.ok(Number(Json.object(stopped.progress).dropped) > 0);
  const before = (await call('runtime.events', { limit: 100 })).nextCursor!;
  await call('runtime.dragonbones.play', { componentId, name, playTimes: 1 });
  await call('runtime.shader.profile', { frames: 40, warmupFrames: 1 });
  assert.ok(((await call('runtime.events', { cursor: before, limit: 100 })).rows as JsonObject[]).some(row => row.subscriptionId === subscriptionId));
  assert.deepEqual(await call('runtime.task.poll', { taskId }), stopped);
  await call('runtime.unsubscribe', { subscriptionId });
  await call('runtime.set', { target: `node:${nodeId}`, path: 'active', value: false });
  rows.push({ passed: true, realtimeVerified: true, sharedCacheVerified: true, privateCacheVerified: true, truncationVerified: true, cancellationVerified: true, independentListenerPreserved: true });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/dragonbones-events.json'), JSON.stringify({ project, rows }, null, 2)); } }
