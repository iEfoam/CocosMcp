import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphicsInspector } from '../packages/runtime3-bridge/src/graphics.js';
import { ParticleController } from '../packages/runtime3-bridge/src/particle.js';
import { RuntimeController } from '../packages/runtime3-bridge/src/index.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';

class Particle3 {
  uuid = 'p3'; enabledInHierarchy = true; isPlaying = false; isPaused = false; isStopped = true; isEmitting = false; time = 2; capacity = 100; calls: string[] = [];
  getParticleCount(): number { return 5; }
  play(): void { this.calls.push('play'); this.isPlaying = true; }
  pause(): void { this.calls.push('pause'); this.isPaused = true; }
  stop(): void { this.calls.push('stop'); this.time = 0; }
  stopEmitting(): void { this.calls.push('stopEmitting'); this.isEmitting = false; }
}
class Particle2 {
  uuid = 'p2'; enabledInHierarchy = true; active = true; particleCount = 4; totalParticles = 50; autoRemoveOnFinish = false; calls: string[] = [];
  resetSystem(): void { this.calls.push('resetSystem'); this.particleCount = 0; }
  stopSystem(): void { this.calls.push('stopSystem'); this.active = false; }
}
class RenderFixture {
  p2 = new Particle2(); p3 = new Particle3(); queries: number[] = [];
  device = { gfxAPI: 7, vendor: 'Vendor', renderer: 'GPU', capabilities: { maxTextureSize: 4096 }, memoryStatus: { bufferSize: 32, textureSize: 64 }, numDrawCalls: 5, numTris: 10,
    hasFeature: (feature: number) => feature === 0, getFormatFeatures: (format: number) => { this.queries.push(format); return format === 1 ? 3 : 0; } };
  scene = { uuid: 'root', children: [], getComponents: () => [this.p2, this.p3] };
  cc = { ENGINE_VERSION: '3.8.8', director: { root: { device: this.device }, getScene: () => this.scene }, ParticleSystem: Particle3, ParticleSystem2D: Particle2,
    gfx: { API: { 7: 'WEBGL2' }, Feature: { A: 0, B: 1, COUNT: 2, 0: 'A', 1: 'B' }, Format: { RGBA8: 1, BC1: 2, COUNT: 3 }, FormatFeatureBit: { NONE: 0, RENDER_TARGET: 1, SAMPLED_TEXTURE: 2 } } };
}
test('graphics queries report bounded actual device values and validate all names before native calls', () => {
  const f = new RenderFixture(), tool = new GraphicsInspector(f.cc);
  const result = Json.object(tool.execute('runtime.graphics.inspect', {}));
  assert.equal(result.backend, 'WEBGL2'); assert.equal(Json.object(result.memory).driverTotalBytes, null);
  assert.equal(Json.object(result.limits).maxTextureUnits, null);
  assert.deepEqual(result.features, [{ name: 'A', supported: true }, { name: 'B', supported: false }]);
  const formats = Json.object(tool.execute('runtime.graphics.formats', { formats: ['RGBA8', 'BC1'] })).rows as JsonObject[];
  assert.deepEqual(formats[0]!.supportedUsages, ['RENDER_TARGET', 'SAMPLED_TEXTURE']); assert.deepEqual(formats[1]!.supportedUsages, []);
  for (const names of [['RGBA8', 'bad'], ['COUNT'], ['RGBA8', 'RGBA8'], ['__proto__'], []]) assert.throws(() => tool.execute('runtime.graphics.formats', { formats: names }));
  assert.deepEqual(f.queries, [1, 2]);
  assert.throws(() => new GraphicsInspector({ director: {} }).execute('runtime.graphics.inspect', {}), /render root/);
});
test('particle dimension APIs preserve native semantics and refuse auto-destroy or disabled components', () => {
  const f = new RenderFixture(), tool = new ParticleController(new SceneInspector({ major: 3, cc: f.cc }));
  assert.equal(Json.object(tool.execute('runtime.particle2d.state', { componentId: 'p2' })).particleCount, 4);
  tool.execute('runtime.particle2d.restart', { componentId: 'p2' }); tool.execute('runtime.particle2d.stop_emitting', { componentId: 'p2' });
  for (const action of ['play', 'pause', 'stop_emitting', 'stop']) tool.execute(`runtime.particle3d.${action}`, { componentId: 'p3' });
  assert.deepEqual(f.p2.calls, ['resetSystem', 'stopSystem']); assert.deepEqual(f.p3.calls, ['play', 'pause', 'stopEmitting', 'stop']);
  f.p2.autoRemoveOnFinish = true;
  assert.throws(() => tool.execute('runtime.particle2d.restart', { componentId: 'p2' }), /autoRemoveOnFinish/);
  assert.throws(() => tool.execute('runtime.particle2d.pause', { componentId: 'p2' }), /dimension/);
  assert.throws(() => tool.execute('runtime.particle3d.play', { componentId: 'p2' }), /different/);
  f.p3.enabledInHierarchy = false; assert.throws(() => tool.execute('runtime.particle3d.play', { componentId: 'p3' }), /enabled/);
  assert.equal(f.p2.calls.length, 2); assert.equal(f.p3.calls.length, 4);
});
test('runtime routes exact-version tools and reports uncertain particle changes without retry', async () => {
  const f = new RenderFixture(), runtime = new RuntimeController({ major: 3, cc: f.cc }), catalog = new CapabilityCatalog();
  assert.equal(Json.object(await runtime.execute('runtime.particle3d.state', { componentId: 'p3' })).particleCount, 5);
  assert.equal(Json.object(await runtime.execute('runtime.graphics.inspect', {})).backend, 'WEBGL2');
  f.p3.play = () => { f.p3.calls.push('failed-play'); throw new Error('native failure'); };
  await assert.rejects(runtime.execute('runtime.particle3d.play', { componentId: 'p3' }), { code: 'OUTCOME_UNKNOWN' }); assert.deepEqual(f.p3.calls, ['failed-play']);
  f.cc.ENGINE_VERSION = '3.8.7'; await assert.rejects(runtime.execute('runtime.graphics.inspect', {}), { code: 'UNSUPPORTED_VERSION' });
  assert.throws(() => catalog.validate('runtime.graphics.formats', { formats: ['RGBA8'], extra: true }));
  assert.throws(() => catalog.describe('runtime.particle2d.pause'));
  assert.equal(catalog.describe('runtime.particle3d.state').verification, 'unverified');
  runtime.dispose();
});

test('Creator module namespace VERSION is accepted and takes precedence over legacy ENGINE_VERSION', async () => {
  const f = new RenderFixture();
  const { ENGINE_VERSION: _legacy, ...moduleExports } = f.cc;
  const cc = { ...moduleExports, VERSION: '3.8.8' };
  const runtime = new RuntimeController({ major: 3, cc });
  assert.equal(Json.object(await runtime.execute('runtime.graphics.inspect', {})).backend, 'WEBGL2');
  assert.equal(Json.object(await runtime.execute('runtime.query', {})).engineVersion, '3.8.8');
  cc.VERSION = '3.8.7'; await assert.rejects(runtime.execute('runtime.graphics.inspect', {}), { code: 'UNSUPPORTED_VERSION' });
  runtime.dispose();
});
