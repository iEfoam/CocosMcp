import assert from 'node:assert/strict';
import test from 'node:test';
import { ClipDocumentModel } from '../packages/animation-core/src/index.js';
import { AnimationTools } from '../packages/runtime3-bridge/src/animation.js';
import { FontInspector } from '../packages/runtime3-bridge/src/font.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import { MaterialController } from '../packages/runtime3-bridge/src/material.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
import type { RuntimeObject } from '../packages/runtime3-bridge/src/access.js';

class NativeCurve {
  keys: Array<[number, { value: number; interpolationMode: number }]> = [];
  assignSorted(keys: typeof this.keys): void { this.keys = keys; }
  get keyFramesCount(): number { return this.keys.length; }
  times(): number[] { return this.keys.map(row => row[0]); }
  evaluate(time: number): number {
    const [a, b] = this.keys; if (!b || time <= a![0] || a![1].interpolationMode === 1) return a![1].value;
    return a![1].value + (b[1].value - a![1].value) * (time - a![0]) / (b[0] - a![0]);
  }
}
class NativeTrack { path: unknown; componentsCount = 0; readonly rows = ['X', 'Y', 'Z', 'W'].map(name => ({ name, curve: new NativeCurve() })); channels() { return this.rows; } }
class NativePath { rows: string[] = []; toHierarchy(path: string): this { this.rows.push(path); return this; } toProperty(property: string): this { this.rows.push(property); return this; } }
class NativeClip { uuid = 'clip'; name = ''; duration = 0; sample = 60; wrapMode = 1; tracks: NativeTrack[] = []; destroyed = false; addTrack(track: NativeTrack): void { this.tracks.push(track); } destroy(): void { this.destroyed = true; } }
class NativeFont { uuid = 'font'; fntConfig: unknown = { fontDefDictionary: { 65: {}, 128512: {} } }; spriteFrame = { uuid: 'glyph-page' }; }
class AnimationHarness {
  clip: NativeClip | undefined; font = new NativeFont();
  root = { uuid: 'root', name: 'Root', children: [], getComponents: () => [] };
  cc: RuntimeObject = { AnimationClip: NativeClip, Font: NativeFont, animation: { VectorTrack: NativeTrack, TrackPath: NativePath },
    director: { getScene: () => this.root }, js: { getClassName: (value: unknown) => value instanceof NativeFont ? 'cc.BitmapFont' : 'cc.animation.VectorTrack' },
    assetManager: { loadAny: (uuid: string, callback: (error: Error | null, value: unknown) => void) => callback(null, uuid === 'font' ? this.font : this.clip) } };
  inspector = new SceneInspector({ cc: this.cc, major: 3, serialize: value => { this.clip = value as NativeClip; return { nativeSerialized: true, name: this.clip.name }; } });
  assets = new MaterialController(this.inspector.environment);
  document = { name: 'Move', duration: 2, tracks: [{ path: '', property: 'position', keys: [{ time: 0, value: { x: 0, y: 0, z: 0 } }, { time: 2, value: { x: 4, y: 2, z: 0 } }] }] };
}

test('animation document rejects unordered frames, ambiguous channels, invalid target paths and unsupported fields', () => {
  const h = new AnimationHarness(), model = new ClipDocumentModel(); model.parse(h.document);
  assert.throws(() => model.parse({ ...h.document, tracks: [...h.document.tracks, ...h.document.tracks] }), /Duplicate/);
  assert.throws(() => model.parse({ ...h.document, tracks: [{ ...h.document.tracks[0], path: '../outside' }] }), /relative/);
  assert.throws(() => model.parse({ ...h.document, tracks: [{ ...h.document.tracks[0], keys: [...h.document.tracks[0]!.keys].reverse() }] }), /increasing/);
  assert.throws(() => model.parse({ ...h.document, duration: 1 }), /duration/);
});

test('animation serialization uses native track and curve APIs, validates target first and disposes temporary clip', async () => {
  const h = new AnimationHarness(), tools = new AnimationTools(h.inspector, h.assets);
  assert.throws(() => tools.serialize({ document: { ...h.document, tracks: [{ ...h.document.tracks[0], path: 'Missing' }] } as unknown as JsonObject, rootId: 'root' }), /missing/);
  assert.equal(h.clip, undefined);
  assert.equal(Json.object(tools.serialize({ document: h.document as unknown as JsonObject, rootId: 'root' })).nativeSerialized, true);
  assert.equal(h.clip!.destroyed, true);
  assert.equal(h.clip!.tracks[0]!.componentsCount, 3);
  const result = Json.object(await tools.inspect({ uuid: 'clip', time: 1 }));
  const channel = ((result.rows as JsonObject[])[0]!.channels as JsonObject[])[0]!;
  assert.equal(channel.sampledValue, 2); assert.equal(result.scope, 'native-curve-evaluation');
});

test('font inspection distinguishes bitmap glyph evidence and unknown dynamic font coverage', async () => {
  const h = new AnimationHarness(), fonts = new FontInspector(h.inspector, h.assets);
  const bitmap = Json.object(await fonts.inspect({ uuid: 'font', sampleText: 'A B 😀' }));
  assert.deepEqual(bitmap.missing, ['B']); assert.equal(bitmap.spriteFrameUuid, 'glyph-page');
  h.font.fntConfig = null;
  const dynamic = Json.object(await fonts.inspect({ uuid: 'font', sampleText: '汉' }));
  assert.equal(dynamic.glyphCoverage, 'unknown'); assert.equal((dynamic.rows as JsonObject[])[0]!.present, null);
});

test('animation patch deserializes an independent clip, keeps untouched tracks and rejects external references', () => {
  const h = new AnimationHarness(), tools = new AnimationTools(h.inspector, h.assets);
  const original = new NativeClip(); original.name = 'Original'; original.duration = 2;
  const first = new NativeTrack(); first.componentsCount = 3; const second = new NativeTrack(); second.componentsCount = 3;
  original.tracks = [first, second];
  let dependencies = false;
  const deserialize = Object.assign((_source: string, details: { uuidList: string[] }) => { details.uuidList = dependencies ? ['external'] : []; return original; }, { Details: class { uuidList: string[] = []; } });
  h.cc.deserialize = deserialize;
  const patches = [{ trackIndex: 0, keys: [{ time: 0, value: { x: 9, y: 0, z: 0 } }] }];
  tools.patchSource({ content: '{}', patches });
  assert.equal(first.rows[0]!.curve.keys[0]![1].value, 9); assert.equal(second.rows[0]!.curve.keys.length, 0); assert.equal(original.destroyed, true);
  dependencies = true;
  assert.throws(() => tools.patchSource({ content: '{}', patches }), /external resource/);
  assert.throws(() => tools.patchSource({ content: '{}', patches: [...patches, ...patches] }), /Duplicate/);
});
