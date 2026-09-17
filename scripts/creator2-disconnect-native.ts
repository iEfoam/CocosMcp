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
  const editor = (await call('scene.hierarchy', { limit: 2000 })).rows as JsonObject[];
  const root = editor.filter(row => String(row.name).startsWith('TaskCoverage-')).at(-1)?.nodeId;
  assert.ok(root, 'Run creator2-task-native first to install the collider fixture');
  await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort: address.port });
  await call('runtime.set', { target: `node:${root}`, path: 'active', value: true });
  const manager = Json.object((await call('runtime.invoke', { target: 'cc.director', method: 'getCollisionManager' })).value).handle!;
  await call('runtime.set', { target: manager, path: 'enabled', value: true });
  const before = await call('runtime.query'), baseline = await call('runtime.hierarchy', { limit: 2000 });
  const instance = (Json.object(gateway.list(projectId)).rows as JsonObject[])[0]!.runtimeInstanceId;
  const task = await call('runtime.collision2d.trace_start', { rootId: root, frames: 300, limit: 50 });
  assert.equal((await call('runtime.task.poll', { taskId: task.taskId! })).status, 'running');
  const tween = await call('runtime.tween.start', { nodeId: root, steps: [{ action: 'by', duration: 4, properties: { x: 1000 } }] });
  assert.equal((await call('runtime.task.poll', { taskId: tween.taskId! })).status, 'running');
  blocked = true; proxy.closeAllConnections();
  for (let attempt = 0; attempt < 60 && blockedRequests === 0; attempt++) await new Promise(accept => setTimeout(accept, 100));
  assert.ok(blockedRequests > 0, 'Runtime must attempt a poll while transport is unavailable');
  blocked = false;
  const after = await call('runtime.query');
  assert.equal((Json.object(gateway.list(projectId)).rows as JsonObject[])[0]!.runtimeInstanceId, instance);
  assert.equal(Json.object(after.scene).sceneId, Json.object(before.scene).sceneId);
  assert.ok(Number(after.generation) > Number(before.generation));
  await assert.rejects(() => call('runtime.task.poll', { taskId: task.taskId! }), error => CocosError.from(error).code === 'STALE_HANDLE');
  await assert.rejects(() => call('runtime.task.poll', { taskId: tween.taskId! }), error => CocosError.from(error).code === 'STALE_HANDLE');
  const stoppedX = (await call('runtime.get', { target: `node:${root}`, path: 'x' })).value;
  await call('runtime.shader.profile', { frames: 2, warmupFrames: 1 });
  const restored = await call('runtime.hierarchy', { limit: 2000 });
  const counts = (value: JsonObject) => (value.rows as JsonObject[]).map(row => ({ nodeId: row.nodeId, count: (row.components as unknown[]).length }));
  assert.deepEqual(counts(restored), counts(baseline));
  assert.deepEqual(after.cleanupErrors, []);
  assert.equal((await call('runtime.get', { target: `node:${root}`, path: 'x' })).value, stoppedX);
  assert.equal((await call('runtime.invoke', { target: `node:${root}`, method: 'getNumberOfRunningActions' })).value, 0);
  const reacquired = await call('runtime.tween.start', { nodeId: root, steps: [{ action: 'by', duration: 0.01, properties: { x: 1 } }] });
  await call('runtime.shader.profile', { frames: 4, warmupFrames: 1 });
  assert.equal((await call('runtime.task.poll', { taskId: reacquired.taskId! })).status, 'completed');
  await call('runtime.set', { target: `node:${root}`, path: 'active', value: false });
  rows.push({ passed: true, sameRuntimeInstance: true, previewRestarted: false, blockedRequests, generationBefore: before.generation!, generationAfter: after.generation! });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally {
  blocked = false;
  try { if (preview) await call('preview.stop'); }
  finally {
    proxy.closeAllConnections(); await new Promise<void>(accept => proxy.close(() => accept())); await gateway.close();
    await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true });
    await writeFile(resolve('.codex-work/logs/creator2-expansion/disconnect.json'), JSON.stringify({ project, rows }, null, 2));
  }
}
