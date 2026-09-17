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
  const source = JSON.parse(await readFile(resolve(project, 'assets/Textures/Creator2SkeletonFixtures/DragonBones/NewDragonTest.json'), 'utf8'));
  const alternate = JSON.parse(JSON.stringify(source.armature[0].animation[0])); alternate.name = 'shifted';
  for (const frame of alternate.bone[0].frame) { frame.transform = frame.transform || {}; frame.transform.x = Number(frame.transform.x || 0) + 30; }
  source.armature[0].animation.push(alternate);
  const location = await call('asset.location', { url: 'db://assets/Textures/Creator2SkeletonFixtures/DragonBones/NewDragonMixTest.json' });
  if (!location.targetExists) await call('asset.create', { url: location.url!, content: JSON.stringify(source) });
  else assert.equal(await readFile(resolve(project, String(location.url).slice(5)), 'utf8'), JSON.stringify(source));
  const data = await call('asset.resolve', { reference: location.url! });
  const atlas = await call('asset.resolve', { reference: 'db://assets/Textures/Creator2SkeletonFixtures/DragonBones/texture.json' });
  const fixture = JSON.parse(await readFile(resolve(project, 'assets/Textures/Creator2SkeletonFixtures/DragonBones/NewDragonTest.json'), 'utf8'));
  const scene = Json.object((await call('scene.query')).scene).sceneId!;
  const nodeId = (await call('node.create', { parentId: scene, name: `DragonBonesFade-${Date.now()}` })).nodeId!;
  const editorComponent = (await call('component.add', { nodeId, type: 'dragonBones.ArmatureDisplay' })).componentId!;
  await call('component.set', { componentId: editorComponent, properties: { dragonAsset: { uuid: data.uuid! }, dragonAtlasAsset: { uuid: atlas.uuid! }, armatureName: fixture.armature[0].name, timeScale: 1 } });
  await call('scene.save'); await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const hierarchy = (await call('runtime.hierarchy', { limit: 2000 })).rows as JsonObject[];
  const componentId = ((hierarchy.find(row => row.nodeId === nodeId)!.components as JsonObject[]).find(row => row.type === 'dragonBones.ArmatureDisplay'))!.componentId!;
  const armature = Json.object((await call('runtime.invoke', { target: 'component:' + componentId, method: 'armature' })).value).handle!;
  const animation = Json.object((await call('runtime.get', { target: armature, path: 'animation' })).value).handle!;
  const modes = ['none', 'sameLayer', 'sameGroup', 'sameLayerAndGroup', 'all', 'single'];
  for (const mode of modes) {
    await call('runtime.invoke', { target: animation, method: 'reset' });
    await call('runtime.dragonbones.fade', { componentId, name: 'stand', duration: 0, playTimes: 0, layer: 0, group: 'base', fadeOutMode: 'none' });
    await call('runtime.dragonbones.fade', { componentId, name: 'shifted', duration: 0, playTimes: 0, layer: 1, group: 'other', fadeOutMode: 'none' });
    await call('runtime.shader.profile', { frames: 2, warmupFrames: 1 });
    const taskId = (await call('runtime.dragonbones.trace_start', { componentId, frames: 300, events: ['fadeIn','fadeInComplete','fadeOut','fadeOutComplete'] })).taskId!;
    const result = await call('runtime.dragonbones.fade', { componentId, name: 'stand', duration: 0.5, playTimes: 0, layer: 0, group: mode === 'sameGroup' ? 'other' : 'base', fadeOutMode: mode });
    assert.equal(result.reused, mode === 'single');
    const after = result.after as JsonObject[];
    const fading = after.filter(state => state.isFadeOut);
    assert.equal(fading.length, mode === 'all' ? 2 : ['none','single'].includes(mode) ? 0 : 1);
    if (mode === 'sameGroup') assert.equal(fading[0]!.name, 'shifted');
    if (['sameLayer','sameLayerAndGroup'].includes(mode)) assert.equal(fading[0]!.name, 'stand');
    await call('runtime.shader.profile', { frames: 3, warmupFrames: 1 });
    const during = (await call('runtime.dragonbones.details', { componentId })).states as JsonObject[];
    if (mode !== 'single') assert.ok(during.some(state => state.isFadeIn && Number(state.fadeProgress) > 0 && Number(state.fadeProgress) < 1));
    await call('runtime.shader.profile', { frames: 100, warmupFrames: 1 });
    const finished = (await call('runtime.dragonbones.details', { componentId })).states as JsonObject[];
    assert.ok(finished.every(state => !state.isFadeIn && !state.isFadeOut));
    assert.equal(finished.length, mode === 'single' ? 2 : 3 - fading.length);
    const events = Json.object((await call('runtime.task.stop', { taskId })).progress).rows as JsonObject[];
    if (mode !== 'single') {
      assert.ok(events.some(row => row.event === 'fadeIn')); assert.ok(events.some(row => row.event === 'fadeInComplete'));
      if (fading.length) { assert.ok(events.some(row => row.event === 'fadeOut')); assert.ok(events.some(row => row.event === 'fadeOutComplete')); }
    }
  }
  await call('runtime.invoke', { target: 'component:' + componentId, method: 'setAnimationCacheMode', args: [1] });
  await assert.rejects(() => call('runtime.dragonbones.fade', { componentId, name: 'stand', duration: 0.5 }), error => CocosError.from(error).code === 'UNSUPPORTED_CAPABILITY');
  await call('runtime.set', { target: `node:${nodeId}`, path: 'active', value: false });
  rows.push({ passed: true, sixFadeRulesVerified: true, fadeProgressVerified: true, nativeFadeEventsVerified: true, cachedModeRejected: true });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/dragonbones-fade.json'), JSON.stringify({ project, rows }, null, 2)); } }
