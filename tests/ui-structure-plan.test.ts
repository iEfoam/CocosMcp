import test from 'node:test';
import assert from 'node:assert/strict';
import { UiStructurePlan, type StructureNode, type StructureReferences } from '../packages/ui-core/src/structure-plan.js';
import type { JsonObject } from '../packages/contracts/src/index.js';

class StructureFixture {
  nodes: StructureNode[] = [
    { nodeId: 'root', parentId: 'scene', name: 'Panel', children: ['a', 'b'], components: [] },
    { nodeId: 'a', parentId: 'root', name: 'A', children: [], components: [{ componentId: 'ca', type: 'cc.Label' }] },
    { nodeId: 'b', parentId: 'root', name: 'B', children: [], components: [] },
  ];
  references: StructureReferences = { complete: true, rows: [], issues: [] };
  plan(rows: JsonObject[]): JsonObject { return new UiStructurePlan().create('root', this.nodes, rows, ['cc.Label', 'cc.Button'], this.references); }
}

test('structure simulation preserves UUIDs, creates mapped keys, orders siblings and never mutates the input', () => {
  const f = new StructureFixture(), before = JSON.stringify(f.nodes);
  const plan = f.plan([{ action: 'create', parent: 'root', key: 'new', name: 'New', index: 1 },
    { action: 'move', node: 'b', parent: 'new', index: 0 }, { action: 'move', node: 'a', parent: 'root', index: 1 },
    { action: 'add_component', node: 'new', type: 'cc.Button' }]);
  const rows = plan.resultingNodes as JsonObject[];
  assert.deepEqual(rows.find(row => row.key === 'root')!.children, ['new', 'a']);
  assert.deepEqual(rows.find(row => row.key === 'new')!.children, ['b']);
  assert.equal(rows.find(row => row.key === 'new')!.nodeId, null);
  assert.equal(rows.find(row => row.key === 'b')!.nodeId, 'b');
  assert.equal(JSON.stringify(f.nodes), before); assert.equal(plan.applicable, true);
});

test('structure plans reject cycles, root changes, foreign references, duplicate identities and ambiguous names', () => {
  const f = new StructureFixture();
  for (const rows of [
    [{ action: 'move', node: 'root', parent: 'a' }], [{ action: 'remove', node: 'root' }],
    [{ action: 'move', node: 'a', parent: 'a' }], [{ action: 'remove', node: 'foreign' }],
    [{ action: 'create', key: 'ca', name: 'X', parent: 'root' }], [{ action: 'create', key: 'new', name: 'A', parent: 'root' }],
    [{ action: 'move', node: 'a', parent: 'root', index: 4 }], [{ action: 'remove_component', componentId: 'foreign' }],
    [{ action: 'remove_component', componentId: 'ca' }, { action: 'remove_component', componentId: 'ca' }],
    [{ action: 'add_component', node: 'b', type: 'missing' }],
  ]) assert.throws(() => f.plan(rows));
  f.nodes[2]!.children.push('a');
  assert.throws(() => f.plan([{ action: 'remove', node: 'b' }]), /parent\/children|cyclic/);
});

test('deletion requires complete scene references and preserves targets of surviving component events', () => {
  const f = new StructureFixture();
  f.references.rows = [{ sourceId: 'outside-component', targetId: 'ca', path: 'clickEvents[0]' }];
  const plan = f.plan([{ action: 'remove', node: 'a' }]);
  assert.equal(plan.applicable, false); assert.deepEqual(plan.deletedIds, ['a', 'ca']);
  f.references.rows = [{ sourceId: 'ca', targetId: 'a', path: 'target' }];
  assert.equal(f.plan([{ action: 'remove', node: 'a' }]).applicable, true);
  f.references.complete = false;
  assert.equal(f.plan([{ action: 'remove', node: 'a' }]).applicable, false);
  assert.equal(f.plan([{ action: 'move', node: 'a', parent: 'b' }]).applicable, true);
});

test('component dependencies and native protected modes block incompatible structural changes', () => {
  const f = new StructureFixture();
  f.nodes[1]!.components.push({ componentId: 'dependent', type: 'Custom', requires: ['cc.Label'] });
  assert.throws(() => f.plan([{ action: 'remove_component', componentId: 'ca' }]), /dependency/);
  f.nodes[2]!.protectedReason = 'prefab-instance';
  assert.throws(() => f.plan([{ action: 'create', key: 'new', name: 'N', parent: 'b' }]), /dedicated workflow/);
  assert.throws(() => f.plan([{ action: 'remove', node: 'b' }]), /dedicated workflow/);
});

test('dependency guards follow execution order and include newly added component requirements', () => {
  const f = new StructureFixture();
  f.nodes[1]!.components.push({ componentId: 'dependent', type: 'Custom', requires: ['cc.Label'] });
  assert.throws(() => f.plan([{ action: 'remove_component', componentId: 'ca' }, { action: 'add_component', node: 'a', type: 'cc.Label' }]), /dependency/);
  assert.equal(f.plan([{ action: 'remove_component', componentId: 'dependent' }, { action: 'remove_component', componentId: 'ca' }]).applicable, true);
  const definitions = new Map([['cc.Button', { requires: ['cc.Label'] }]]);
  const planner = new UiStructurePlan();
  assert.throws(() => planner.create('root', f.nodes, [
    { action: 'add_component', node: 'b', type: 'cc.Button' }, { action: 'add_component', node: 'b', type: 'cc.Label' },
  ], ['cc.Label', 'cc.Button'], f.references, definitions), /dependency/);
  assert.equal(planner.create('root', f.nodes, [
    { action: 'add_component', node: 'b', type: 'cc.Label' }, { action: 'add_component', node: 'b', type: 'cc.Button' },
  ], ['cc.Label', 'cc.Button'], f.references, definitions).applicable, true);
  f.nodes[2]!.components.push({ componentId: 'subclass', type: 'CustomLabel', satisfies: ['cc.Label'] });
  assert.equal(planner.create('root', f.nodes, [{ action: 'add_component', node: 'b', type: 'cc.Button' }], ['cc.Button'], f.references, definitions).applicable, true);
});

test('preexisting duplicate siblings remain addressable by UUID while new ambiguity is rejected', () => {
  const f = new StructureFixture(); f.nodes[2]!.name = 'A';
  assert.equal(f.plan([{ action: 'create', key: 'new', parent: 'root', name: 'Different' }]).applicable, true);
  assert.equal(f.plan([{ action: 'move', node: 'b', parent: 'root', index: 0 }]).applicable, true);
  assert.throws(() => f.plan([{ action: 'create', key: 'new', parent: 'root', name: 'A' }]), /ambiguous/);
});
