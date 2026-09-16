import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { ManagedPreview, type PreviewWindow } from '../extensions/creator3/src/preview.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
class InputHarness {
  width = 800; height = 600; focused = false; scene = 'scene'; failMouseUp = false; readonly events: JsonObject[] = [];
  readonly window: PreviewWindow = { loadURL: async () => {}, isDestroyed: () => false, destroy: () => {}, once: () => {},
    getContentSize: () => [this.width, this.height], setContentSize: (w, h) => { this.width = w; this.height = h; }, show: () => {}, focus: () => { this.focused = true; }, isFocused: () => this.focused,
    webContents: { isDestroyed: () => false, on: () => {}, setWindowOpenHandler: () => {}, session: { setPermissionRequestHandler: () => {} },
      executeJavaScript: async source => source.includes("target:'game-canvas'") ? { target: 'game-canvas', focused: true } : ({ ready: true, sceneId: this.scene }),
      sendInputEvent: event => { this.events.push(event); if (this.failMouseUp && event.type === 'mouseUp') throw new Error('window lost'); },
      capturePage: async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,dGVzdA==', getSize: () => ({ width: this.width, height: this.height }) }) } };
  preview = new ManagedPreview({ create: () => this.window });
  async start(): Promise<void> { await this.preview.execute('start', { url: 'http://127.0.0.1:7456', sceneId: 'scene', width: 800, height: 600 }); }
}
test('capture waits for loader registration and scene launch without initiating an engine import', async () => {
  const h = new InputHarness(); await h.start(); let reads = 0;
  const engine = { Director: { EVENT_AFTER_DRAW: 'draw' }, director: {
    getScene: () => reads >= 3 ? { uuid: 'scene' } : null,
    once: (_event: string, done: () => void) => queueMicrotask(done), off: () => {},
  } };
  h.window.webContents.executeJavaScript = async source => await runInNewContext(source, {
    System: { resolve: async () => 'cc', get: (id: unknown) => { assert.equal(id, 'cc'); reads++; return reads >= 2 ? engine : undefined; }, import: () => { throw new Error('Premature engine import'); } },
    setTimeout, clearTimeout,
  });
  const capture = Json.object(await h.preview.execute('capture', {}));
  assert.equal(capture.sceneId, 'scene'); assert.ok(reads >= 3);
});
test('preview input focuses only the managed window and resize returns real viewport plus capture', async () => {
  const h = new InputHarness(); await h.start();
  const clicked = Json.object(await h.preview.execute('input', { action: 'click', x: 40, y: 50 }));
  assert.equal(h.focused, true); assert.deepEqual(h.events.map(e => e.type), ['mouseMove', 'mouseDown', 'mouseUp']); assert.equal(clicked.businessOutcomeVerified, false);
  const resized = Json.object(await h.preview.execute('resize', { width: 400, height: 800 })); assert.deepEqual(resized.viewport, { width: 400, height: 800 });
  await h.preview.execute('input', { action: 'wheel', x: 30, y: 40, deltaY: -200 }); assert.equal(h.events.at(-1)!.type, 'mouseWheel');
});
test('preview rejects wrong scene and out-of-bounds coordinates before input and reports uncertain delivery without retry', async () => {
  const h = new InputHarness(); await h.start();
  await assert.rejects(() => h.preview.execute('input', { action: 'click', x: 800, y: 0 }), /inside/); assert.equal(h.events.length, 0);
  h.scene = 'different'; await assert.rejects(() => h.preview.execute('input', { action: 'click', x: 1, y: 1 }), /different scene/); assert.equal(h.events.length, 0);
  h.scene = 'scene'; h.failMouseUp = true;
  await assert.rejects(() => h.preview.execute('input', { action: 'click', x: 1, y: 1 }), /may have executed/); assert.equal(h.events.length, 3);
});

test('diagnostic listeners are installed after a blank target exists and before the project navigates', async () => {
  const h = new InputHarness(), order: string[] = [];
  h.window.loadURL = async url => { order.push(url); };
  h.window.webContents.debugger = {
    isAttached: () => false, attach: () => { assert.equal(order[0], 'about:blank'); order.push('attach'); }, detach: () => {}, on: () => {}, removeListener: () => {},
    sendCommand: async method => { order.push(method); return { identifier: 'bootstrap' }; },
  };
  await h.start();
  assert.ok(order.indexOf('Page.addScriptToEvaluateOnNewDocument') < order.findIndex(url => url.startsWith('http://127.0.0.1')));
  h.preview.dispose();
});

test('drag and held-key sequences release input and reject invalid gestures before delivery', async () => {
  const h = new InputHarness(); await h.start();
  await h.preview.execute('input', { action: 'drag', x: 10, y: 20, endX: 60, endY: 80, durationMs: 0, steps: 2 });
  assert.deepEqual(h.events.map(row => row.type), ['mouseMove', 'mouseDown', 'mouseMove', 'mouseMove', 'mouseUp']);
  assert.equal(h.events.at(-1)!.x, 60);
  h.events.length = 0;
  await h.preview.execute('input', { action: 'key', x: 0, y: 0, key: 'Space', durationMs: 0 });
  assert.deepEqual(h.events.map(row => row.type), ['mouseMove', 'keyDown', 'keyUp']);
  h.events.length = 0;
  await assert.rejects(h.preview.execute('input', { action: 'drag', x: 0, y: 0, endX: 900 }), /bounded/);
  assert.equal(h.events.length, 0);
});

test('first key focuses game canvas without a click, returns events and rejects failed focus', async () => {
  const h = new InputHarness(); await h.start();
  let canvasFocused = false, disposed = false;
  h.window.webContents.executeJavaScript = async source => {
    if (source.includes("target:'game-canvas'")) { canvasFocused = true; return { target: 'game-canvas', focused: true, devicePixelRatio: 2 }; }
    if (source.includes('?.rows')) return [{ type: 'keydown', code: 'Space', isTrusted: true }];
    if (source === 'globalThis.__cocosMcpInputAck?.dispose()') disposed = true;
    return { ready: true, sceneId: h.scene };
  };
  const result = Json.object(await h.preview.execute('input', { action: 'key', x: 0, y: 0, key: 'Space', durationMs: 0 }));
  assert.equal(canvasFocused, true); assert.equal(disposed, true); assert.equal(result.businessOutcomeVerified, false);
  assert.equal((result.inputEvents as JsonObject[])[0]!.code, 'Space');
  assert.equal(h.events.some(event => event.type === 'mouseDown'), false);
  h.events.length = 0;
  h.window.webContents.executeJavaScript = async source => source.includes("target:'game-canvas'") ? { focused: false } : { ready: true, sceneId: h.scene };
  await assert.rejects(h.preview.execute('input', { action: 'key', x: 0, y: 0, key: 'Space' }), /canvas did not/);
  assert.equal(h.events.length, 0);
});

test('touch cancellation is delivered through the managed debugger without overwriting game listeners', async () => {
  const h = new InputHarness(), commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  h.window.webContents.debugger = { isAttached: () => true, attach: () => {}, detach: () => {}, on: () => {}, removeListener: () => {}, sendCommand: async (method, params) => { commands.push({ method, ...(params ? { params } : {}) }); return {}; } };
  await h.start(); commands.length = 0;
  await h.preview.execute('input', { action: 'touch_cancel', x: 10, y: 20, endX: 30, endY: 40, durationMs: 0, steps: 2 });
  assert.deepEqual(commands.filter(row => row.method === 'Input.dispatchTouchEvent').map(row => row.params!.type), ['touchStart', 'touchMove', 'touchMove', 'touchCancel']);
  h.preview.dispose();
});
