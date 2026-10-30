import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator3UiStructure } from '../extensions/creator3/src/ui-structure.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import type { RuntimeObject } from '../packages/runtime3-bridge/src/access.js';
import type { JsonObject } from '../packages/contracts/src/index.js';
import { Creator3Adapter, type EditorPort } from '../packages/creator3-adapter/src/index.js';
import { Creator3UiStructureExecution } from '../extensions/creator3/src/ui-structure-execution.js';

class Component { static constructed = 0; constructor() { Component.constructed++; } }
class Label extends Component {}
class CustomLabel extends Label { uuid = 'label'; }
class Button extends Component { static _requireComponent = Label; }
class UITransform extends Component { uuid = 'transform'; }
class Canvas extends Component { uuid = 'canvas'; }
class StructureHarness {
  mode = 'general';
  root: RuntimeObject = { uuid: 'root', name: 'Root', parent: null, children: [], _components: [] };
  child: RuntimeObject = { uuid: 'child', name: 'Child', parent: this.root, children: [], _components: [new CustomLabel()] };
  table: JsonObject[] = [{ __type__: 'cc.Node', _id: 'root' }, { __type__: 'cc.Node', _id: 'child' }, { __type__: 'CustomLabel', _id: 'label' }];
  types = new Map<string, Function>([['cc.Component', Component], ['cc.Label', Label], ['CustomLabel', CustomLabel], ['cc.Button', Button], ['cc.UITransform', UITransform], ['cc.Canvas', Canvas]]);
  inspector = new SceneInspector({ major: 3, editor: true, serialize: () => this.table, cc: {
    Component, director: { getScene: () => this.root }, js: {
      getClassByName: (name: string) => this.types.get(name),
      _getClassId: (type: Function) => [...this.types].find(([, ctor]) => ctor === type)?.[0] ?? '',
      getClassName: (value: unknown) => [...this.types].find(([, ctor]) => ctor === (typeof value === 'function' ? value : (value as object).constructor))?.[0] ?? '',
      isChildClassOf: (value: Function) => value.prototype instanceof Component,
    },
  } });
  host = new Creator3UiStructure(this.inspector, { queryMode: () => this.mode });
  constructor() { this.root.children = [this.child]; }
  plan(rows: JsonObject[]): JsonObject { return this.host.plan({ rootId: 'root', rows }); }
}

test('Creator 3 planning reads native dependency metadata, handles subclasses and does not construct components', () => {
  const f = new StructureHarness(), count = Component.constructed;
  const rows = [{ action: 'add_component', node: 'child', type: 'cc.Button' }];
  const plan = f.plan(rows);
  assert.equal(plan.applicable, true); assert.equal(plan.applySupported, true);
  assert.equal(f.plan(rows).planHash, plan.planHash);
  assert.equal(Component.constructed, count); assert.equal((f.child._components as unknown[]).length, 1);
  f.table[1]!.arbitrarySavedProperty = 123;
  assert.notEqual(f.plan(rows).planHash, plan.planHash);
  assert.throws(() => f.plan([{ action: 'add_component', node: 'root', type: 'cc.Button' }]), /dependency/);
  assert.equal(f.plan([{ action: 'add_component', node: 'root', type: 'cc.Label' }, { action: 'add_component', node: 'root', type: 'cc.Button' }]).applicable, true);
  assert.throws(() => f.plan([{ action: 'add_component', node: 'root', type: 'unregistered' }]), /unavailable/);
});

test('Creator 3 planning rejects non-editing modes and protects Prefab instances and external references', () => {
  const f = new StructureHarness();
  f.mode = 'animation'; assert.throws(() => f.plan([{ action: 'remove', node: 'child' }]), /scene mode/);
  f.mode = 'general'; f.root._prefab = { asset: 'prefab' };
  assert.throws(() => f.plan([{ action: 'remove', node: 'child' }]), /dedicated workflow/);
  delete f.root._prefab;
  f.table.push({ __type__: 'Owner', _id: 'outside', target: { __id__: 2 } });
  assert.equal(f.plan([{ action: 'remove', node: 'child' }]).applicable, false);
});

test('Creator 3 Prefab asset plans bind the native proxy root and asset identity while protecting nested instances', () => {
  const f = new StructureHarness(); let assetUuid = 'asset-a';
  const facade = { queryMode: () => 'prefab', getCurrentFacade: () => ({ _sceneProxy: {
    getRootNode: () => f.root, queryCurrentSceneUuid: () => assetUuid,
  } }) };
  f.root._prefab = { root: f.root, asset: { uuid: assetUuid } };
  f.child._prefab = { root: f.root, asset: { uuid: assetUuid } };
  const host = new Creator3UiStructure(f.inspector, facade);
  const params = { rootId: 'root', rows: [{ action: 'create', key: 'new', parent: 'child', name: 'New' }] };
  const plan = host.plan(params);
  assert.equal(plan.applicable, true);
  assert.deepEqual(plan.context, { kind: 'prefab-asset', assetUuid: 'asset-a', rootId: 'root' });
  assetUuid = 'asset-b'; assert.notEqual(host.plan(params).planHash, plan.planHash);
  assert.throws(() => host.plan({ ...params, rootId: 'child' }), /native asset root/);
  f.child._prefab = { root: f.child, asset: { uuid: 'nested' } };
  assert.throws(() => host.plan(params), /dedicated workflow/);
  delete f.child._prefab;
  f.table.push({ __type__: 'Owner', _id: 'outside', target: { __id__: 2 } });
  assert.equal(host.plan({ rootId: 'root', rows: [{ action: 'remove', node: 'child' }] }).applicable, false);
});

test('Creator 3 instance plans bind a whole instance and preserve source-linked and nested nodes', () => {
  const f = new StructureHarness();
  f.root._prefab = { root: f.root, asset: { uuid: 'asset-a' }, fileId: 'source-root' };
  f.child._prefab = { root: f.root, asset: { uuid: 'asset-a' }, fileId: 'source-child' };
  const rows = [{ action: 'create', key: 'new', parent: 'child', name: 'Mounted' }];
  const plan = f.plan(rows);
  assert.deepEqual(plan.context, { kind: 'prefab-instance', assetUuid: 'asset-a', rootId: 'root' });
  assert.throws(() => f.plan([{ action: 'remove', node: 'child' }]), /Source-linked/);
  assert.throws(() => f.plan([{ action: 'move', node: 'child', parent: 'root', index: 0 }]), /Source-linked/);
  assert.throws(() => f.host.plan({ rootId: 'child', rows: [{ action: 'create', key: 'new', parent: 'child', name: 'Mounted' }] }), /dedicated workflow/);
  (f.root._prefab as RuntimeObject).asset = { uuid: 'asset-b' };
  assert.notEqual(f.plan(rows).planHash, plan.planHash);
  delete f.child._prefab;
  assert.equal(f.plan([{ action: 'move', node: 'child', parent: 'root', index: 0 }]).applicable, true);
  f.child._prefab = { root: f.child, asset: { uuid: 'nested' } };
  assert.throws(() => f.plan(rows), /dedicated workflow/);
});

test('Creator 3 planning rejects dependency accessors without executing project getters', () => {
  const f = new StructureHarness(); let calls = 0;
  const original = Object.getOwnPropertyDescriptor(Button, '_requireComponent')!;
  Object.defineProperty(Button, '_requireComponent', { configurable: true, get: () => { calls++; return Label; } });
  try {
    assert.throws(() => f.plan([{ action: 'add_component', node: 'child', type: 'cc.Button' }]), /accessor/);
    assert.equal(calls, 0);
  } finally { Object.defineProperty(Button, '_requireComponent', original); }
});

test('Creator 3 scene serialization PrefabInfo does not mark all scene children as Prefab instances', () => {
  const f = new StructureHarness(); class Scene {}
  f.types.set('cc.Scene', Scene); f.root.constructor = Scene;
  f.root._prefab = { fileId: 'scene-file-id', targetOverrides: [] };
  assert.equal(f.plan([{ action: 'create', key: 'new', parent: 'child', name: 'New' }]).applicable, true);
  f.child._prefab = { root: f.child, asset: { uuid: 'actual-prefab' } };
  assert.throws(() => f.plan([{ action: 'create', key: 'new', parent: 'child', name: 'New' }]), /dedicated workflow/);
});

test('Creator 3 deletion refuses a serialized scene that omits an existing component', () => {
  const f = new StructureHarness();
  f.table = f.table.filter(row => row._id !== 'label');
  const deletion = f.plan([{ action: 'remove', node: 'child' }]);
  assert.equal(deletion.applicable, false);
  const references = deletion.references as JsonObject;
  assert.equal(references.complete, false);
  assert.ok((references.issues as JsonObject[]).some(row => row.code === 'SERIALIZED_OBJECT_MISSING' && row.targetId === 'label'));
  assert.equal(f.plan([{ action: 'move', node: 'child', parent: 'root', index: 0 }]).applicable, true);
});

test('Creator 3 plans automatic UITransform through Canvas ancestors including outside the scoped root', () => {
  const f = new StructureHarness(); f.root._components = [new UITransform(), new Canvas()];
  const rows = [{ action: 'create', key: 'new', parent: 'child', name: 'ChildOfCanvas' }, { action: 'create', key: 'nested', parent: 'new', name: 'Nested' }];
  const plan = f.host.plan({ rootId: 'child', rows });
  for (const key of ['new', 'nested']) assert.deepEqual((plan.resultingNodes as JsonObject[]).find(n => n.key === key)!.componentTypes, ['cc.UITransform']);
  assert.deepEqual((plan.rows as JsonObject[])[0]!.implicitComponentTypes, ['cc.UITransform']);
  const changed = f.plan([{ action: 'remove_component', componentId: 'canvas' }, { action: 'create', key: 'plain', parent: 'child', name: 'Plain' }]);
  assert.deepEqual((changed.resultingNodes as JsonObject[]).find(n => n.key === 'plain')!.componentTypes, []);
  const empty = new StructureHarness();
  const added = empty.plan([{ action: 'add_component', node: 'root', type: 'cc.Canvas' }, { action: 'create', key: 'ui', parent: 'root', name: 'Ui' }]);
  assert.deepEqual((added.resultingNodes as JsonObject[]).find(n => n.key === 'ui')!.componentTypes, ['cc.UITransform']);
});

test('Creator 3 structure plan is routed as read-only and unsupported versions never enter native code', async () => {
  const f = new StructureHarness(), calls: string[] = [];
  const port = { version: '3.8.8', scene: async (method: string, params: JsonObject) => { calls.push(method); return f.host.plan(params); },
    request: async () => { throw new Error('Unexpected write'); } } as unknown as EditorPort;
  const adapter = new Creator3Adapter(port);
  assert.ok(adapter.supportedCapabilities().includes('ui.structure.plan'));
  await adapter.execute('ui.structure.plan', { rootId: 'root', rows: [{ action: 'create', key: 'new', parent: 'root', name: 'New' }] });
  assert.deepEqual(calls, ['ui.structure.plan']);
  port.version = '3.7.0';
  assert.ok(!adapter.supportedCapabilities().includes('ui.structure.plan'));
  await assert.rejects(adapter.execute('ui.structure.plan', {}), { code: 'UNSUPPORTED_VERSION' });
  assert.equal(calls.length, 1);
});

class ExecutionHarness extends StructureHarness {
  manager: RuntimeObject = { _manualCommands: [], _autoCommands: [], _commandArray: [], _index: -1 };
  snapshots = 0;
  writes = 0;
  failAt = 0;
  failSnapshot = false;
  rewriteComponent = false;
  addEditorNode = false;
  interleaveHistory = false;
  facade = { queryMode: () => this.mode, getCurrentFacade: () => ({ _undoMgr: this.manager }),
    beginRecording: (uuids: string[], options: { auto: boolean }) => {
      (this.manager._manualCommands as unknown[]).push({ id: 'command', uuids: [...uuids], auto: options.auto, undoData: new Map(uuids.map(id => [id, { uuid: id }])) }); return 'command';
    }, cancelRecording: () => { this.manager._manualCommands = []; return true; },
    endRecording: () => {
    this.snapshots++;
    if (this.addEditorNode) (this.root.children as RuntimeObject[]).push({ uuid: 'editor-gizmo', name: 'Gizmo', _objFlags: 8, parent: this.root, children: [], _components: [] });
    if (this.rewriteComponent) (this.child._components as RuntimeObject[])[0]!.uuid = 'unexpected-new-identity';
    if (this.failSnapshot) throw new Error('snapshot failed');
    if (this.interleaveHistory) { (this.manager._commandArray as unknown[]).push({ id: 'other-command' }); this.manager._index = Number(this.manager._index) + 1; }
    const command = (this.manager._manualCommands as unknown[]).shift();
    (this.manager._commandArray as unknown[]).push(command); this.manager._index = Number(this.manager._index) + 1; return true;
  }, onNodeBeforeChanged: () => {}, onNodeChanged: () => {} };
  nodes = {
    query: (uuid: string) => this.inspector.all().find(node => node.uuid === uuid),
    createNode: (parentId: string, name: string) => {
      this.writes++; if (this.writes === this.failAt) throw new Error('native create failed');
      const parent = this.nodes.query(parentId)!;
      const node: RuntimeObject = { uuid: `new-${this.writes}`, name, parent, children: [], _components: [],
        setSiblingIndex: (index: number) => { const children = parent.children as RuntimeObject[]; children.splice(children.indexOf(node), 1); children.splice(index, 0, node); } };
      (parent.children as RuntimeObject[]).push(node); return String(node.uuid);
    },
    createComponent: () => { this.writes++; return true; },
  };
  executor = new Creator3UiStructureExecution(this.inspector, this.facade, this.nodes);
  params(): JsonObject {
    const rows = [{ action: 'create', key: 'new-a', parent: 'root', name: 'A', index: 0 }, { action: 'create', key: 'new-b', parent: 'root', name: 'B' }];
    return { rootId: 'root', rows, planHash: this.plan(rows).planHash! };
  }
}

test('Creator 3 structure execution validates hash before writes and preserves native mappings', async () => {
  const f = new ExecutionHarness(), p = f.params();
  await assert.rejects(f.executor.apply({ ...p, planHash: 'stale' }), { code: 'OPERATION_CONFLICT' });
  assert.equal(f.writes, 0); assert.equal(f.snapshots, 0);
  const result = await f.executor.apply(p);
  assert.equal(result.verifiedStructure, true); assert.equal(result.needsSave, true); assert.equal(f.snapshots, 1);
  assert.deepEqual((f.root.children as RuntimeObject[]).map(node => node.uuid), ['new-1', 'child', 'new-2']);
  assert.equal((f.child._components as RuntimeObject[])[0]!.uuid, 'label');
  assert.equal((result.completed as JsonObject[])[0]!.nodeId, 'new-1');
  const command = (f.manager._commandArray as RuntimeObject[])[0]!;
  assert.equal((command.undoData as Map<string, unknown>).get('new-1'), null);
  assert.equal((command.undoData as Map<string, unknown>).get('new-2'), null);
  assert.deepEqual((command.undoData as Map<string, unknown>).get('child'), { uuid: 'child' });
});

test('Creator 3 structure failures retain completed and pending steps without replaying mutations', async () => {
  const f = new ExecutionHarness(); f.failAt = 2;
  await assert.rejects(f.executor.apply(f.params()), (error: any) => {
    assert.equal(error.code, 'OUTCOME_UNKNOWN'); assert.equal(error.details.completed.length, 1);
    assert.equal(error.details.pending.length, 1); assert.equal(error.details.completed[0].nodeId, 'new-1'); return true;
  });
  assert.equal(f.writes, 2); assert.equal(f.snapshots, 1); assert.equal((f.root.children as unknown[]).length, 2);
});

test('Creator 3 Prefab asset execution rechecks asset identity and uses the native batch undo manager', async () => {
  const f = new ExecutionHarness(); f.mode = 'prefab'; let assetUuid = 'asset-a';
  f.root._prefab = { root: f.root, asset: { uuid: 'asset-a' } };
  f.facade.getCurrentFacade = () => ({ _undoMgr: f.manager, _sceneProxy: {
    getRootNode: () => f.root, queryCurrentSceneUuid: () => assetUuid,
  } });
  const rows = [{ action: 'create', key: 'new', parent: 'root', name: 'New' }];
  const plan = new Creator3UiStructure(f.inspector, f.facade).plan({ rootId: 'root', rows });
  assetUuid = 'asset-b';
  await assert.rejects(f.executor.apply({ rootId: 'root', rows, planHash: plan.planHash! }), { code: 'OPERATION_CONFLICT' });
  assert.equal(f.writes, 0);
  assetUuid = 'asset-a';
  const result = await f.executor.apply({ rootId: 'root', rows, planHash: plan.planHash! });
  assert.equal(result.verifiedStructure, true); assert.equal(f.snapshots, 1);
  assert.equal((f.manager._commandArray as unknown[]).length, 1);
});

test('Creator 3 execution reports checkpoint failure and detects undeclared component identity replacement', async () => {
  const f = new ExecutionHarness(); f.failSnapshot = true;
  await assert.rejects(f.executor.apply(f.params()), { code: 'OUTCOME_UNKNOWN' }); assert.equal(f.snapshots, 1);
  const g = new ExecutionHarness(); g.rewriteComponent = true;
  await assert.rejects(g.executor.apply(g.params()), (error: any) => {
    assert.equal(error.code, 'OUTCOME_UNKNOWN'); assert.match(error.details.cause.message, /component UUID/); return true;
  });
  assert.equal(g.writes, 2); assert.equal(g.snapshots, 1);
});

test('Creator 3 planning and readback ignore dynamic editor-only gizmos without weakening business-node checks', async () => {
  const f = new ExecutionHarness();
  const initial = f.params();
  (f.root.children as RuntimeObject[]).unshift({ uuid: 'editor-existing', name: 'Internal', _objFlags: 8, parent: f.root, children: [], _components: [] });
  assert.equal(f.params().planHash, initial.planHash);
  f.addEditorNode = true;
  const result = await f.executor.apply(initial);
  assert.equal(result.verifiedStructure, true);
  assert.deepEqual(f.inspector.all().map(node => node.uuid), ['root', 'new-1', 'child', 'new-2']);
  assert.equal(f.snapshots, 1);
});

test('Creator 3 manual undo rejects busy recorders before writes and detects interleaved history', async () => {
  const f = new ExecutionHarness(); (f.manager._autoCommands as unknown[]).push({ id: 'user-edit' });
  await assert.rejects(f.executor.apply(f.params()), { code: 'RESOURCE_BUSY' });
  assert.equal(f.writes, 0); assert.equal(f.snapshots, 0);
  const g = new ExecutionHarness(); g.interleaveHistory = true;
  await assert.rejects(g.executor.apply(g.params()), (error: any) => {
    assert.equal(error.code, 'OUTCOME_UNKNOWN'); assert.match(error.details.cause.message, /interleaved/); return true;
  });
  assert.equal(g.writes, 2); assert.equal(g.snapshots, 1);
  assert.equal((g.manager._commandArray as unknown[]).length, 2);
});

test('Creator 3 execution treats swallowed native component construction errors as a pending failed step', async () => {
  const f = new ExecutionHarness();
  const rows = [{ action: 'create', key: 'new', parent: 'root', name: 'CreatedBeforeFailure' }, { action: 'add_component', node: 'new', type: 'cc.UITransform' }];
  const plan = f.plan(rows);
  await assert.rejects(f.executor.apply({ rootId: 'root', rows, planHash: plan.planHash! }), (error: any) => {
    assert.equal(error.code, 'OUTCOME_UNKNOWN'); assert.equal(error.details.completed.length, 1);
    assert.equal(error.details.pending.length, 1); assert.equal(error.details.pending[0].action, 'add_component');
    assert.match(error.details.cause.message, /requested instance/); return true;
  });
  assert.equal(f.snapshots, 1); assert.equal(f.writes, 2);
});

test('Creator 3 public structure apply uses the native scene port and rejects other versions', async () => {
  const f = new ExecutionHarness(), calls: string[] = [];
  const port = { version: '3.8.8', scene: async (method: string, params: JsonObject) => { calls.push(method); return f.executor.apply(params); },
    request: async () => { throw new Error('Unexpected generic editor message'); } } as unknown as EditorPort;
  const adapter = new Creator3Adapter(port);
  assert.ok(adapter.supportedCapabilities().includes('ui.structure.apply'));
  const result = await adapter.execute('ui.structure.apply', f.params()) as JsonObject;
  assert.equal(result.verifiedStructure, true); assert.deepEqual(calls, ['ui.structure.apply']);
  port.version = '3.7.0';
  assert.ok(!adapter.supportedCapabilities().includes('ui.structure.apply'));
  await assert.rejects(adapter.execute('ui.structure.apply', {}), { code: 'UNSUPPORTED_VERSION' });
  assert.equal(calls.length, 1);
});
