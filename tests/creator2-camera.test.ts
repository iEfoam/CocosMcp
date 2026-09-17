import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2Features } from '../packages/runtime2-bridge/src/features.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
class CameraHarness {
  calls = 0;
  camera = { uuid: 'camera', kind: 'cc.Camera', alignWithScreen: true, zoomRatio: 2, cullingMask: 0xffffffff, node: { is3DNode: false },
    nearClip: 1, farClip: 100, rect: { width: 1, height: 1 }, ortho: false,
    getWorldToScreenPoint: (point: { x: number; y: number }) => { this.calls++; return { x: point.x * 2, y: point.y * 2 }; },
    getScreenToWorldPoint: (point: { x: number; y: number }) => { this.calls++; return { x: point.x / 2, y: point.y / 2 }; },
    containsNode: () => false };
  root = { uuid: 'root', groupIndex: 31, children: [], getComponents: () => [this.camera] };
  features = new Creator2Features(new SceneInspector({ major: 2, cc: { ENGINE_VERSION: '2.4.15', director: { getScene: () => this.root }, Vec2: class { constructor(public x: number, public y: number) {} }, js: { getClassName: (v: { kind?: string }) => v.kind ?? 'cc.Node' } } }));
}
test('Creator 2 camera conversion validates projection and finite coordinates before native calls', () => {
  const h = new CameraHarness(), params = { componentId: 'camera', direction: 'world-to-screen', point: { x: 12, y: -7 } };
  assert.deepEqual(h.features.execute('runtime.camera.convert', params), { componentId: 'camera', direction: 'world-to-screen', point: { x: 24, y: -14 }, dimension: 2, coordinateSpace: 'native-visibleRect', pixelVerified: false });
  assert.throws(() => h.features.execute('runtime.camera.convert', { ...params, point: { x: NaN, y: 0 } }), /finite/);
  h.camera.alignWithScreen = false; assert.throws(() => h.features.execute('runtime.camera.convert', params), /alignWithScreen/);
  h.camera.alignWithScreen = true; h.camera.node.is3DNode = true; assert.throws(() => h.features.execute('runtime.camera.convert', params), /3D/);
  h.camera.node.is3DNode = false; h.camera.zoomRatio = 0; assert.throws(() => h.features.execute('runtime.camera.convert', params), /positive/);
  assert.equal(h.calls, 1);
});
test('Creator 2 culling reports unsigned high-bit match without claiming visible pixels', () => {
  const h = new CameraHarness();
  const result = h.features.execute('runtime.camera.culling', { componentId: 'camera', nodeId: 'root' }) as Record<string, unknown>;
  assert.equal(result.maskMatches, true); assert.equal(result.nativeContainsNode, false); assert.equal(result.visible, null);
  h.camera.cullingMask = 0;
  assert.equal((h.features.execute('runtime.camera.culling', { componentId: 'camera', nodeId: 'root' }) as Record<string, unknown>).maskMatches, false);
});
test('3D camera requires depth, valid clipping planes and a nonempty viewport before native conversion', () => {
  const h = new CameraHarness(); h.camera.node.is3DNode = true; h.camera.alignWithScreen = false;
  const p = { componentId: 'camera', direction: 'screen-to-world', point: { x: 100, y: 100, z: 0.5 } };
  assert.throws(() => h.features.execute('runtime.camera.convert', { ...p, point: { x: 0, y: 0 } }), /finite z/);
  assert.throws(() => h.features.execute('runtime.camera.convert', { ...p, point: { x: 0, y: 0, z: 1.01 } }), /0..1/);
  h.camera.farClip = 1; assert.throws(() => h.features.execute('runtime.camera.convert', p), /clipping/);
  h.camera.farClip = 100; h.camera.rect.width = 0; assert.throws(() => h.features.execute('runtime.camera.convert', p), /viewport/);
  assert.equal(h.calls, 0);
});
