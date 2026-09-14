import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import { Creator3Adapter, type EditorPort } from '../packages/creator3-adapter/src/index.js';
import type { RuntimeObject } from '../packages/runtime3-bridge/src/access.js';

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

test('node creation supplies scene root and rejects unattached native false success', async () => {
  let options: unknown;
  const port = {
    scene: async (method: string, id?: unknown) => method === 'sceneInfo' ? {sceneId: 'root'} : id === 'root',
    request: async (_channel: string, message: string, value: unknown) => {
      assert.equal(message, 'create-node'); options = value; return 'orphan';
    },
  } as unknown as EditorPort;
  await assert.rejects(new Creator3Adapter(port).execute('node.create', {name: 'Cube'}), /not attached/);
  assert.deepEqual(options, {name: 'Cube', parent: 'root'});
});

test('prefab conversion returns replacement IDs matched by subtree position', async () => {
  const port = {
    scene: async (method: string, id: unknown) => {
      if (method === 'childAt') return 'new';
      return {parentId: 'scene', index: 0, rows: [{path: '', name: 'Root', nodeId: id}, {path: '/0', name: 'Child', nodeId: `${String(id)}-child`}]};
    },
    request: async () => 'prefab-asset',
  } as unknown as EditorPort;
  assert.deepEqual(await new Creator3Adapter(port).execute('prefab.create', {nodeId: 'old', url: 'db://assets/test.prefab'}), {
    assetUuid: 'prefab-asset', rootId: 'new', rows: [
      {path: '', previousNodeId: 'old', nodeId: 'new'},
      {path: '/0', previousNodeId: 'old-child', nodeId: 'new-child'},
    ],
  });
});

test('save copy refuses existing resource before serialization or write', async () => {
  const port = {
    scene: async () => { throw new Error('must not serialize'); },
    request: async (_channel: string, message: string) => { assert.equal(message, 'query-asset-info'); return {uuid: 'existing'}; },
  } as unknown as EditorPort;
  await assert.rejects(new Creator3Adapter(port).execute('scene.save_copy', {url: 'db://assets/test.scene'}), /already exists/);
});

test('component location preserves missing-script slots in native property paths', () => {
  const camera = {uuid: 'camera'};
  const root = {uuid: 'root', children: [], _components: [null, camera], getComponents: () => [camera]};
  const inspector = new SceneInspector({cc: {director: {getScene: () => root}}, major: 3, editor: true});
  assert.deepEqual(inspector.execute('componentLocation', ['camera']), {nodeId: 'root', index: 1});
});
