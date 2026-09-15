import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeAssets } from '../packages/runtime3-bridge/src/assets.js';
import { Json } from '../packages/contracts/src/index.js';

class AssetHarness {
  readonly uuid = '00000000-0000-4000-8000-000000000001';
  readonly asset = { uuid: this.uuid, refCount: 4, isValid: true, addRef() { this.refCount++; }, decRef(auto: boolean) { assert.equal(auto, false); this.refCount--; } };
  callback: ((error: Error | null, value?: unknown) => void) | undefined;
  delayed = false; calls = 0;
  readonly assets = new RuntimeAssets({ assetManager: {
    loadAny: (_uuid: string, callback: (error: Error | null, value?: unknown) => void) => { this.calls++; this.callback = callback; if (!this.delayed) callback(null, this.asset); },
    preloadAny: (_uuid: string, callback: (error: Error | null, value?: unknown) => void) => { this.calls++; callback(null, []); },
    bundles: { forEach: (callback: (bundle: unknown) => void) => callback({ name: 'main', base: '/assets/main' }) },
  } });
}

test('runtime assets account only owned references across duplicate loads, release and scene disposal', async () => {
  const h = new AssetHarness();
  const first = Json.object(await h.assets.execute('runtime.asset.load', { uuid: h.uuid }));
  await h.assets.execute('runtime.asset.load', { uuid: h.uuid }); assert.equal(h.asset.refCount, 6);
  assert.equal(Json.object(await h.assets.execute('runtime.asset.inspect', { handle: first.handle! })).ownedReferences, 1);
  await h.assets.execute('runtime.asset.release', { handle: first.handle! }); assert.equal(h.asset.refCount, 5);
  await assert.rejects(() => h.assets.execute('runtime.asset.release', { handle: first.handle! }), /expired/);
  h.assets.dispose(); h.assets.dispose(); assert.equal(h.asset.refCount, 4);
});

test('runtime disposal rejects pending loads and late callbacks never acquire references', async () => {
  const h = new AssetHarness(); h.delayed = true;
  const loading = h.assets.execute('runtime.asset.load', { uuid: h.uuid });
  const rejected = assert.rejects(() => loading, /ended|changed/); h.assets.dispose(); await rejected;
  h.callback!(null, h.asset); assert.equal(h.asset.refCount, 4);
});

test('runtime preloading, bundle discovery and forbidden network paths preserve ownership', async () => {
  const h = new AssetHarness();
  assert.equal(Json.object(await h.assets.execute('runtime.asset.preload', { uuid: h.uuid })).phase, 'downloaded-not-parsed');
  assert.equal(Json.object(await h.assets.execute('runtime.bundle.inspect', {})).unloadSupported, false);
  await assert.rejects(() => h.assets.execute('runtime.asset.load', { uuid: 'https://example.com/file' }), /local AssetDB/);
  assert.equal(h.calls, 1); assert.equal(h.asset.refCount, 4);
});

test('scene launch releases references immediately without waiting for another MCP command', async () => {
  const h = new AssetHarness(); let listener: (() => void) | undefined; let scene = 'first';
  const assets = new RuntimeAssets({ director: { getScene: () => scene, on: (_event: string, callback: () => void) => { listener = callback; }, off: () => { listener = undefined; } },
    assetManager: { loadAny: (_uuid: string, callback: (error: null, value: unknown) => void) => callback(null, h.asset) } });
  const loaded = Json.object(await assets.execute('runtime.asset.load', { uuid: h.uuid })); assert.equal(h.asset.refCount, 5);
  scene = 'second'; listener!(); assert.equal(h.asset.refCount, 4); assert.equal(listener, undefined);
  await assert.rejects(() => assets.execute('runtime.asset.inspect', { handle: loaded.handle! }), /expired/);
});
