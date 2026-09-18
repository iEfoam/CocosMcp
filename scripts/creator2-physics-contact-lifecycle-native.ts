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
// 仅阻断本测试的回环网关，不断开编辑器或重启预览；凭证不进入报告。
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
const call = async (id: string, params: JsonObject = {}): Promise<JsonObject> => { const result = Json.object((await app.execute({ projectId, capabilityId: id, params })).result); rows.push({ id, params, result }); console.log(`PASS ${id}`); return result; };
const sample = async (frames: number) => {
  // 此脚本拥有整个测试预览；记录暂停状态后显式恢复，不改业务 EVENT_HIDE 监听或 FrameSession 行为。
  const paused = (await call('runtime.invoke', { target: 'cc.game', method: 'isPaused' })).value;
  if (paused === true) await call('runtime.resume');
  return call('runtime.shader.profile', { frames, warmupFrames: 1 });
};
try {
  const editor = (await call('scene.hierarchy', { limit: 2000 })).rows as JsonObject[];
  const root = editor.filter(row => String(row.name).startsWith('PhysicsContact-')).at(-1)?.nodeId;
  assert.ok(root, 'Run creator2-physics-contact-native first to install the contact fixture');
  await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort: address.port });
  await call('runtime.pause');
  await assert.rejects(() => call('runtime.shader.profile', { frames: 2, warmupFrames: 1 }), error => {
    const failure = CocosError.from(error);
    rows.push({ expectedPausedFrameError: failure.toJSON() as unknown as JsonObject });
    return failure.code === 'CONTEXT_UNAVAILABLE' && Json.object(failure.details).gamePaused === true && Json.object(failure.details).timeoutMs === 2000;
  });
  assert.equal((await call('runtime.invoke', { target: 'cc.game', method: 'isPaused' })).value, true);
  await call('runtime.resume');
  const physics = Json.object((await call('runtime.invoke', { target: 'cc.director', method: 'getPhysicsManager' })).value).handle!;
  await call('runtime.set', { target: physics, path: 'enabled', value: true });
  await call('runtime.set', { target: physics, path: 'gravity', value: { x: 0, y: -320 } });
  await call('runtime.set', { target: `node:${root}`, path: 'active', value: true });
  await call('runtime.invoke', { target: 'cc.game', method: 'isPaused' });
  await call('runtime.invoke', { target: 'cc.director', method: 'isPaused' });
  await sample(80);
  const baseline = await call('runtime.hierarchy', { limit: 2000 });
  const fixtureNodes = (baseline.rows as JsonObject[]).filter(row => row.parentId === root);
  const bodyNode = fixtureNodes.find(row => row.name === 'body')!;
  const components = bodyNode.components as JsonObject[];
  const business = components.find(row => row.type === 'CocosMcpPhysicsContactProbe')!.componentId!;
  const body = components.find(row => row.type === 'cc.RigidBody')!.componentId!;
  const counts = (hierarchy: JsonObject) => (hierarchy.rows as JsonObject[]).filter(row => fixtureNodes.some(node => node.nodeId === row.nodeId)).map(row => ({ nodeId: row.nodeId, count: (row.components as unknown[]).length }));
  const start = async () => {
    const task = await call('runtime.physics2d.contact_trace_start', { rootId: root, frames: 300, limit: 100 });
    assert.equal((await call('runtime.task.poll', { taskId: task.taskId! })).status, 'running');
    return task.taskId!;
  };
  const verify = async (taskId: NonNullable<JsonObject[string]>) => {
    await assert.rejects(() => call('runtime.task.poll', { taskId }), error => CocosError.from(error).code === 'STALE_HANDLE');
    await sample(3);
    assert.deepEqual(counts(await call('runtime.hierarchy', { limit: 2000 })), counts(baseline));
    assert.equal((await call('runtime.get', { target: 'component:' + body, path: 'enabledContactListener' })).value, true);
    const before = Number((await call('runtime.get', { target: 'component:' + business, path: 'posts' })).value);
    await sample(10);
    assert.ok(Number((await call('runtime.get', { target: 'component:' + business, path: 'posts' })).value) > before);
    const next = await start();
    assert.equal((await call('runtime.task.stop', { taskId: next })).status, 'cancelled');
    await sample(2);
    assert.deepEqual(counts(await call('runtime.hierarchy', { limit: 2000 })), counts(baseline));
  };
  const before = await call('runtime.query');
  const instance = (Json.object(gateway.list(projectId)).rows as JsonObject[])[0]!.runtimeInstanceId;
  const taskId = await start();
  blocked = true; proxy.closeAllConnections();
  for (let attempt = 0; attempt < 60 && blockedRequests === 0; attempt++) await new Promise(accept => setTimeout(accept, 100));
  assert.ok(blockedRequests > 0); blocked = false;
  const after = await call('runtime.query');
  assert.equal((Json.object(gateway.list(projectId)).rows as JsonObject[])[0]!.runtimeInstanceId, instance);
  assert.equal(Json.object(after.scene).sceneId, Json.object(before.scene).sceneId);
  assert.ok(Number(after.generation) > Number(before.generation)); assert.deepEqual(after.cleanupErrors, []);
  await verify(taskId);
  await call('runtime.invoke', { target: 'cc.game', method: 'addPersistRootNode', args: [{ $node: root }] });
  const sceneTask = await start();
  await call('asset.location', { url: 'db://assets/Scenes/PhysicsContactLifecycle.fire' });
  const nextScene = Json.object((await call('runtime.create', { type: 'cc.Scene', args: ['PhysicsContactLifecycle'] })).object).handle!;
  await call('runtime.invoke', { target: 'cc.director', method: 'runSceneImmediate', args: [{ $handle: nextScene }] });
  const transition = await call('runtime.query');
  assert.notEqual(Json.object(transition.scene).sceneId, Json.object(after.scene).sceneId);
  assert.deepEqual(transition.cleanupErrors, []); await verify(sceneTask);
  await call('runtime.invoke', { target: 'cc.game', method: 'removePersistRootNode', args: [{ $node: root }] });
  await call('runtime.set', { target: 'node:' + root, path: 'active', value: false });
  rows.push({ passed: true, pausedFrameDiagnosticsVerified: true, pureDisconnectVerified: true, sameRuntimeInstance: true, sceneTransitionVerified: true, nativeObserverCleanupVerified: true, businessCallbacksContinued: true, listenerSwitchPreserved: true, restartAfterCleanupVerified: true, blockedRequests });
} catch (error) {
  if (preview) {
    for (const target of ['cc.game', 'cc.director']) { try { await call('runtime.invoke', { target, method: 'isPaused' }); } catch {} }
    try { await call('preview.logs'); } catch {}
  }
  rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error);
} finally {
  blocked = false;
  try { if (preview) await call('preview.stop'); }
  finally {
    proxy.closeAllConnections(); await new Promise<void>(accept => proxy.close(() => accept())); await gateway.close();
    await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true });
    await writeFile(resolve('.codex-work/logs/creator2-expansion/physics-contact-lifecycle.json'), JSON.stringify({ project, rows }, null, 2));
  }
}
