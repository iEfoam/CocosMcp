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
  for (const mode of [0, 1, 2, 0]) {
    await call('runtime.invoke', { target: `component:${componentId}`, method: 'setAnimationCacheMode', args: [mode] });
    await call('runtime.dragonbones.play', { componentId, name, playTimes: 0 });
    await call('runtime.shader.profile', { frames: 3, warmupFrames: 1 });
    const details = await call('runtime.dragonbones.details', { componentId, limit: 1000 });
    assert.ok((details.bones as JsonObject[]).length > 0); assert.ok((details.slots as JsonObject[]).length > 0);
    assert.equal(details.cached, mode !== 0); 
    if (mode === 0) {
      assert.equal(details.livePoseAvailable, true); assert.equal(details.stateAvailable, true);
      assert.ok((details.states as JsonObject[]).some(track => track.name === name && Number(track.currentTime) > 0));
    } else {
      assert.equal(details.states, null); assert.equal(details.livePoseAvailable, false);
      assert.ok((details.bones as JsonObject[]).every(bone => bone.pose === null));
    }
  }
  assert.equal((await call('runtime.dragonbones.details', { componentId, limit: 1 })).truncated, true);
  await call('runtime.set', { target: `node:${nodeId}`, path: 'active', value: false });
  rows.push({ passed: true, realtimeVerified: true, sharedCacheVerified: true, privateCacheVerified: true, truncationVerified: true });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/dragonbones.json'), JSON.stringify({ project, rows }, null, 2)); } }
