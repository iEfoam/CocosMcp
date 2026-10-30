import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import { Creator3Adapter, type EditorPort } from '../packages/creator3-adapter/src/index.js';
import type { RuntimeObject } from '../packages/runtime3-bridge/src/access.js';
import { SceneResponse } from '../extensions/creator3/src/scene-response.js';
import { CocosError, Json } from '../packages/contracts/src/index.js';
import { PrefabService } from '../packages/creator3-adapter/src/prefab.js';
import { CreatorAccount } from '../scripts/creator-account.mjs';

test('launcher identifies a live Node PID as unrelated to Creator without exposing process arguments', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  assert.equal(await new CreatorAccount().processState(process.pid), 'other');
});

test('prefab apply verifies file writes independently of an ambiguous native false result', async t => {
  const root = await mkdtemp(join(process.env.TMPDIR!, 'prefab-apply-')); t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'assets', 'Prefabs'), {recursive: true});
  const path = join(root, 'assets', 'Prefabs', 'test.prefab'); await writeFile(path, 'before');
  let write = true;
  const port = {projectPath: root, scene: async () => ({assetUuid: 'asset'}),
    request: async (_channel: string, method: string) => {
      if (method === 'query-asset-info') return {url: 'db://assets/Prefabs/test.prefab', type: 'cc.Prefab'};
      if (write) await writeFile(path, 'after');
      return false;
    },
  } as unknown as EditorPort;
  const result = await new PrefabService(port).apply('root');
  assert.equal(result.nativeResult, false); assert.equal(result.resourceChanged, true);
  assert.equal(result.verification, 'asset-write-observed');
  write = false;
  await assert.rejects(new PrefabService(port).apply('root'), error => error instanceof CocosError && error.code === 'OUTCOME_UNKNOWN');
});

test('scene IPC preserves actionable errors without throwing inside Creator dispatch', async () => {
  const response = await SceneResponse.capture(async () => { throw new CocosError('NOT_FOUND', 'missing material', {uuid: 'missing'}); });
  assert.throws(() => SceneResponse.unwrap(JSON.parse(JSON.stringify(response))), error => error instanceof CocosError && error.code === 'NOT_FOUND' && JSON.stringify(error.details) === JSON.stringify({uuid: 'missing'}));
  assert.deepEqual(SceneResponse.unwrap({rows: []}), {rows: []});
});

test('scene opening resolves URLs, rejects wrong assets before mutation, and verifies native result', async () => {
  let info: unknown = null; let current = 'target'; let opened = 0;
  const port = {
    request: async (_channel: string, method: string, value: unknown) => {
      if (method === 'query-asset-info') { assert.equal(value, 'db://assets/Scenes/target.scene'); return info; }
      if (method === 'query-dirty') return false;
      if (method === 'open-scene') { assert.equal(value, 'target'); opened++; return true; }
      throw new Error(method);
    },
    scene: async () => ({sceneId: current}),
  } as unknown as EditorPort;
  const adapter = new Creator3Adapter(port);
  await assert.rejects(adapter.execute('scene.open', {uuid: 'db://assets/Scenes/target.scene'}), /Scene resource/);
  info = {uuid: 'target', type: 'cc.Material'};
  await assert.rejects(adapter.execute('scene.open', {uuid: 'db://assets/Scenes/target.scene'}), /SceneAsset/);
  assert.equal(opened, 0);
  info = {uuid: 'target', type: 'cc.SceneAsset'};
  await adapter.execute('scene.open', {uuid: 'db://assets/Scenes/target.scene'});
  assert.equal(opened, 1);
  current = 'empty';
  await assert.rejects(adapter.execute('scene.open', {uuid: 'db://assets/Scenes/target.scene'}), error => error instanceof CocosError && error.code === 'VERIFICATION_FAILED');
});

test('prefab opening requires a saved scene and verifies native editing context', async () => {
  let dirty = true, sceneId = 'asset', opened = 0;
  const port = {
    request: async (_channel: string, method: string) => {
      if (method === 'query-asset-info') return {uuid: 'asset', type: 'cc.Prefab'};
      if (method === 'query-dirty') return dirty;
      if (method === 'open-scene') { opened++; return true; }
      if (method === 'query-current-scene') return sceneId;
      if (method === 'query-scene-mode') return 'prefab';
      throw new Error(method);
    }, scene: async () => ({sceneId}),
  } as unknown as EditorPort;
  const adapter = new Creator3Adapter(port);
  await assert.rejects(adapter.execute('prefab.open', {uuid: 'asset'}), error => error instanceof CocosError && error.code === 'RESOURCE_BUSY');
  assert.equal(opened, 0); dirty = false;
  assert.equal((await adapter.execute('prefab.open', {uuid: 'asset'}) as {editing: string}).editing, 'native-prefab');
  sceneId = 'other';
  await assert.rejects(adapter.execute('prefab.open', {uuid: 'asset'}), error => error instanceof CocosError && error.code === 'OUTCOME_UNKNOWN');
});

test('native prefab save acknowledgements resolve asset identity instead of returning boolean UUIDs', async () => {
  let uuid: unknown = 'prefab-asset';
  const port = {request: async (_channel: string, method: string) => method === 'save-scene' ? true : method === 'query-dirty' ? false : uuid} as unknown as EditorPort;
  const adapter = new Creator3Adapter(port);
  assert.deepEqual(await adapter.execute('scene.save', {}), {sceneUuid: 'prefab-asset', saved: true});
  uuid = null;
  await assert.rejects(adapter.execute('scene.save', {}), error => error instanceof CocosError && error.code === 'OUTCOME_UNKNOWN');
});

class Harness {
  calls: Array<{message: string; args: unknown[]}> = [];
  property = 1;
  exists = true;
  port = {
    scene: async (method: string) => {
      if (method === 'componentLocation') return {nodeId: 'owner', index: 2};
      if (method === 'nodeExists') return this.exists;
      throw new Error(method);
    },
    request: async (_channel: string, message: string, ...args: unknown[]) => {
      this.calls.push({message, args});
      if (message === 'query-component') return {type: 'cc.Camera', value: {fov: {type: 'Number', value: this.property}}};
      if (message === 'begin-recording') return 'record';
      if (message === 'set-property') { this.property = ((args[0] as {dump: {value: number}}).dump.value); return true; }
      if (message === 'remove-node') { this.exists = false; return null; }
      if (message === 'query-node') return {uuid: 'cached-deleted-node'};
      return null;
    },
  } as unknown as EditorPort;
}

test('component writes use owner node and component index, with component readback', async () => {
  const harness = new Harness();
  await new Creator3Adapter(harness.port).execute('component.set', {componentId: 'camera', properties: {fov: 45}});
  assert.deepEqual(harness.calls.find(call => call.message === 'begin-recording')!.args, ['owner']);
  const patch = harness.calls.find(call => call.message === 'set-property')!.args[0] as Record<string, unknown>;
  assert.equal(patch.uuid, 'owner'); assert.equal(patch.path, '__comps__.2.fov');
  assert.equal(harness.property, 45);
});

test('node deletion verifies live membership instead of stale editor query cache', async () => {
  const harness = new Harness();
  const result = await new Creator3Adapter(harness.port).execute('node.delete', {nodeId: 'deleted'});
  assert.deepEqual(result, {deletedNodeId: 'deleted'});
  assert.equal(harness.calls.some(call => call.message === 'query-node'), false);
});

test('scene tree filters editor DontSave subtrees but preserves runtime objects', () => {
  const child = {uuid: 'child', name: 'Visible', children: [], getComponents: () => []};
  const internal = {uuid: 'internal', name: 'Internal', _objFlags: 8, children: [{uuid: 'gizmo', children: []}], getComponents: () => []};
  const root = {uuid: 'root', name: 'Scene', children: [child, internal], getComponents: () => []};
  const cc = {director: {getScene: () => root}} as RuntimeObject;
  const editor = new SceneInspector({cc, major: 3, editor: true});
  assert.deepEqual(editor.all().map(node => node.uuid), ['root', 'child']);
  assert.equal(editor.sceneInfo().nodeCount, 1);
  assert.deepEqual(editor.summary(root, false).children, ['child']);
  assert.throws(() => editor.node('internal'), /Node not found/);
  assert.equal(editor.all(root, true).length, 4);
  assert.equal(new SceneInspector({cc, major: 3}).all().length, 4);
});

test('failed component verification cancels only its own recording', async () => {
  const harness = new Harness(); const request = harness.port.request;
  harness.port.request = async (channel, message, ...args) => message === 'set-property' ? false : request(channel, message, ...args);
  await assert.rejects(new Creator3Adapter(harness.port).execute('component.set', {componentId: 'camera', properties: {fov: 45}}), /rejected/);
  assert.deepEqual(harness.calls.find(call => call.message === 'cancel-recording')!.args, ['record']);
  assert.equal(harness.calls.some(call => call.message === 'undo'), false);
});

class LabelLayoutHarness {
  added = false;
  pending = false;
  text = 'label';
  width = 32;
  flushFailure = false;
  calls: string[] = [];
  advanceFrame(): void {
    if (this.pending) { this.width = this.text.length * 20; this.pending = false; }
  }
  port = {
    scene: async (method: string, value?: { componentId?: string }) => {
      this.calls.push(method);
      if (method === 'componentIds') return this.added ? ['existing-camera', 'label'] : ['existing-camera'];
      if (method === 'componentLocation') return { nodeId: 'owner', index: 1 };
      if (method === 'fingerprint') return { added: this.added, text: this.text, width: this.width };
      if (method === 'ui.flush_label') {
        assert.equal(value?.componentId, 'label');
        if (this.flushFailure) throw new CocosError('EDITOR_ERROR', 'layout failed');
        this.advanceFrame(); return { flushed: true };
      }
      throw new Error(method);
    },
    request: async (_channel: string, method: string, value?: { dump: { value: string } }) => {
      this.calls.push(method);
      if (method === 'create-component') { this.added = true; this.pending = true; return null; }
      if (method === 'query-component') return { type: 'cc.Label', value: { string: { type: 'String', value: this.text } } };
      if (method === 'query-node') return { width: this.width };
      if (method === 'set-property') { this.text = value!.dump.value; this.pending = true; return true; }
      if (method === 'begin-recording') return 'record';
      if (method === 'end-recording' || method === 'cancel-recording') return null;
      throw new Error(method);
    },
  } as unknown as EditorPort;
}

test('adding a native Label returns settled node geometry and a revision stable across its next render frame', async () => {
  const harness = new LabelLayoutHarness(), adapter = new Creator3Adapter(harness.port);
  const result = await adapter.execute('component.add', { nodeId: 'owner', type: 'cc.Label' });
  assert.deepEqual(result, { componentIds: ['label'], node: { width: 100 } });
  assert.equal(harness.pending, false);
  const revision = await adapter.revision(); harness.advanceFrame();
  assert.equal(await adapter.revision(), revision);
  assert.equal(harness.calls.filter(call => call === 'ui.flush_label').length, 1);
});

test('Label property writes settle native layout before readback and completing their own undo recording', async () => {
  const harness = new LabelLayoutHarness(); harness.added = true;
  const adapter = new Creator3Adapter(harness.port);
  await adapter.execute('component.set', { componentId: 'label', properties: { string: 'native result' } });
  assert.equal(harness.text, 'native result'); assert.equal(harness.width, 260); assert.equal(harness.pending, false);
  assert.ok(harness.calls.indexOf('ui.flush_label') < harness.calls.lastIndexOf('query-component'));
  assert.ok(harness.calls.lastIndexOf('query-component') < harness.calls.indexOf('end-recording'));
  const revision = await adapter.revision(); harness.advanceFrame();
  assert.equal(await adapter.revision(), revision);
});

test('failed layout after Label creation reports the existing component identity as an unknown outcome', async () => {
  const harness = new LabelLayoutHarness(); harness.flushFailure = true;
  await assert.rejects(new Creator3Adapter(harness.port).execute('component.add', { nodeId: 'owner', type: 'cc.Label' }),
    error => error instanceof CocosError && error.code === 'OUTCOME_UNKNOWN' && JSON.stringify(Json.object(error.details ?? {}).componentIds) === JSON.stringify(['label']));
  assert.equal(harness.added, true);
  assert.equal(harness.calls.filter(call => call === 'create-component').length, 1);
});

test('failed Label layout cancels its own property recording and does not report an unstable success', async () => {
  const harness = new LabelLayoutHarness(); harness.added = true; harness.flushFailure = true;
  await assert.rejects(new Creator3Adapter(harness.port).execute('component.set', { componentId: 'label', properties: { string: 'failure' } }), /layout failed/);
  assert.equal(harness.calls.includes('cancel-recording'), true);
  assert.equal(harness.calls.includes('end-recording'), false);
  assert.equal(harness.calls.includes('undo'), false);
});

test('node creation supplies scene root and rejects unattached native false success', async () => {
  let options: unknown;
  const port = {
    scene: async (method: string, id?: unknown) => method === 'sceneInfo' ? {sceneId: 'root'} : id === 'root',
    request: async (_channel: string, message: string, value: unknown) => {
      assert.equal(message, 'create-node'); options = value; return 'orphan';
    },
  } as unknown as EditorPort;
  await assert.rejects(new Creator3Adapter(port).execute('node.create', {name: 'Cube'}), { code: 'OUTCOME_UNKNOWN', message: 'Created node was not attached to the active scene' });
  assert.deepEqual(options, {name: 'Cube', parent: 'root'});
});

test('prefab conversion returns replacement IDs matched by subtree position', async t => {
  const root = await mkdtemp(join(process.env.TMPDIR!, 'prefab-regression-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets', 'Prefabs'), { recursive: true });
  const port = {
    projectPath: root,
    scene: async (method: string, id: unknown) => {
      if (method === 'childAt') return 'new';
      return {parentId: 'scene', index: 0, rows: [{path: '', name: 'Root', nodeId: id}, {path: '/0', name: 'Child', nodeId: `${String(id)}-child`}]};
    },
    request: async () => 'prefab-asset',
  } as unknown as EditorPort;
  assert.deepEqual(await new Creator3Adapter(port).execute('prefab.create', {nodeId: 'old', url: 'db://assets/Prefabs/test.prefab'}), {
    assetLocation: { requestedUrl: 'db://assets/Prefabs/test.prefab', url: 'db://assets/Prefabs/test.prefab', folderUrl: 'db://assets/Prefabs', type: 'prefab', reuseExistingFolder: true, targetExists: false },
    assetUuid: 'prefab-asset', rootId: 'new', rows: [
      {path: '', previousNodeId: 'old', nodeId: 'new'},
      {path: '/0', previousNodeId: 'old-child', nodeId: 'new-child'},
    ],
  });
});

test('prefab instantiation preserves native association and reports uncertain creation without replay', async () => {
  let name = 'AssetName', associated = true, creations = 0;
  const port = {
    scene: async (method: string) => {
      if (method === 'sceneInfo') return {sceneId: 'scene'};
      if (method === 'nodeExists') return true;
      if (method === 'hierarchy') return {rows: [{nodeId: 'instance', parentId: 'scene', name}]};
      if (method === 'prefabReference') {
        if (!associated) throw new CocosError('INVALID_ARGUMENT', 'Select the prefab instance root');
        return {assetUuid: 'asset', rootId: 'instance'};
      }
      throw new Error(method);
    },
    request: async (_channel: string, method: string, value: {dump?: {value: string}}) => {
      if (method === 'create-node') {
        assert.deepEqual(value, {name: 'Editing', parent: 'scene', assetUuid: 'asset', type: 'cc.Prefab', unlinkPrefab: false});
        creations++; return 'instance';
      }
      if (method === 'query-node') return {name: {type: 'String', value: name}};
      if (method === 'set-property') { name = value.dump!.value; return true; }
      return 'record';
    },
  } as unknown as EditorPort;
  const adapter = new Creator3Adapter(port);
  assert.equal((await adapter.execute('prefab.instantiate', {uuid: 'asset', name: 'Editing'}) as {nodeId: string}).nodeId, 'instance');
  associated = false;
  await assert.rejects(adapter.execute('prefab.instantiate', {uuid: 'asset', name: 'Editing'}), error => error instanceof CocosError && error.code === 'OUTCOME_UNKNOWN');
  assert.equal(creations, 2);
});

test('save copy refuses existing resource before serialization or write', async t => {
  const root = await mkdtemp(join(process.env.TMPDIR!, 'scene-copy-regression-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets', 'Scenes'), { recursive: true }); await writeFile(join(root, 'assets', 'Scenes', 'test.scene'), '{}');
  const port = {
    projectPath: root,
    scene: async () => { throw new Error('must not serialize'); },
    request: async (_channel: string, message: string) => { assert.equal(message, 'query-asset-info'); return {uuid: 'existing'}; },
  } as unknown as EditorPort;
  await assert.rejects(new Creator3Adapter(port).execute('scene.save_copy', {url: 'db://assets/test.scene'}), /already exists/);
});

test('prefab conversion accepts only native filename root rename and still rejects child changes', async t => {
  const root = await mkdtemp(join(process.env.TMPDIR!, 'prefab-rename-')); t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'assets', 'Prefabs'), {recursive: true});
  let childName = 'Child';
  const port = {projectPath: root,
    scene: async (method: string, id: unknown) => method === 'childAt' ? 'new' : {parentId: 'scene', index: 0, rows: [
      {path: '', name: id === 'old' ? 'Original' : 'Repaired', nodeId: id},
      {path: '/0', name: id === 'old' ? 'Child' : childName, nodeId: `${String(id)}-child`},
    ]}, request: async () => 'prefab-asset',
  } as unknown as EditorPort;
  const result = await new Creator3Adapter(port).execute('prefab.create', {nodeId: 'old', url: 'db://assets/Prefabs/Repaired.prefab'});
  assert.equal((result as {rootName: string}).rootName, 'Repaired');
  childName = 'Unexpected';
  await assert.rejects(new Creator3Adapter(port).execute('prefab.create', {nodeId: 'old', url: 'db://assets/Prefabs/Repaired.prefab'}), /changed subtree structure/);
});

test('component location preserves missing-script slots in native property paths', () => {
  const camera = {uuid: 'camera'};
  const root = {uuid: 'root', children: [], _components: [null, camera], getComponents: () => [camera]};
  const inspector = new SceneInspector({cc: {director: {getScene: () => root}}, major: 3, editor: true});
  assert.deepEqual(inspector.execute('componentLocation', ['camera']), {nodeId: 'root', index: 1});
});
