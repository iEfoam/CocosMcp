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
  const ensure = async (url: string, content: string) => {
    const location = await call('asset.location', { url }); assert.ok(String(location.url).startsWith('db://assets/'));
    if (!location.targetExists) await call('asset.create', { url: location.url!, content });
    else assert.equal(await readFile(resolve(project, String(location.url).slice(5)), 'utf8'), content);
    return location.url!;
  };
  const spineFolder = 'assets/Textures/Creator2SkeletonFixtures/Spine/';
  const spine = JSON.parse(await readFile(resolve(project, spineFolder, 'raptor.json'), 'utf8'));
  spine.events = { ...(spine.events || {}), McpPayload: { int: 7, float: 1.25, string: 'spine-default' } };
  spine.animations.Jump.events = [{ time: 0.1, name: 'McpPayload', int: 9, float: 2.5, string: 'spine-custom' }, { time: 0.3, name: 'McpPayload' }];
  await ensure('db://' + spineFolder + 'raptor-events.atlas', await readFile(resolve(project, spineFolder, 'raptor.atlas'), 'utf8'));
  const spineUrl = await ensure('db://' + spineFolder + 'raptor-events.json', JSON.stringify(spine));
  const dragonFolder = 'assets/Textures/Creator2SkeletonFixtures/DragonBones/';
  const dragon = JSON.parse(await readFile(resolve(project, dragonFolder, 'NewDragonTest.json'), 'utf8'));
  const animation = dragon.armature[0].animation[0];
  animation.frame = [{ duration: 6 }, { duration: 6, events: [{ name: 'McpFrame', ints: [7], floats: [1.25], strings: ['dragon-frame'] }] }, { duration: animation.duration - 12, sound: [{ name: 'McpSound', ints: [9], floats: [2.5], strings: ['dragon-sound'] }] }];
  const dragonUrl = await ensure('db://' + dragonFolder + 'NewDragonEventsTest.json', JSON.stringify(dragon));
  const spineId = (await call('asset.resolve', { reference: spineUrl })).uuid!;
  const dragonId = (await call('asset.resolve', { reference: dragonUrl })).uuid!;
  const atlasId = (await call('asset.resolve', { reference: 'db://' + dragonFolder + 'texture.json' })).uuid!;
  const scene = Json.object((await call('scene.query')).scene).sceneId!;
  const root = (await call('node.create', { parentId: scene, name: 'SkeletonCustomEvents-' + Date.now() })).nodeId!;
  const fixtures: JsonObject[] = [];
  for (const family of ['spine', 'dragonbones']) {
    const nodeId = (await call('node.create', { parentId: root, name: family })).nodeId!;
    const type = family === 'spine' ? 'sp.Skeleton' : 'dragonBones.ArmatureDisplay';
    const componentId = (await call('component.add', { nodeId, type })).componentId!;
    await call('component.set', { componentId, properties: family === 'spine' ? { skeletonData: { uuid: spineId }, timeScale: 1 } : { dragonAsset: { uuid: dragonId }, dragonAtlasAsset: { uuid: atlasId }, armatureName: dragon.armature[0].name, timeScale: 1 } });
    fixtures.push({ family, nodeId, type });
  }
  await call('scene.save'); await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const hierarchy = (await call('runtime.hierarchy', { limit: 2000 })).rows as JsonObject[];
  for (const fixture of fixtures) {
    fixture.componentId = ((hierarchy.find(row => row.nodeId === fixture.nodeId)!.components as JsonObject[]).find(row => row.type === fixture.type))!.componentId!;
    fixture.taskId = (await call('runtime.' + fixture.family + '.trace_start', { componentId: fixture.componentId, frames: 200, events: fixture.family === 'spine' ? ['event'] : ['frameEvent', 'soundEvent'] })).taskId!;
  }
  await call('runtime.spine.play', { componentId: fixtures[0]!.componentId!, name: 'Jump', loop: false });
  await call('runtime.dragonbones.play', { componentId: fixtures[1]!.componentId!, name: 'stand', playTimes: 1 });
  for (const fixture of fixtures) {
    let state: JsonObject = {};
    for (let attempt = 0; attempt < 80; attempt++) {
      state = await call('runtime.task.poll', { taskId: fixture.taskId! });
      if (state.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(state.status, 'completed');
    const events = Json.object(state.result).rows as JsonObject[];
    if (fixture.family === 'spine') {
      assert.equal(events.length, 2);
      assert.deepEqual(events.map(event => Json.object(event.payload).name), ['McpPayload','McpPayload']);
      assert.deepEqual(events.map(event => Json.object(event.payload).intValue), [9,7]);
      assert.deepEqual(events.map(event => Json.object(event.payload).floatValue), [2.5,1.25]);
      assert.deepEqual(events.map(event => Json.object(event.payload).stringValue), ['spine-custom','spine-default']);
    } else {
      assert.equal(events.length, 2);
      for (const [eventName, name, ints, floats, strings] of [['frameEvent','McpFrame',[7],[1.25],['dragon-frame']], ['soundEvent','McpSound',[9],[2.5],['dragon-sound']]] as const) {
        const event = events.find(row => row.event === eventName)!; assert.ok(event); assert.equal(event.name, name);
        assert.deepEqual(event.payload, { ints, floats, strings, truncated: false });
      }
    }
  }
  await call('runtime.set', { target: 'node:' + root, path: 'active', value: false });
  rows.push({ passed: true, spineDefaultAndOverridePayloadVerified: true, dragonFramePayloadVerified: true, dragonSoundPayloadVerified: true, nativePlaybackEvents: true, audioPlaybackVerified: false });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/skeleton-custom-events.json'), JSON.stringify({ project, rows }, null, 2)); } }
