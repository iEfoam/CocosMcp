import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2Camera } from '../packages/runtime2-bridge/src/camera.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';

class PixelHarness {
  textureDestroyed = 0; depthDestroyed = 0; rendered = 0; fail = false;
  live = new Set<object>(); leakDepth = false; contextLost = false;
  original = { name: 'business-target' };
  node = { uuid: 'root', children: [], x: 1, y: 2, z: 3, angle: 7, is3DNode: false,
    setPosition: (x: number, y: number, z: number) => { Object.assign(this.node, { x, y, z }); }, getComponents: () => [this.camera] };
  camera = { uuid: 'camera', kind: 'cc.Camera', node: this.node, alignWithScreen: true, targetTexture: this.original,
    beforeDraw: () => { this.node.z = 900; this.node.angle = 0; },
    render: () => { this.rendered++; if (this.fail) throw new Error('render failed'); } };
  create() {
    const harness = this;
    return new Creator2Camera(new SceneInspector({ major: 2, cc: {
      director: { getScene: () => this.node }, js: { getClassName: (value: { kind?: string }) => value.kind ?? 'cc.Node' },
      game: { _renderContext: { DEPTH_STENCIL: 34041, readPixels() {}, isTexture: (id: object) => this.live.has(id), isFramebuffer: (id: object) => this.live.has(id), isRenderbuffer: (id: object) => this.live.has(id), isContextLost: () => this.contextLost } },
      RenderTexture: class {
        _texture = { _glID: {} }; _framebuffer = { _glID: {} };
        _depthStencilBuffer = { _glID: {}, destroy: () => { harness.depthDestroyed++; if (!harness.leakDepth) harness.live.delete(this._depthStencilBuffer._glID); } };
        initWithSize() { for (const object of [this._texture, this._framebuffer, this._depthStencilBuffer]) harness.live.add(object._glID); }
        readPixels(buffer: Uint8Array) { buffer.set([255, 0, 0, 255]); return buffer; }
        destroy() { harness.textureDestroyed++; harness.live.delete(this._texture._glID); harness.live.delete(this._framebuffer._glID); }
      },
    } }));
  }
  params = { componentId: 'camera', width: 16, height: 16, points: [{ x: 0, y: 0 }] };
}
for (const fail of [false, true]) test(`offscreen sampling restores business target and releases depth buffer on failure=${fail}`, () => {
  const h = new PixelHarness(); h.fail = fail;
  if (fail) assert.throws(() => h.create().samplePixels(h.params), /render failed/);
  else assert.deepEqual(h.create().samplePixels(h.params).rows, [{ x: 0, y: 0, rgba: [255, 0, 0, 255] }]);
  assert.equal(h.camera.targetTexture, h.original); assert.equal(h.node.z, 3); assert.equal(h.node.angle, 7);
  assert.equal(h.textureDestroyed, 1); assert.equal(h.depthDestroyed, 1);
  assert.throws(() => h.create().samplePixels({ ...h.params, points: [{ x: 16, y: 0 }] }), /outside/);
  assert.equal(h.rendered, 1);
});
test('offscreen cleanup rejects surviving GPU objects and lost contexts', () => {
  const h = new PixelHarness(); h.leakDepth = true;
  assert.throws(() => h.create().samplePixels(h.params), /cleanup failed/);
  assert.equal(h.camera.targetTexture, h.original);
  const lost = new PixelHarness(); lost.camera.render = () => { lost.contextLost = true; };
  assert.throws(() => lost.create().samplePixels(lost.params), /cleanup failed/);
});
