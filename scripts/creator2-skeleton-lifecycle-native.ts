import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';

const project = resolve('.codex-work/build/creator2-test-project'), registry = new ProjectRegistry(), { projectId } = await registry.add(project);
const gateway = new RuntimeGateway(registry), gatewayPort = await gateway.start(), app = new CocosApplication(registry, undefined, undefined, true, gateway);
let blocked = false, blockedRequests = 0, preview = false;
// 代理只转发到本测试进程的回环网关，凭证不进入日志或报告。
const proxy = createServer((incoming, response) => {
  if (blocked) { blockedRequests++; response.writeHead(503); response.end(); return; }
  const upstream = request({ hostname: '127.0.0.1', port: gatewayPort, path: incoming.url, method: incoming.method, headers: incoming.headers }, reply => {
    response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response);
  });
  upstream.on('error', () => { if (!response.destroyed) { response.writeHead(502); response.end(); } });
  response.on('close', () => upstream.destroy()); incoming.pipe(upstream);
});
await new Promise<void>(accept => proxy.listen(0, '127.0.0.1', accept));
const address = proxy.address(); assert.ok(address && typeof address !== 'string');
const configPath = resolve(project, '.codex-work/cache/cocos-mcp', `runtime-${process.pid}.json`);
const config = JSON.parse(await readFile(configPath, 'utf8'));
await writeFile(configPath, JSON.stringify({ ...config, url: `http://127.0.0.1:${address.port}` }), { mode: 0o600 });
const rows: JsonObject[] = [];
const call = async (id: string, params: JsonObject = {}): Promise<JsonObject> => { const result = Json.object((await app.execute({ projectId, capabilityId: id, params })).result); rows.push({ id, result }); console.log(`PASS ${id}`); return result; };
try {
  const type = 'CocosMcpSkeletonLifecycleProbe';
  const location = await call('asset.location', { url: 'db://assets/Scripts/' + type + '.js' });
  const fixtureSource = "cc.Class({ name: 'CocosMcpSkeletonLifecycleProbe', extends: cc.Component, properties: { completes: 0 }, onLoad: function() { var self = this; this.skeleton = this.getComponent(sp.Skeleton); this.dragon = this.getComponent(dragonBones.ArmatureDisplay); this.business = function() { self.completes++; }; if (this.skeleton) this.skeleton.setCompleteListener(this.business); else this.dragon.on('loopComplete', this.business); }, listenerCount: function() { if (this.skeleton) { var state = this.skeleton.getState(); return state ? state.listeners.length : 0; } var table = this.dragon._eventTarget._callbackTable; return ['start','loopComplete','complete'].reduce(function(sum,key) { return sum + (table[key] ? table[key].callbackInfos.filter(function(info) { return info && info.callback; }).length : 0); },0); }, callbackRestored: function() { return this.skeleton ? this.skeleton._listener.complete === this.business : this.dragon._eventTarget.hasEventListener('loopComplete', this.business); } });";
  if (location.targetExists) {
    assert.ok(String(location.url).startsWith('db://assets/'));
    assert.equal(await readFile(resolve(project, String(location.url).slice(5)), 'utf8'), fixtureSource, 'Existing lifecycle fixture source differs');
  } else await call('asset.create', { url: location.url!, content: fixtureSource });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (((await call('component.types')).rows as JsonObject[]).some(row => row.name === type)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready);
  const spineAsset = (await call('asset.resolve', { reference: 'db://assets/Textures/Creator2SkeletonFixtures/Spine/raptor.json' })).uuid!;
  const dragonAsset = (await call('asset.resolve', { reference: 'db://assets/Textures/Creator2SkeletonFixtures/DragonBones/NewDragonTest.json' })).uuid!;
  const atlas = (await call('asset.resolve', { reference: 'db://assets/Textures/Creator2SkeletonFixtures/DragonBones/texture.json' })).uuid!;
  const dragonData = JSON.parse(await readFile(resolve(project, 'assets/Textures/Creator2SkeletonFixtures/DragonBones/NewDragonTest.json'), 'utf8'));
  for (const node of (await call('scene.hierarchy', { limit: 2000 })).rows as JsonObject[]) if (String(node.name).startsWith('SkeletonLifecycle-')) await call('node.set', { nodeId: node.nodeId!, properties: { active: false } });
  const scene = Json.object((await call('scene.query')).scene).sceneId!;
  const root = (await call('node.create', { parentId: scene, name: 'SkeletonLifecycle-' + Date.now() })).nodeId!;
  const fixtures: JsonObject[] = [];
  for (const family of ['spine', 'spine-cache', 'dragonbones']) {
    const nodeId = (await call('node.create', { parentId: root, name: family })).nodeId!;
    const componentType = family === 'dragonbones' ? 'dragonBones.ArmatureDisplay' : 'sp.Skeleton';
    const componentId = (await call('component.add', { nodeId, type: componentType })).componentId!;
    await call('component.set', { componentId, properties: family === 'dragonbones' ? { dragonAsset: { uuid: dragonAsset }, dragonAtlasAsset: { uuid: atlas }, armatureName: dragonData.armature[0].name, timeScale: 10 } : { skeletonData: { uuid: spineAsset }, timeScale: 10 } });
    await call('component.add', { nodeId, type }); fixtures.push({ family, nodeId, componentType });
  }
  await call('scene.save'); await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort: address.port });
  const hierarchy = (await call('runtime.hierarchy', { limit: 2000 })).rows as JsonObject[];
  const invokeProbe = async (fixture: JsonObject, method: string) => (await call('runtime.invoke', { target: 'component:' + fixture.probeId, method })).value;
  for (const fixture of fixtures) {
    const components = hierarchy.find(row => row.nodeId === fixture.nodeId)!.components as JsonObject[];
    fixture.componentId = components.find(row => row.type === fixture.componentType)!.componentId!;
    fixture.probeId = components.find(row => row.type === type)!.componentId!;
    if (fixture.family === 'spine-cache') await call('runtime.invoke', { target: 'component:' + fixture.componentId, method: 'setAnimationCacheMode', args: [1] });
    const family = fixture.family === 'dragonbones' ? 'dragonbones' : 'spine';
    fixture.apiFamily = family;
    fixture.name = ((await call('runtime.' + family + '.inspect', { componentId: fixture.componentId })).animations as string[])[0]!;
    fixture.listenerCount = (await invokeProbe(fixture, 'listenerCount'))!;
  }
  const start = async () => {
    const tasks: JsonObject[] = [];
    for (const fixture of fixtures) {
      const task = await call('runtime.' + fixture.apiFamily + '.trace_start', { componentId: fixture.componentId!, frames: 300 });
      await call('runtime.' + fixture.apiFamily + '.play', { componentId: fixture.componentId!, name: fixture.name!, ...(fixture.apiFamily === 'spine' ? { loop: true } : { playTimes: 0 }) });
      tasks.push(task);
    }
    for (const task of tasks) assert.equal((await call('runtime.task.poll', { taskId: task.taskId! })).status, 'running');
    return tasks;
  };
  const verify = async (tasks: JsonObject[]) => {
    for (const task of tasks) await assert.rejects(() => call('runtime.task.poll', { taskId: task.taskId! }), error => CocosError.from(error).code === 'STALE_HANDLE');
    for (const fixture of fixtures) {
      assert.equal(await invokeProbe(fixture, 'listenerCount'), fixture.listenerCount);
      assert.equal(await invokeProbe(fixture, 'callbackRestored'), true);
      const beforeCount = Number((await call('runtime.get', { target: 'component:' + fixture.probeId, path: 'completes' })).value);
      await call('runtime.shader.profile', { frames: 40, warmupFrames: 1 });
      assert.ok(Number((await call('runtime.get', { target: 'component:' + fixture.probeId, path: 'completes' })).value) > beforeCount);
    }
  };
  const verifiedModes: JsonObject[] = [];
  for (const modes of [{ spine: 1, dragon: 0 }, { spine: 2, dragon: 1 }, { spine: 1, dragon: 2 }]) {
    rows.push({ lifecycleModes: modes });
    for (const fixture of fixtures) if (fixture.family !== 'spine') await call('runtime.invoke', { target: 'component:' + fixture.componentId, method: 'setAnimationCacheMode', args: [fixture.family === 'spine-cache' ? modes.spine : modes.dragon] });
    const before = await call('runtime.query');
    const instance = (Json.object(gateway.list(projectId)).rows as JsonObject[])[0]!.runtimeInstanceId;
    const tasks = await start();
    const previousBlockedRequests = blockedRequests;
    blocked = true; proxy.closeAllConnections();
    for (let attempt = 0; attempt < 60 && blockedRequests === previousBlockedRequests; attempt++) await new Promise(accept => setTimeout(accept, 100));
    assert.ok(blockedRequests > previousBlockedRequests); blocked = false;
    const after = await call('runtime.query');
    assert.equal((Json.object(gateway.list(projectId)).rows as JsonObject[])[0]!.runtimeInstanceId, instance);
    assert.equal(Json.object(after.scene).sceneId, Json.object(before.scene).sceneId);
    assert.ok(Number(after.generation) > Number(before.generation)); assert.deepEqual(after.cleanupErrors, []);
    await verify(tasks);
    await call('runtime.invoke', { target: 'cc.game', method: 'addPersistRootNode', args: [{ $node: root }] });
    const sceneTasks = await start();
    await call('asset.location', { url: 'db://assets/Scenes/SkeletonLifecycle.fire' });
    const next = Json.object((await call('runtime.create', { type: 'cc.Scene', args: ['SkeletonLifecycle'] })).object).handle!;
    await call('runtime.invoke', { target: 'cc.director', method: 'runSceneImmediate', args: [{ $handle: next }] });
    const transition = await call('runtime.query'); assert.notEqual(Json.object(transition.scene).sceneId, Json.object(after.scene).sceneId);
    assert.deepEqual(transition.cleanupErrors, []); await verify(sceneTasks);
    const reacquired = await start();
    for (const task of reacquired) assert.equal((await call('runtime.task.stop', { taskId: task.taskId! })).status, 'cancelled');
    for (const fixture of fixtures) { assert.equal(await invokeProbe(fixture, 'callbackRestored'), true); assert.equal(await invokeProbe(fixture, 'listenerCount'), fixture.listenerCount); }
    await call('runtime.invoke', { target: 'cc.game', method: 'removePersistRootNode', args: [{ $node: root }] });
    verifiedModes.push(modes);
  }
  await call('runtime.set', { target: 'node:' + root, path: 'active', value: false });
  rows.push({ passed: true, verifiedModes, pureDisconnectVerified: true, sceneTransitionVerified: true, nativeListenerCleanupVerified: true, businessCallbacksPreserved: true, ownershipReacquired: true, sameRuntimeInstance: true });
} catch (error) { if (preview) { try { await call('preview.logs'); } catch {} } rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally {
  blocked = false;
  try { if (preview) await call('preview.stop'); }
  finally {
    proxy.closeAllConnections(); await new Promise<void>(accept => proxy.close(() => accept())); await gateway.close();
    await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true });
    await writeFile(resolve('.codex-work/logs/creator2-expansion/skeleton-lifecycle.json'), JSON.stringify({ project, rows }, null, 2));
  }
}
