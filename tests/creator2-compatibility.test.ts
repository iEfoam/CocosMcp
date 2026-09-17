import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2Adapter } from '../packages/creator2-adapter/src/index.js';
import { Creator2Runtime } from '../packages/runtime2-bridge/src/index.js';
import { Creator2Features } from '../packages/runtime2-bridge/src/features.js';
import { Creator2UiService } from '../packages/creator2-adapter/src/ui.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import { Creator2Support } from '../packages/capability-catalog/src/creator2-support.js';
import { Operations } from '../packages/capability-catalog/src/operations.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';

class Animation2 {
  uuid = 'animation'; kind = 'cc.Animation'; clips = [{ name: 'Walk' }];
  state = { time: 0, duration: 2, isPlaying: false, isPaused: false }; calls: string[] = [];
  getClips(): unknown[] { return this.clips; }
  getAnimationState(): unknown { return this.state; }
  play(name: string): void { this.calls.push(`play:${name}`); this.state.isPlaying = true; }
  pause(): void { this.state.isPaused = true; }
  resume(): void { this.state.isPaused = false; }
  stop(): void { this.state.isPlaying = false; }
  setCurrentTime(time: number, name: string): void { this.calls.push(`seek:${name}`); this.state.time = time; }
  sample(name: string): void { this.calls.push(`sample:${name}`); }
}
class Creator2Harness {
  component = new Animation2(); revision = 0; writes = 0;
  root = { uuid: 'root', children: [], getComponents: () => [this.component] };
  cc = { ENGINE_VERSION: '2.4.15', director: { getScene: () => this.root }, js: { getClassName: (object: { kind?: string }) => object.kind ?? 'cc.Node' } };
  features = new Creator2Features(new SceneInspector({ major: 2, cc: this.cc }));
  port = { version: '2.4.15', projectPath: '.', selection: () => [], asset: async () => null, ipc: async () => null,
    scene: async (method: string): Promise<unknown> => { if (method === 'fingerprint') return { revision: this.revision }; if (method === 'ui.build') this.writes++; return { rows: [] }; } };
}
test('Creator 2 catalog has explicit routed families and never advertises newer-only runtime operations', async () => {
  const h = new Creator2Harness(), adapter = new Creator2Adapter(h.port), catalog = new Operations().list();
  for (const id of [...adapter.supportedCapabilities(), ...Creator2Support.runtime]) assert.ok(catalog.some(row => row.id === id && row.supportedMajors?.includes(2)), id);
  assert.ok(adapter.supportedCapabilities().includes('ui.build'));
  assert.ok(!adapter.supportedCapabilities().includes('preview.start'));
  assert.ok(!adapter.supportedCapabilities().includes('view.focus'));
  const runtime = new Creator2Runtime({ cc: h.cc });
  await assert.rejects(runtime.execute('runtime.animation.blend', { componentId: 'animation', name: 'Walk' }), /does not implement/);
  await assert.rejects(runtime.execute('runtime.physics3d.raycast', {}), /does not implement/);
});
test('Creator 2 animation uses 2.x state/time API and validates ambiguity and duration before commands', () => {
  const h = new Creator2Harness(), params = { componentId: 'animation', name: 'Walk' };
  h.features.execute('runtime.animation.play', params); h.features.execute('runtime.animation.pause', params);
  assert.equal(h.component.state.isPaused, true);
  const sought = Json.object(h.features.execute('runtime.animation.seek', { ...params, time: 1 }));
  assert.equal(Json.object(sought.after).time, 1); assert.equal(sought.frameVerified, false);
  assert.deepEqual(h.component.calls, ['play:Walk', 'seek:Walk', 'sample:Walk']);
  assert.throws(() => h.features.execute('runtime.animation.seek', { ...params, time: 3 }), /duration/);
  h.component.clips.push({ name: 'Walk' }); assert.throws(() => h.features.execute('runtime.animation.play', params), /ambiguous/);
  h.cc.ENGINE_VERSION = '2.4.14'; assert.throws(() => h.features.execute('runtime.animation.state', params), /2.4.15/);
});
test('Creator 2 UI plan binds source revision and rejects stale updates before scene mutation', async () => {
  const h = new Creator2Harness(), service = new Creator2UiService(h.port), params: JsonObject = { parentId: 'root', document: { version: 1, root: { key: 'root', name: 'Panel' } } };
  const plan = Json.object(await service.execute('ui.plan', params));
  h.revision++; await assert.rejects(service.execute('ui.build', { ...params, planHash: plan.planHash! }), /fresh plan/); assert.equal(h.writes, 0);
  const next = Json.object(await service.execute('ui.plan', params)); await service.execute('ui.build', { ...params, planHash: next.planHash! }); assert.equal(h.writes, 1);
});

test('Creator 2 inspection preserves asset UUIDs and avoids editor-only getters in a preview', () => {
  const h = new Creator2Harness();
  class EditorOnlyComponent {
    static __props__ = ['asset', 'assetRows', 'editorEnum'];
    asset = { _uuid: 'asset-uuid' }; assetRows = [{ _uuid: 'other-asset' }];
    get editorEnum(): unknown { throw new Error('Editor-only API absent'); }
  }
  const inspector = new SceneInspector({ major: 2, cc: h.cc });
  const value = inspector.properties(new EditorOnlyComponent() as unknown as Record<string, unknown>);
  assert.deepEqual(value.asset, { uuid: 'asset-uuid' });
  assert.deepEqual(value.assetRows, [{ uuid: 'other-asset' }]);
  assert.deepEqual(value.editorEnum, { inspection: 'accessor-not-evaluated' });
  Object.assign(h.root, { kind: 'cc.Scene' });
  Object.defineProperty(h.root, 'active', { get: () => { throw new Error('Scene.active is unsupported'); } });
  Object.defineProperty(h.root, 'activeInHierarchy', { get: () => { throw new Error('Scene.activeInHierarchy is unsupported'); } });
  assert.equal(inspector.summary(h.root, false).active, true);
});

class Material2 {
  uuid = 'material'; effectAsset = { _uuid: 'effect' }; techniqueIndex = 0; destroyed = false;
  effect: { passes: Array<Record<string, unknown>> };
  constructor(parent?: Material2) {
    this.effect = { passes: [{ _properties: Object.assign(Object.create(parent?.effect.passes[0]!._properties ?? null), parent ? {} : { alphaThreshold: { value: 0.5 }, texture: { value: { nativeTexture: true } } }), _defines: Object.assign(Object.create(null), { USE_TEXTURE: true }) }] };
  }
  setProperty(name: string, value: unknown): void { if (name === 'texture') throw new Error('gfx texture cannot be passed as cc.Texture2D'); (this.effect.passes[0]!._properties as Record<string, unknown>)[name] = { value }; }
  getProperty(name: string): unknown { return ((this.effect.passes[0]!._properties as Record<string, { value: unknown }>)[name])?.value; }
  define(name: string, value: unknown): void { (this.effect.passes[0]!._defines as Record<string, unknown>)[name] = value; }
  getDefine(name: string): unknown { return (this.effect.passes[0]!._defines as Record<string, unknown>)[name]; }
  destroy(): void { this.destroyed = true; }
}
class Material2Harness {
  original = new Material2();
  component = { uuid: 'sprite', isValid: true, materials: [this.original], setMaterial: (slot: number, value: Material2): void => { this.component.materials[slot] = value; } };
  root = { uuid: 'root', children: [], getComponents: () => [this.component] };
  inspector = new SceneInspector({ major: 2, cc: { ENGINE_VERSION: '2.4.15', MaterialVariant: Material2, director: { getScene: () => this.root } } });
}
test('Creator 2 repeated material edits preserve native texture records and restore only owned bindings', async () => {
  const { Creator2Material } = await import('../packages/runtime2-bridge/src/material.js');
  const h = new Material2Harness(), controller = new Creator2Material(h.inspector), p = { componentId: 'sprite', properties: { alphaThreshold: 0.2 } };
  await controller.execute('runtime.material.update', p); const first = h.component.materials[0]!;
  await controller.execute('runtime.material.update', { ...p, properties: { alphaThreshold: 0.3 } });
  assert.equal(first.destroyed, true); assert.equal(h.original.destroyed, false);
  assert.equal(h.component.materials[0]!.getProperty('alphaThreshold'), 0.3);
  assert.deepEqual(h.component.materials[0]!.getProperty('texture'), { nativeTexture: true });
  await controller.execute('runtime.material.reset', { componentId: 'sprite' }); assert.equal(h.component.materials[0], h.original);
  await controller.execute('runtime.material.update', p); const owned = h.component.materials[0]!;
  h.component.materials[0] = new Material2(); const external = h.component.materials[0]; controller.dispose();
  assert.equal(h.component.materials[0], external); assert.equal(owned.destroyed, true);
});

class ControlHarness {
  component = { uuid: 'control', kind: 'cc.Toggle', enabled: true, interactable: true, node: { activeInHierarchy: true },
    get isChecked(): boolean { return true; }, set isChecked(_value: boolean) { /* 模拟不允许全部取消的 Toggle 分组。 */ } };
  root = { uuid: 'controls', children: [], getComponents: () => [this.component] };
  cc = { ENGINE_VERSION: '2.4.15', director: { getScene: () => this.root }, js: { getClassName: (value: { kind?: string }) => value.kind ?? 'cc.Node' } };
  runtime = new Creator2Runtime({ cc: this.cc });
}
test('Creator 2 controls preserve group rejection and reject disabled controls and wrong actions', async () => {
  const h = new ControlHarness();
  const result = Json.object(await h.runtime.execute('runtime.control.toggle', { componentId: 'control', checked: false }));
  assert.equal(result.accepted, false); assert.equal(Json.object(result.after).checked, true);
  assert.equal(result.inputMode, 'programmatic'); assert.equal(result.visualVerified, false);
  await assert.rejects(h.runtime.execute('runtime.control.slider', { componentId: 'control', progress: 0.5 }), /does not match/);
  h.component.interactable = false;
  await assert.rejects(h.runtime.execute('runtime.control.toggle', { componentId: 'control', checked: false }), /disabled/);
  assert.equal(Json.object(await h.runtime.execute('runtime.control.inspect', { componentId: 'control' })).interactable, false);
});
test('Creator 2 control numeric validation rejects nonfinite values before native setters', async () => {
  const h = new ControlHarness();
  let progress = 0, writes = 0;
  Object.assign(h.component, { kind: 'cc.Slider' });
  Object.defineProperty(h.component, 'progress', { get: () => progress, set: (n: number) => { writes++; progress = n; } });
  for (const value of [NaN, Infinity, -1, 1.1]) await assert.rejects(h.runtime.execute('runtime.control.slider', { componentId: 'control', progress: value }), /between/);
  assert.equal(writes, 0);
  const result = Json.object(await h.runtime.execute('runtime.control.slider', { componentId: 'control', progress: 0.75 }));
  assert.equal(Json.object(result.after).progress, 0.75); assert.equal(writes, 1);
});
