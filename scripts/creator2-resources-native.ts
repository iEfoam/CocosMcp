import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';

const project = resolve('.codex-work/build/creator2-test-project'), registry = new ProjectRegistry(), { projectId } = await registry.add(project);
const gateway = new RuntimeGateway(registry), gatewayPort = await gateway.start(), app = new CocosApplication(registry, undefined, undefined, true, gateway);
const rows: JsonObject[] = []; let preview = false, handle: string | undefined;
const call = async (id: string, params: JsonObject = {}): Promise<JsonObject> => { const result = Json.object((await app.execute({ projectId, capabilityId: id, params })).result); rows.push({ id, result }); console.log(`PASS ${id}`); return result; };
try {
  await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const baseline = await call('runtime.resources.snapshot');
  assert.equal(baseline.engineVersion, '2.4.15'); assert.equal(baseline.complete, true);
  // 使用场景已持有的资源，排除首次解析依赖造成的额外引用变化。
  const asset = (baseline.rows as JsonObject[]).find(row => typeof row.uuid === 'string' && /^[0-9a-f-]{36}$/i.test(row.uuid) && typeof row.refCount === 'number' && row.refCount > 0);
  assert.ok(asset, 'Expected a scene-owned full-UUID asset in the independent fixture');
  const loaded = await call('runtime.asset.load', { uuid: asset.uuid! }); handle = String(loaded.handle);
  const acquired = await call('runtime.resources.diff', { baseline });
  assert.equal(acquired.sameRuntimeVerified, true);
  const change = (acquired.rows as JsonObject[]).find(row => row.key === asset.key);
  assert.equal(change?.status, 'changed'); assert.equal(Json.object(change!.after).refCount, Number(asset.refCount) + 1);
  await call('runtime.asset.release', { handle }); handle = undefined;
  const released = await call('runtime.resources.diff', { baseline: acquired.current! });
  const restored = (Json.object(released.current).rows as JsonObject[]).find(row => row.key === asset.key);
  assert.equal(restored?.refCount, asset.refCount); assert.equal(released.leakDetected, null);
  assert.equal(released.sameRuntimeVerified, true);
  const altered = await call('runtime.resources.diff', { baseline: { ...released.current as JsonObject, runtimeId: 'different-preview-instance' } });
  assert.equal(altered.sameRuntimeVerified, false);
  assert.equal(altered.baselineVerification, 'different-or-unknown-runtime');
  // 只在预览中创建临时场景；仍先查询工程目录策略，不向 assets 根目录写入夹具。
  await call('asset.location', { url: 'db://assets/Scenes/ResourceTransition.fire' });
  const owned = await call('runtime.asset.load', { uuid: asset.uuid! }); handle = String(owned.handle);
  const beforeScene = await call('runtime.resources.snapshot');
  const next = Json.object((await call('runtime.create', { type: 'cc.Scene', args: ['ResourceTransition'] })).object).handle!;
  await call('runtime.invoke', { target: 'cc.director', method: 'runSceneImmediate', args: [{ $handle: next }] });
  const transition = await call('runtime.resources.diff', { baseline: beforeScene });
  assert.equal(transition.sameRuntimeVerified, true);
  assert.notEqual(transition.beforeSceneId, transition.afterSceneId);
  await assert.rejects(() => call('runtime.asset.inspect', { handle: handle! }), error => CocosError.from(error).code === 'STALE_HANDLE');
  handle = undefined;
  const resident = (Json.object(transition.current).rows as JsonObject[]).find(row => row.key === asset.key);
  assert.ok(!resident || Number(resident.refCount) <= Number(owned.refCount) - 1, 'Scene transition must release the MCP-owned reference');
  const second = Json.object((await call('runtime.create', { type: 'cc.Scene', args: ['ResourceTransitionSecond'] })).object).handle!;
  await call('runtime.invoke', { target: 'cc.director', method: 'runSceneImmediate', args: [{ $handle: second }] });
  const repeated = await call('runtime.resources.diff', { baseline: transition.current! });
  assert.equal(repeated.sameRuntimeVerified, true);
  assert.notEqual(repeated.beforeSceneId, repeated.afterSceneId);
  const trend = await call('runtime.resources.trend', { snapshotIds: [beforeScene.snapshotId!, Json.object(transition.current).snapshotId!, Json.object(repeated.current).snapshotId!] });
  assert.equal(trend.sameRuntimeVerified, true); assert.equal(trend.leakDetected, null);
  assert.equal((trend.points as JsonObject[]).length, 3);
  const observed = (trend.rows as JsonObject[]).find(row => row.key === asset.key);
  assert.ok(observed); assert.equal((observed.present as boolean[])[0], true);
  rows.push({ crossSceneVerified: true, ownedHandleExpired: true, residentAfterTransition: Boolean(resident), leakDetected: null });
  await call('preview.stop'); preview = false;
  await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const restarted = await call('runtime.resources.diff', { baseline: released.current! });
  assert.equal(restarted.sameRuntimeVerified, false);
  assert.notEqual(Json.object(restarted.current).runtimeId, Json.object(released.current).runtimeId);
  rows.push({ passed: true, uuid: asset.uuid!, assertions: 'native cache snapshot, owned load increments reference, release restores reference while scene asset remains cached' });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally {
  try { if (handle) await call('runtime.asset.release', { handle }); }
  finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/resources.json'), JSON.stringify({ project, rows }, null, 2)); } }
}
