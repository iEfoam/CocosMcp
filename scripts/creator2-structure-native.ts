import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';

const project = resolve('.codex-work/build/creator2-test-project'), registry = new ProjectRegistry();
const { projectId } = await registry.add(project), app = new CocosApplication(registry);
const results: JsonObject[] = [];
const call = async (id: string, params: JsonObject = {}): Promise<JsonObject> => {
  const result = Json.object((await app.execute({ projectId, capabilityId: id, params })).result);
  results.push({ id, result }); console.log(`PASS ${id}`); return result;
};
try {
  const scene = Json.object((await call('scene.query')).scene).sceneId!;
  const root = (await call('node.create', { parentId: scene, name: `StructureCoverage-${Date.now()}` })).nodeId!;
  const preserved = (await call('node.create', { parentId: root, name: 'Preserved' })).nodeId!;
  const removed = (await call('node.create', { parentId: root, name: 'Removed' })).nodeId!;
  const untouched = (await call('node.create', { parentId: root, name: 'Untouched' })).nodeId!;
  const label = (await call('component.add', { nodeId: preserved, type: 'cc.Label' })).componentId!;
  const params = { rootId: root, rows: [
    { action: 'create', key: 'container', parent: root, name: 'Container', index: 0 },
    { action: 'move', node: preserved, parent: 'container', index: 0 },
    { action: 'add_component', node: 'container', type: 'cc.Layout' },
    { action: 'remove_component', componentId: label },
    { action: 'remove', node: removed },
  ] };
  const plan = await call('ui.structure.plan', params);
  await call('node.set', { nodeId: root, properties: { width: 321 } });
  await assert.rejects(() => call('ui.structure.apply', { ...params, planHash: plan.planHash! }), error => CocosError.from(error).code === 'STALE_REVISION');
  const fresh = await call('ui.structure.plan', params), applied = await call('ui.structure.apply', { ...params, planHash: fresh.planHash! });
  const container = (applied.rows as JsonObject[]).find(row => row.key === 'container')!.nodeId!;
  assert.deepEqual(Json.object((await call('node.query', { nodeId: root })).node).children, [container, untouched]);
  assert.equal(Json.object((await call('node.query', { nodeId: preserved })).node).parentId, container);
  await call('scene.undo');
  assert.equal(Json.object((await call('node.query', { nodeId: preserved })).node).parentId, root);
  assert.ok((await call('node.query', { nodeId: removed })).node);
  assert.ok((await call('component.query', { componentId: label })).component);
  await call('scene.redo');
  assert.equal(Json.object((await call('node.query', { nodeId: preserved })).node).parentId, container);
  await call('scene.save'); await call('scene.open', { uuid: scene });
  assert.equal(Json.object((await call('node.query', { nodeId: preserved })).node).parentId, container);
  assert.deepEqual(Json.object((await call('node.query', { nodeId: root })).node).children, [container, untouched]);
  await assert.rejects(() => call('node.query', { nodeId: removed }), error => CocosError.from(error).code === 'NOT_FOUND');
  await assert.rejects(() => call('ui.structure.plan', { rootId: root, rows: [{ action: 'move', node: untouched, parent: root, index: 99 }] }), /index/);
  await assert.rejects(() => call('ui.structure.plan', { rootId: root, rows: [{ action: 'move', node: container, parent: preserved }] }), /cycle/);
  await assert.rejects(() => call('ui.structure.plan', { rootId: root, rows: [{ action: 'remove', node: scene }] }));
  results.push({ assertions: 'UUID, stale plan, single Undo/Redo, save/reopen, cycle and root boundary', passed: true });
} catch (error) { results.push({ passed: false, error: CocosError.from(error).message }); process.exitCode = 1; console.error(error); }
finally { await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/ui-structure.json'), JSON.stringify({ project, results }, null, 2)); }
