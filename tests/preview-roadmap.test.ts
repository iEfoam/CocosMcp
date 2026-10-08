import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInContext, createContext } from 'node:vm';
import { CaptureEvidence } from '../extensions/creator3/src/capture-evidence.js';
import { PreviewCoordinates } from '../extensions/creator3/src/preview-coordinates.js';
import { PreviewObserver } from '../extensions/creator3/src/preview-observer.js';
import { RuntimeController } from '../packages/runtime3-bridge/src/index.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';

class RuntimeCaptureFixture {
  scene = { uuid: 'login', name: 'login', children: [], getComponents: () => [] };
  rendered = false; reads = 0;
  director = Object.assign(new EventEmitter(), { getScene: () => this.scene, getTotalFrames: () => 7 });
  cc = { ENGINE_VERSION: '3.8.8', director: this.director, Director: { EVENT_AFTER_DRAW: 'draw', EVENT_AFTER_SCENE_LAUNCH: 'launch' },
    game: { canvas: { width: 32, height: 16, toDataURL: () => { this.reads++; assert.equal(this.rendered, true); return 'data:image/png;base64,dGVzdA=='; } } } };
  runtime(major: 2 | 3): RuntimeController { this.cc.ENGINE_VERSION = major === 2 ? '2.4.15' : '3.8.8'; return new RuntimeController({ major, cc: this.cc }); }
  frame(): void { this.rendered = true; this.director.emit('draw'); this.rendered = false; }
}
test('scene UUID loading uses public AssetManager and preserves generation checks on both engines', async () => {
  for (const major of [2, 3] as const) {
    const f = new RuntimeCaptureFixture(); let launches = 0;
    const cc = { ...f.cc, SceneAsset: class {}, assetManager: { loadAny: (request: { uuid: string }, callback: (error: unknown, scene: unknown) => void) => {
      assert.equal(request.uuid, 'room'); callback(null, { scene: { ...f.scene, uuid: request.uuid } });
    } } };
    Object.assign(f.director, { loadScene: () => { throw new Error('UUID is not a scene name'); },
      runSceneImmediate: (asset: { scene: typeof f.scene }, _before: unknown, launched: (error: unknown) => void) => { launches++; f.scene = asset.scene; f.director.emit('launch'); launched(null); } });
    const runtime = new RuntimeController({ major, cc });
    const result = Json.object(await runtime.execute('runtime.scene.load', { sceneUuid: 'room' }));
    assert.equal(Json.object(result.scene).sceneId, 'room'); assert.equal(result.loaded, true); assert.equal(launches, 1); runtime.dispose();
  }
});

test('Creator 2/3 Canvas capture reads within AFTER_DRAW and old handles expire on a native scene transition', async () => {
  for (const major of [2, 3] as const) {
    const f = new RuntimeCaptureFixture(), runtime = f.runtime(major);
    const before = Json.object(await runtime.execute('runtime.query', {}));
    const handle = Json.object(Json.object(await runtime.execute('runtime.get', { path: 'getComponents' })).value);
    const pending = runtime.execute('runtime.capture', {}); f.frame();
    const image = Json.object(await pending);
    assert.equal(image.source, 'game-canvas-after-draw'); assert.equal(image.frameIndex, 7); assert.equal(image.sceneId, 'login');
    assert.equal(Json.object(await runtime.execute('runtime.capture', { frameMode: 'lastFrame' })).stale, true); assert.equal(f.reads, 1);
    f.scene = { ...f.scene, uuid: 'room' }; f.director.emit('launch');
    await assert.rejects(runtime.execute('runtime.inspect', { target: handle.handle! }), { code: 'STALE_HANDLE' });
    await assert.rejects(runtime.execute('runtime.capture', { frameMode: 'lastFrame' }), /No captured frame/);
    await assert.rejects(runtime.execute('runtime.get', { path: 'name', expectedGeneration: before.generation! }), { code: 'STALE_HANDLE' });
    runtime.dispose(); assert.equal(f.director.listenerCount('launch'), 0); assert.equal(f.director.listenerCount('draw'), 0);
  }
});

test('scene observer tracks same-UUID replacement and round trips and cleans listeners without resuming', async () => {
  let scene = { uuid: 'login' }; const director = Object.assign(new EventEmitter(), { getScene: () => scene });
  const context = createContext({ cc: { director, Director: { EVENT_AFTER_DRAW: 'draw', EVENT_AFTER_SCENE_LAUNCH: 'launch' }, game: { isPaused: () => true } } });
  const read = (): JsonObject => Json.object(runInContext(`(()=>{${new PreviewObserver().source()}return read();})()`, context));
  const first = read(); director.emit('draw'); assert.equal(read().frameIndex, 1); assert.equal(read().gamePaused, true);
  scene = { uuid: 'room' }; director.emit('launch'); scene = { uuid: 'login' }; director.emit('launch');
  assert.equal(Number(read().sceneGeneration), Number(first.sceneGeneration) + 2);
  scene = { uuid: 'login' }; director.emit('launch'); assert.equal(Number(read().sceneGeneration), Number(first.sceneGeneration) + 3);
  assert.equal(director.listenerCount('draw'), 1); runInContext('globalThis.__cocosMcpPreviewObservation.dispose()', context);
  assert.equal(director.listenerCount('draw'), 0); assert.equal(director.listenerCount('launch'), 0);
});

test('pixel sampling diagnoses transparent and monochrome images without calling them visual failures', () => {
  for (const alpha of [0, 255]) {
    const evidence = new CaptureEvidence().summarize({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,dGVzdA==', getSize: () => ({ width: 2, height: 1 }), toBitmap: () => Buffer.from([0, 0, 0, alpha, 0, 0, 0, alpha]) });
    const diagnostic = Json.object(evidence.pixelDiagnostic); assert.equal(diagnostic.monochrome, true); assert.equal(diagnostic.allTransparent, alpha === 0);
    assert.match(String(Json.object(evidence.image).sha256), /^[a-f0-9]{64}$/);
  }
  const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(6, 16); png.writeUInt32BE(4, 20);
  const retina = new CaptureEvidence().summarize({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,' + png.toString('base64'), getSize: () => ({ width: 3, height: 2 }), toBitmap: () => { throw new Error('native sampling unavailable'); } });
  assert.equal(retina.width, 6); assert.equal(retina.height, 4); assert.equal(Json.object(retina.pixelDiagnostic).status, 'unknown');
});

test('coordinates distinguish Canvas CSS, design and physical image pixels and reject Canvas margins', () => {
  const transform = new PreviewCoordinates(), observation = { canvasRect: { x: 20, y: 10, width: 600, height: 300 }, canvasPixelSize: { width: 1200, height: 600 },
    engineViewportRect: { x: 0, y: 0, width: 1200, height: 600 }, engineScale: { x: 1, y: 1 }, designResolution: { width: 1200, height: 600 }, devicePixelRatio: 4, imageSize: { width: 1600, height: 1200 } };
  assert.deepEqual(transform.point(100, 50, 'canvas-css', observation, [800, 600]), { x: 120, y: 60 });
  assert.deepEqual(transform.point(200, 100, 'design-top-left', observation, [800, 600]), { x: 120, y: 60 });
  assert.deepEqual(transform.point(240, 120, 'image-pixels', observation, [800, 600]), { x: 120, y: 60 });
  assert.throws(() => transform.point(10, 10, 'image-pixels', observation, [800, 600]), /Canvas/);
  assert.throws(() => transform.point(599.9, 0, 'canvas-css', observation, [800, 600]), /Rounded/);
  assert.throws(() => transform.point(0, 0, 'canvas-css', { canvasRect: { width: 600, height: 300 } }, [800, 600]), /geometry unavailable/);
  assert.throws(() => transform.point(0, 0, 'window-css', observation, [NaN, 600]), /dimensions unavailable/);
  assert.throws(() => transform.point(1200, 0, 'design-top-left', observation, [800, 600]), /design resolution/);
  assert.throws(() => transform.orientation(390, 844, 'landscape'), /orientation/);
});

test('new preview schemas preserve the protected connection alias and bounded wait contract', () => {
  const catalog = new CapabilityCatalog();
  catalog.validate('preview.runtime.connect', { gatewayPort: 6000, expectedSceneId: 'room' });
  catalog.validate('preview.wait', { sceneId: 'room', afterFrameIndex: 10, timeoutMs: 30000 });
  catalog.validate('preview.capture', { frameMode: 'lastFrame', expectedGeneration: 2 });
  catalog.validate('preview.resize', { preset: 'landscape-568' });
  assert.throws(() => catalog.validate('preview.resize', { width: 568 }));
  catalog.validate('preview.input', { action: 'click', x: 2400, y: 1200, coordinateSpace: 'image-pixels', allowResume: false });
  assert.throws(() => catalog.validate('preview.wait', { expression: 'evil()' }));
  assert.throws(() => catalog.validate('preview.wait', { timeoutMs: 30001 }));
  assert.deepEqual(catalog.describe('preview.runtime.connect').supportedMajors, [2, 3]);
});
