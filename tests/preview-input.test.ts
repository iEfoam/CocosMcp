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
  const scene = { uuid: 'scene' };
  const engine = { Director: { EVENT_AFTER_DRAW: 'draw' }, director: {
    getScene: () => reads >= 3 ? scene : null,
    on: () => {},
    once: (_event: string, done: () => void) => queueMicrotask(done), off: () => {},
  } };
  h.window.webContents.executeJavaScript = async source => await runInNewContext(source, {
    System: { resolve: async () => 'cc', get: (id: unknown) => { assert.equal(id, 'cc'); reads++; return reads >= 2 ? engine : undefined; }, import: () => { throw new Error('Premature engine import'); } },
    setTimeout, clearTimeout,
  });
  const capture = Json.object(await h.preview.execute('capture', {}));
  assert.equal(capture.sceneId, 'scene'); assert.ok(reads >= 3);
});

test('managed navigation preserves iframe loads, disables Creator 3 auto reload and serializes Creator 2 reload', async () => {
  for (const major of [2, 3] as const) {
    const h = new InputHarness(), listeners = new Map<string, (...args: unknown[]) => void>(), urls: string[] = [];
    h.window.webContents.on = (event, listener) => { listeners.set(event, listener); };
    h.window.loadURL = async url => { urls.push(url); };
    const preview = new ManagedPreview({ create: options => { assert.equal(options.enableLargerThanScreen, true); return h.window; } }, undefined, major);
    await preview.execute('start', { url: 'http://127.0.0.1:7456', sceneId: 'scene' });
    assert.equal(new URL(urls.at(-1)!).searchParams.get('autoReload'), major === 3 ? 'false' : null);
    listeners.get('did-start-navigation')?.({}, 'http://127.0.0.1:7456/frame', false, false);
    assert.equal(Json.object(await preview.execute('status', {})).pageReady, true);
    let blocked = 0; listeners.get('will-navigate')!({ preventDefault: () => blocked++ }, urls.at(-1)!);
    assert.equal(blocked, major === 2 ? 1 : 0);
    listeners.get('did-start-navigation')?.({}, urls.at(-1)!, false, true);
    assert.equal(Json.object(await preview.execute('status', {})).pageReady, true, 'A rejected navigation preserves the active page');
    listeners.get('did-navigate')!({}, urls.at(-1)!);
    assert.equal(Json.object(await preview.execute('status', {})).pageReady, false);
    listeners.get('did-finish-load')!(); assert.equal(Json.object(await preview.execute('status', {})).pageReady, true);
    preview.dispose();
  }
});

test('input acquires focus before waiting for a frame and reports delivery after a post-input frame failure', async () => {
  const h = new InputHarness(); await h.start(); let captures = 0;
  h.window.webContents.executeJavaScript = async source => {
    assert.equal(h.focused, true, 'hidden engine observation must also follow focus');
    if (source.includes('return new Promise(resolve')) {
      assert.equal(h.focused, true, 'frame wait must follow focus');
      captures++;
      if (captures > 1) return { ready: false, reason: 'frame-timeout', gamePaused: true };
    }
    return { ready: true, sceneId: h.scene };
  };
  await assert.rejects(h.preview.execute('input', { action: 'click', x: 10, y: 20 }), error => {
    const failure = error as { code: string; details: JsonObject };
    assert.equal(failure.code, 'OUTCOME_UNKNOWN'); assert.equal(failure.details.inputSent, true); assert.equal(failure.details.sentEvents, 3); return true;
  });
  assert.equal(h.events.length, 3); assert.equal(captures, 2);
});

test('paused input is never resumed implicitly and distinguishes failure before delivery', async () => {
  const h = new InputHarness(); await h.start(); let resumed = false;
  h.window.webContents.executeJavaScript = async source => {
    if (source.includes('cc.game.resume()')) resumed = true;
    if (source.includes('return new Promise(resolve')) return resumed ? { ready: true, sceneId: 'scene' } : { ready: false, gamePaused: true, reason: 'frame-timeout' };
    return { ready: true, sceneId: 'scene' };
  };
  await assert.rejects(h.preview.execute('input', { action: 'click', x: 1, y: 1 }), error => {
    assert.equal((error as { details: JsonObject }).details.inputSent, false); return true;
  });
  assert.equal(resumed, false); assert.equal(h.events.length, 0);
  const result = Json.object(await h.preview.execute('input', { action: 'click', x: 1, y: 1, allowResume: true }));
  assert.equal(resumed, true); assert.equal(result.inputSent, true);
});

test('capture allows legal scene transitions but rejects strict generation and mid-capture scene changes', async () => {
  const h = new InputHarness(); await h.start();
  const initial = Json.object(await h.preview.execute('capture', {}));
  h.scene = 'room';
  const room = Json.object(await h.preview.execute('capture', {}));
  assert.equal(room.launchSceneId, 'scene'); assert.equal(room.currentSceneId, 'room'); assert.ok(Number(room.sceneGeneration) > Number(initial.sceneGeneration));
  await assert.rejects(h.preview.execute('capture', { expectedGeneration: initial.sceneGeneration! }), { code: 'STALE_HANDLE' });
  const last = Json.object(await h.preview.execute('capture', { frameMode: 'lastFrame' })); assert.equal(last.stale, true); assert.equal(last.capturedAt, room.capturedAt);
  const capture = h.window.webContents.capturePage;
  h.window.webContents.capturePage = async () => { const result = await capture(); h.scene = 'table'; return result; };
  await assert.rejects(h.preview.execute('capture', {}), { code: 'STALE_HANDLE' });
  await assert.rejects(h.preview.execute('capture', { frameMode: 'lastFrame' }), /No captured frame/);
});

test('closing the managed window clears scene, frame readiness and cached capture', async () => {
  const h = new InputHarness(); let closed: (() => void) | undefined, destroyed = false;
  h.window.once = (event, listener) => { if (event === 'closed') closed = () => listener(); };
  h.window.isDestroyed = () => destroyed;
  h.window.webContents.executeJavaScript = async () => ({ ready: true, sceneId: 'scene', sceneGeneration: 1, sceneFrameIndex: 2 });
  await h.start(); await h.preview.execute('capture', {});
  assert.equal(Json.object(Json.object(await h.preview.execute('status', {})).readiness).frame, 'passed');
  destroyed = true; closed!();
  const status = Json.object(await h.preview.execute('status', {}));
  assert.equal(status.currentSceneId, null); assert.equal(status.url, null); assert.equal(status.gameReady, false);
  assert.deepEqual(status.observation, {}); assert.equal(Json.object(status.readiness).frame, 'unknown'); assert.equal(Json.object(status.readiness).engine, 'unknown');
  await assert.rejects(h.preview.execute('capture', { frameMode: 'lastFrame' }), { code: 'CONTEXT_UNAVAILABLE' });
});

test('image coordinates reject resized or changed Canvas geometry before delivery', async () => {
  const h = new InputHarness(); let canvasX = 0, changeOnFrame = false;
  h.window.webContents.executeJavaScript = async source => {
    if (changeOnFrame && source.includes('return new Promise(resolve')) canvasX = 20;
    return { ready: true, sceneId: 'scene', sceneGeneration: 1, canvasRect: { x: canvasX, y: 0, width: 600, height: 400 } };
  };
  await h.start();
  const reference = Json.object(await h.preview.execute('capture', {}));
  h.width = 900;
  await assert.rejects(h.preview.execute('input', { action: 'click', x: 10, y: 10, coordinateSpace: 'image-pixels', captureId: reference.captureId! }), { code: 'STALE_HANDLE' });
  assert.equal(h.events.length, 0);
  h.width = 800; changeOnFrame = true;
  await assert.rejects(h.preview.execute('input', { action: 'click', x: 10, y: 10, coordinateSpace: 'image-pixels', captureId: reference.captureId! }), error => {
    assert.equal((error as { details: JsonObject }).details.inputSent, false); return (error as { code: string }).code === 'STALE_HANDLE';
  });
  assert.equal(h.events.length, 0);
});

test('Canvas coordinates are recalculated after focus and the first fresh frame', async () => {
  const h = new InputHarness(); let canvasX = 0;
  h.window.webContents.executeJavaScript = async source => {
    if (source.includes('return new Promise(resolve')) canvasX = 20;
    return { ready: true, sceneId: 'scene', canvasRect: { x: canvasX, y: 0, width: 600, height: 400 } };
  };
  await h.start(); await h.preview.execute('input', { action: 'click', x: 10, y: 10, coordinateSpace: 'canvas-css' });
  assert.equal(h.events[0]!.x, 30); assert.equal(h.events[1]!.x, 30);
});

test('a failed first send records uncertain delivery rather than claiming no input was sent', async () => {
  const h = new InputHarness(); await h.start();
  h.window.webContents.sendInputEvent = () => { throw new Error('delivery acknowledgement lost'); };
  await assert.rejects(h.preview.execute('input', { action: 'click', x: 10, y: 10 }), error => {
    const failure = error as { code: string; details: JsonObject };
    assert.equal(failure.code, 'OUTCOME_UNKNOWN'); assert.equal(failure.details.inputSent, null); assert.equal(failure.details.sentEvents, 0);
    assert.equal((failure.details.attempted as JsonObject[]).length, 1); return true;
  });
});

test('bounded wait returns observed conditions and times out without sending input or resuming', async () => {
  const h = new InputHarness(); await h.start();
  h.window.webContents.executeJavaScript = async source => { assert.equal(source.includes('cc.game.resume()'), false); return { ready: true, sceneId: 'scene', frameIndex: 7 }; };
  assert.equal(Json.object(await h.preview.execute('wait', { sceneId: 'scene', afterFrameIndex: 6 })).status, 'completed');
  await assert.rejects(h.preview.execute('wait', { sceneId: 'room', timeoutMs: 100 }), { code: 'TIMEOUT' });
  assert.equal(h.events.length, 0);
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
  h.scene = 'different'; await assert.rejects(() => h.preview.execute('input', { action: 'click', x: 1, y: 1, expectedSceneId: 'scene' }), /expected scene/); assert.equal(h.events.length, 0);
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
  assert.deepEqual(h.events.map(row => row.type), ['mouseMove', 'keyDown', 'char', 'keyUp']);
  h.events.length = 0;
  await assert.rejects(h.preview.execute('input', { action: 'drag', x: 0, y: 0, endX: 900 }), /inside/);
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

test('printable key delivery includes a character event while navigation keys do not', async () => {
  const h = new InputHarness(); await h.start();
  await h.preview.execute('input', { action: 'key', x: 0, y: 0, key: 'A', focusTarget: 'window', durationMs: 0 });
  assert.deepEqual(h.events.filter(row => row.type === 'char'), [{ type: 'char', keyCode: 'a' }]);
  h.events.length = 0;
  await h.preview.execute('input', { action: 'key', x: 0, y: 0, key: 'Left', focusTarget: 'window', durationMs: 0 });
  assert.equal(h.events.some(row => row.type === 'char'), false);
});
