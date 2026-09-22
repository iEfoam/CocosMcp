import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
import { MaterialController } from '../packages/runtime3-bridge/src/material.js';
import { ShaderPreview } from '../packages/runtime3-bridge/src/shader-preview.js';

class Texture2D {} class TextureCube {} class RenderTexture {} class ImageAsset {}
test('texture binding accepts public texture classes without TextureBase and rejects ImageAsset', async () => {
  let asset: unknown;
  const material = new MaterialController({ major: 3, cc: { Texture2D, TextureCube, RenderTexture,
    assetManager: { loadAny: (_id: string, callback: (error: null, asset: unknown) => void) => callback(null, asset) } } });
  for (const Type of [Texture2D, TextureCube, RenderTexture]) { asset = new Type(); assert.equal(await material.load('texture', 'TextureBase'), asset); }
  asset = new ImageAsset(); await assert.rejects(material.load('image', 'TextureBase'), /Expected TextureBase/);
});

test('gateway expires sessions consistently, keeps genuine ambiguity and rejects foreign replies', async () => {
  const root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/gateway-regression-'));
  const registry = new ProjectRegistry(), project = await registry.add(root);
  let now = Date.now(); const gateway = new RuntimeGateway(registry, 1000, 30000, () => now);
  await gateway.start();
  try {
    const config = JSON.parse(await readFile(join(root, '.codex-work/cache/cocos-mcp', `runtime-${process.pid}.json`), 'utf8'));
    const request = async (path: string, body: JsonObject = {}): Promise<JsonObject> => {
      const response = await fetch(config.url + '/runtime/' + path, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: project.projectId, ...body }) });
      return await response.json() as JsonObject;
    };
    const first = await request('register'); now += 30000;
    const second = await request('register');
    assert.equal((Json.object(gateway.list(project.projectId)).rows as unknown[]).length, 1);
    await assert.rejects(gateway.execute(project.projectId, String(first.runtimeInstanceId), 'runtime.query', {}), { code: 'CONTEXT_UNAVAILABLE' });
    const operation = gateway.execute(project.projectId, undefined, 'runtime.query', {});
    const command = Json.object((await request('poll', second)).command);
    const third = await request('register');
    await assert.rejects(gateway.execute(project.projectId, undefined, 'runtime.query', {}), { code: 'AMBIGUOUS_TARGET' });
    assert.equal((await request('reply', { ...third, commandId: command.id!, result: 'wrong' })).accepted, false);
    await request('reply', { ...second, commandId: command.id!, result: 'correct' }); assert.equal(await operation, 'correct');
    const pending = gateway.execute(project.projectId, String(second.runtimeInstanceId), 'runtime.query', {});
    const rejected = assert.rejects(pending, { code: 'OUTCOME_UNKNOWN' });
    await request('disconnect', second); await rejected;
    now += 30000; assert.deepEqual(Json.object(gateway.list(project.projectId)).rows, []);
  } finally { await gateway.close(); }
});

test('workflow references bind runtime, poll reads freshly and preserve recovery checkpoints', async () => {
  const root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/workflow-regression-'));
  const registry = new ProjectRegistry(), project = await registry.add(root); let calls = 0;
  const app = new CocosApplication(registry, undefined, undefined, false, { execute: async (_project, runtime, id, params) => {
    if (id === 'runtime.query') return { runtimeInstanceId: 'bound', target: 'scene' };
    assert.equal(runtime, 'bound'); assert.equal(params.target, 'scene'); return { value: ++calls >= 2 };
  } });
  const steps = [{ capabilityId: 'runtime.query', params: {} }, { capabilityId: 'runtime.get', params: { path: 'active' },
    paramRefs: { target: { step: 0, path: 'target' } }, runtimeRef: { step: 0, path: 'runtimeInstanceId' }, waitFor: { path: 'value', equals: true, intervalMs: 10, timeoutMs: 1000 } }];
  const result = Json.object(await app.executeWorkflow(project.projectId, steps, undefined, false, 'refs'));
  assert.equal(result.status, 'succeeded'); assert.equal(calls, 2);
  await assert.rejects(app.executeWorkflow(project.projectId, steps, undefined, false, 'refs'), { code: 'OPERATION_CONFLICT' });
  assert.equal(calls, 2);
  const invalid = Json.object(app.plan(project.projectId, [{ capabilityId: 'runtime.set', params: { target: 'scene', path: 'active', value: false }, waitFor: { path: 'value', equals: true } }]));
  assert.equal(invalid.valid, false);
  assert.equal(Json.object(app.plan(project.projectId, [{ capabilityId: 'runtime.get', params: { path: 'active' }, paramRefs: { target: { step: 0, path: 'target' } } }])).valid, false);
  const failed = Json.object(await app.executeWorkflow(project.projectId, [{ capabilityId: 'runtime.query', params: {} }, { capabilityId: 'runtime.get', params: { path: 'active' }, paramRefs: { target: { step: 0, path: 'missing' } } }]));
  assert.equal(failed.completed, 1); assert.equal(failed.status, 'failed');
  assert.equal(Json.object(await app.workflow(project.projectId, String(failed.workflowId))).status, 'failed');
});

test('profile exposes real viewport, warmup, tail latency and frame budget without GPU claims', async () => {
  let frames = 0;
  const cc = { game: { canvas: { width: 2200, height: 1440, getBoundingClientRect: () => ({ width: 1100, height: 720 }) } },
    Director: { EVENT_AFTER_DRAW: 'after-draw' }, director: { once: (_event: string, done: () => void) => { frames++; setTimeout(done, 2); }, off: () => {} } };
  const preview = new ShaderPreview({ major: 3, cc }, new MaterialController({ major: 3, cc }));
  const profile = await preview.execute('runtime.shader.profile', { frames: 3, warmupFrames: 2, maxFrameMs: 0.00001 });
  assert.equal(frames, 5); assert.equal(profile.warmupFrames, 2); assert.equal(profile.gpuMs, null);
  assert.equal(Json.object(profile.viewport).width, 2200); assert.equal(Json.object(profile.budget).passed, false);
  assert.ok(Number(profile.p99Ms) >= Number(profile.p95Ms)); assert.equal((profile.warnings as unknown[]).length, 1);
  await assert.rejects(preview.execute('runtime.shader.profile', { warmupFrames: 0 }), /Invalid warmup/);
});
