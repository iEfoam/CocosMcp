import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ShaderVariants, ShaderDiagnostics, MaterialValues } from '../packages/shader-core/src/index.js';
import { ShaderService } from '../packages/creator3-adapter/src/shader.js';
import { MaterialController } from '../packages/runtime3-bridge/src/material.js';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { Json, type JsonObject, type JsonValue } from '../packages/contracts/src/index.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';
import type { RuntimeObject } from '../packages/runtime3-bridge/src/access.js';

class AssetHarness {
  root = '';
  service!: ShaderService;
  async create(): Promise<void> {
    this.root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/shader-test-'));
    await mkdir(join(this.root, 'assets'));
    const port = { version: '3.8.8', projectPath: this.root,
      request: async (_channel: string, method: string, url: string, content: string): Promise<unknown> => {
        const path = join(this.root, 'assets', url.slice('db://assets/'.length));
        if (method === 'query-asset-info') return readFile(path).then(() => ({ uuid: 'asset' }), () => null);
        if (method === 'create-asset' || method === 'save-asset') { await writeFile(path, content); return { uuid: 'asset' }; }
        throw new Error(`Unexpected asset method ${method}`);
      },
      shader: async (): Promise<JsonValue> => ({ status: 'passed', compiled: { techniques: [], shaders: [] }, rows: [], dependencies: [] }),
    } as unknown as EditorPort;
    this.service = new ShaderService(port);
  }
  async call(id: string, params: JsonObject): Promise<JsonObject> { return Json.object(await this.service.execute(id, params)); }
}

test('Shader catalog rejects missing hash, unknown fields and unbounded workloads', () => {
  const catalog = new CapabilityCatalog();
  assert.throws(() => catalog.validate('shader.update', { url: 'db://assets/x.effect', content: 'x' }), /expectedHash/);
  assert.throws(() => catalog.validate('shader.compile', { url: 'x', arbitrary: true }), /additional/);
  assert.throws(() => catalog.validate('runtime.shader.profile', { frames: 301 }));
  assert.throws(() => catalog.validate('runtime.shader.preview.open', { materialUuid: 'x', width: 99999 }));
  for (const row of catalog.search('', 'F22').rows) assert.deepEqual(row.supportedMajors, [3]);
});

test('variant plans deduplicate scalar axes and reject combinations before expansion', () => {
  const planner = new ShaderVariants();
  assert.equal(planner.plan({ USE_MAP: [true, false, true], MODE: [1, 2] }).total, 4);
  assert.throws(() => planner.plan({ A: [1, 2, 3], B: [1, 2, 3] }, 8), /budget/);
  assert.throws(() => planner.plan({ A: [{}] }), /scalar/);
  assert.throws(() => planner.plan({ 'bad;name': [1] }), /macro name/);
});

test('native diagnostic locations never claim an exact source mapping', () => {
  const row = new ShaderDiagnostics().from('EFX2201 line 17: bad uniform', 'db://assets/x.effect');
  assert.equal(row.code, 'EFX2201'); assert.equal(row.line, 17); assert.equal(row.locationAccuracy, 'generated');
});

test('material value validation rejects unknown names, malformed vectors and non-finite values', () => {
  const validator = new MaterialValues();
  assert.throws(() => validator.validate({ missing: 1 }, { tint: {} }), /Unknown/);
  assert.throws(() => validator.validate({ tint: { type: 'vec4', value: [1, 2] } }, { tint: {} }), /vector/);
  assert.throws(() => validator.validate({ tint: Number.NaN }, { tint: {} }), /finite/);
  assert.throws(() => validator.validate({ tint: 'asset-path' }, { tint: {} }), /explicit/);
});

test('resource updates preserve conflicting edits and restore only expected content', async () => {
  const harness = new AssetHarness(); await harness.create(); const url = 'db://assets/test.effect';
  const created = await harness.call('shader.create', { url, content: 'first' });
  await assert.rejects(harness.call('shader.create', { url, content: 'overwrite' }), /already exists/);
  const updated = await harness.call('shader.update', { url, content: 'second', expectedHash: created.sourceHash! });
  await assert.rejects(harness.call('shader.update', { url, content: 'third', expectedHash: created.sourceHash! }), /changed/);
  await assert.rejects(harness.call('shader.restore', { backupId: updated.backupId!, expectedHash: created.sourceHash! }), /changed/);
  const restored = await harness.call('shader.restore', { backupId: updated.backupId!, expectedHash: updated.sourceHash! });
  assert.equal(restored.content, 'first'); assert.ok(restored.backupId);
});

test('compile tasks detect stale sources and remain readable across controller restarts', async () => {
  const harness = new AssetHarness(); await harness.create(); const url = 'db://assets/test.effect';
  const created = await harness.call('shader.create', { url, content: 'first' });
  const task = await harness.call('shader.compile', { url }); assert.equal(task.gpuValidation, 'not-run'); assert.equal(task.compiled, undefined);
  await harness.call('shader.update', { url, content: 'second', expectedHash: created.sourceHash! });
  const status = await harness.call('shader.diagnostics', { taskId: task.taskId! }); assert.equal(status.stale, true);
  const restarted = new ShaderService({ projectPath: harness.root, version: '3.8.8' } as EditorPort);
  assert.equal(Json.object(await restarted.execute('shader.diagnostics', { taskId: task.taskId! })).stale, true);
});

test('shader source readers reject traversal, symlinks and backup ID traversal', async () => {
  const harness = new AssetHarness(); await harness.create();
  await assert.rejects(harness.call('shader.read', { url: 'db://assets/../../outside.effect' }), /traversal/);
  await symlink(process.cwd(), join(harness.root, 'assets', 'outside'));
  await assert.rejects(harness.call('shader.read', { url: 'db://assets/outside/private.effect' }), /link/);
  await assert.rejects(harness.call('shader.restore', { backupId: '../outside', expectedHash: 'x' }), /Invalid backup/);
});

class MockMaterial {
  uuid = 'shared'; isValid = true; parent?: MockMaterial;
  effectAsset = { uuid: 'effect', shaders: [{ defines: [{ name: 'USE_MAP', type: 'boolean' }] }] };
  technique = 0;
  values: Record<string, unknown> = { threshold: 0.5 };
  passes = [{ properties: { threshold: {} }, defines: {}, shaderInfo: {}, getHandle: () => 1, tryCompile: () => true }];
  copy(source: MockMaterial): void { this.values = { ...source.values }; }
  setProperty(name: string, value: unknown): void { this.values[name] = value; }
  getProperty(name: string): unknown { return this.values[name]; }
  destroy(): void { this.isValid = false; }
  recompileShaders(): void {}
  overridePipelineStates(): void {}
}
class MockInstance extends MockMaterial {
  constructor(info: { parent: MockMaterial }) { super(); this.parent = info.parent; this.uuid = 'instance'; this.copy(info.parent); }
}
class MaterialHarness {
  shared = new MockMaterial(); current: MockMaterial = this.shared; forced = false;
  component = { uuid: 'renderer', getRenderMaterial: () => this.current,
    setMaterialInstance: (material: MockMaterial) => { this.current = material; },
    setSharedMaterial: (material: MockMaterial, _slot: number, force: boolean) => { this.forced = force; this.current.destroy(); this.current = material; } };
  root = { uuid: 'root', children: [], getComponents: () => [this.component] };
  controller = new MaterialController({ cc: { director: { getScene: () => this.root }, MaterialInstance: MockInstance } as unknown as RuntimeObject, major: 3 });
}

test('repeated instance updates keep a stable parent and force restoration of a shared material', async () => {
  const harness = new MaterialHarness();
  await harness.controller.execute('runtime.material.update', { componentId: 'renderer', properties: { threshold: 0.2 } });
  const first = harness.current;
  await harness.controller.execute('runtime.material.update', { componentId: 'renderer', properties: { threshold: 0.8 } });
  assert.equal(first.isValid, false); assert.equal(harness.current.parent, harness.shared); assert.equal(harness.shared.values.threshold, 0.5);
  await harness.controller.execute('runtime.material.reset', { componentId: 'renderer' });
  assert.equal(harness.current, harness.shared); assert.equal(harness.forced, true); assert.equal(harness.shared.isValid, true);
});

test('bad material parameters and external binding changes preserve the active material', async () => {
  const harness = new MaterialHarness();
  await assert.rejects(harness.controller.execute('runtime.material.update', { componentId: 'renderer', properties: { typo: 1 } }), /Unknown/);
  assert.equal(harness.current, harness.shared);
  await harness.controller.execute('runtime.material.update', { componentId: 'renderer', properties: { threshold: 0.2 } });
  const external = new MockMaterial(); harness.current = external;
  await assert.rejects(harness.controller.execute('runtime.material.reset', { componentId: 'renderer' }), /outside/);
  assert.equal(harness.current, external);
});
