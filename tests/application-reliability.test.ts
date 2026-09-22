import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationStore } from '../packages/application/src/operation-store.js';
import { ProjectQueue } from '../packages/application/src/queue.js';
import { AtomicJson } from '../packages/application/src/atomic-json.js';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { CocosError, Json, type ExecutionResult } from '../packages/contracts/src/index.js';

class Deferred<T> {
  resolve!: (value: T) => void;
  reject!: (reason: unknown) => void;
  readonly promise = new Promise<T>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
}

const result: ExecutionResult = { operationId: 'op', projectId: 'project', capabilityId: 'runtime.query', result: {}, verification: 'unverified', completedAt: '2026-09-22T00:00:00Z' };

test('operation retention bounds failed records, protects unknowns, and expires confirmed results', async () => {
  let clock = 0, calls = 0;
  const store = new OperationStore(3, 100, () => clock);
  for (let i = 0; i < 10; i++) await assert.rejects(store.run(String(i), '{}', async () => { throw new CocosError('EDITOR_ERROR', 'failed'); }));
  assert.equal(store.size, 3);
  const task = async () => { calls++; return result; };
  await store.run('ok', '{}', task); await store.run('ok', '{}', task); assert.equal(calls, 1);
  await assert.rejects(store.run('ok', 'different', task), { code: 'OPERATION_CONFLICT' });
  await assert.rejects(store.run('unknown', '{}', async () => { throw new CocosError('OUTCOME_UNKNOWN', 'interrupted'); }));
  clock = 101; assert.equal(store.size, 1);
  await assert.rejects(store.run('unknown', '{}', task), { code: 'OUTCOME_UNKNOWN' }); assert.equal(calls, 1);
  store.settle('unknown', result); assert.equal(await store.run('unknown', '{}', task), result); assert.equal(calls, 1);
  clock = 202; assert.equal(store.size, 0);
});

test('in-flight duplicates share execution; a full protected store rejects new work', async () => {
  const store = new OperationStore(1), deferred = new Deferred<ExecutionResult>(); let calls = 0;
  const first = store.run('one', '{}', () => { calls++; return deferred.promise; });
  const duplicate = store.run('one', '{}', async () => result);
  assert.equal(first, duplicate);
  await assert.rejects(store.run('two', '{}', async () => result), { code: 'RESOURCE_BUSY' });
  deferred.resolve(result); await first; assert.equal(calls, 1);
});

test('queued cancellation is immediate, releases capacity, and never executes cancelled work', async () => {
  const queue = new ProjectQueue(1, 1000), gate = new Deferred<number>(), controller = new AbortController(); let cancelledCalls = 0;
  const running = queue.run('p', () => gate.promise);
  const waiting = queue.run('p', async () => ++cancelledCalls, controller.signal);
  const rejected = assert.rejects(waiting, { code: 'CANCELLED' });
  await assert.rejects(queue.run('p', async () => 9), { code: 'RESOURCE_BUSY' });
  controller.abort(); await rejected;
  const next = queue.run('p', async () => 3);
  assert.equal(await queue.run('other', async () => 2), 2);
  gate.resolve(1); assert.deepEqual(await Promise.all([running, next]), [1, 3]); assert.equal(cancelledCalls, 0);
});

test('queue deadline expires only waiting work and failure releases the next task', async () => {
  const queue = new ProjectQueue(2, 15), gate = new Deferred<number>();
  const running = queue.run('p', () => gate.promise); let calls = 0;
  await assert.rejects(queue.run('p', async () => ++calls), { code: 'TIMEOUT' });
  const failed = assert.rejects(running, /head failed/);
  const next = queue.run('p', async () => 8);
  gate.reject(new Error('head failed')); await failed; assert.equal(await next, 8); assert.equal(calls, 0);
});

test('workflow JSON publication is atomic and exclusive creation preserves the existing record', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.codex-work/tmp/workflow-atomic-'));
  const path = join(directory, 'workflow.json'), files = new AtomicJson();
  await files.write(path, { index: 0 }, true);
  await assert.rejects(files.write(path, { index: -1 }, true), { code: 'OPERATION_CONFLICT' });
  const writes = (async () => { for (let index = 1; index <= 25; index++) await files.write(path, { index, payload: 'x'.repeat(20000) }); })();
  for (let i = 0; i < 50; i++) assert.equal(typeof JSON.parse(await readFile(path, 'utf8')).index, 'number');
  await writes; assert.equal(JSON.parse(await readFile(path, 'utf8')).index, 25);
  assert.deepEqual(await readdir(directory), ['workflow.json']);
});

test('checkpoint failure after a successful step stops even continueOnError workflows without replay', async () => {
  const root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/workflow-checkpoint-'));
  const registry = new ProjectRegistry(), project = await registry.add(root); let calls = 0;
  const app = new CocosApplication(registry, undefined, undefined, false, { execute: async () => {
    calls++;
    const checkpoint = join(root, '.codex-work/cache/cocos-mcp/workflows/checkpoint.json');
    await unlink(checkpoint); await mkdir(checkpoint);
    return { rows: [] };
  } });
  await assert.rejects(app.executeWorkflow(project.projectId, [
    { capabilityId: 'runtime.query', params: {} }, { capabilityId: 'runtime.query', params: {} },
  ], undefined, true, 'checkpoint'), error => {
    assert.ok(error instanceof CocosError); assert.equal(error.code, 'OUTCOME_UNKNOWN');
    const rows = Json.object(error.details).rows as unknown[]; assert.equal(rows.length, 1);
    assert.equal((rows[0] as { status: string }).status, 'succeeded'); return true;
  });
  assert.equal(calls, 1);
});

test('confirmed editor success survives audit failure and is not dispatched twice', async t => {
  const { BridgeClient } = await import('../packages/application/src/bridge-client.js');
  const root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/audit-failure-'));
  const registry = new ProjectRegistry(), { projectId } = await registry.add(root), bridge = new BridgeClient();
  t.mock.method(registry, 'instance', async () => ({ protocolVersion: 1, projectId, projectPath: root, instanceId: 'editor', editorVersion: '3.8.8', creatorMajor: 3, endpoint: '', token: '', pid: process.pid, startedAt: '' }));
  const call = t.mock.method(bridge, 'call', async () => ({ result: { saved: true }, revision: 'revision' }));
  await mkdir(join(root, '.codex-work/logs/cocos-mcp/operations.jsonl'), { recursive: true });
  const app = new CocosApplication(registry, undefined, bridge);
  const request = { projectId, capabilityId: 'scene.query', params: {}, operationId: 'audit' };
  const first = await app.execute(request);
  assert.equal(first.warnings?.[0]?.code, 'AUDIT_WRITE_FAILED');
  assert.equal(await app.execute(request), first); assert.equal(call.mock.callCount(), 1);
});

test('unknown editor outcome is reconciled against its original instance without executing again', async t => {
  const { BridgeClient } = await import('../packages/application/src/bridge-client.js');
  const root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/reconcile-'));
  const registry = new ProjectRegistry(), { projectId } = await registry.add(root), bridge = new BridgeClient();
  const selected: Array<string | undefined> = [];
  t.mock.method(registry, 'instance', async (_project: string, instance?: string) => {
    selected.push(instance);
    return { protocolVersion: 1, projectId, projectPath: root, instanceId: 'original', editorVersion: '3.8.8', creatorMajor: 3, endpoint: '', token: '', pid: process.pid, startedAt: '' };
  });
  let writes = 0, mismatched = true;
  const fingerprint = createHash('sha256').update(Json.canonical({ capabilityId: 'scene.query', params: {}, expectedRevision: null })).digest('hex');
  t.mock.method(bridge, 'call', async (_descriptor: unknown, request: { capabilityId: string }) => {
    if (request.capabilityId === 'bridge.operation') return { result: { fingerprint: mismatched ? 'foreign-operation' : fingerprint, status: 'completed', result: { saved: true }, revision: 'revision' }, revision: 'revision' };
    writes++; throw new CocosError('OUTCOME_UNKNOWN', 'interrupted');
  });
  const app = new CocosApplication(registry, undefined, bridge), request = { projectId, capabilityId: 'scene.query', params: {}, operationId: 'recover' };
  await assert.rejects(app.execute(request), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(Json.object(await app.operation(projectId, 'recover', 'another')).status, 'unknown');
  await assert.rejects(app.execute(request), { code: 'OUTCOME_UNKNOWN' });
  mismatched = false;
  assert.equal(Json.object(await app.operation(projectId, 'recover', 'another')).status, 'completed');
  assert.deepEqual((await app.execute(request)).result, { saved: true });
  assert.deepEqual(selected, [undefined, 'original', 'original']); assert.equal(writes, 1);
});

test('truncated editor JSON is an unknown outcome, never a retryable ordinary failure', async t => {
  const { BridgeClient } = await import('../packages/application/src/bridge-client.js');
  t.mock.method(globalThis, 'fetch', async () => new Response('{'));
  await assert.rejects(new BridgeClient().call({ protocolVersion: 1, projectId: 'p', projectPath: '.', instanceId: 'i', editorVersion: '3', creatorMajor: 3, endpoint: 'http://127.0.0.1', token: '', pid: 1, startedAt: '' },
    { protocolVersion: 1, projectId: 'p', instanceId: 'i', operationId: 'o', capabilityId: 'scene.query', params: {} }), { code: 'OUTCOME_UNKNOWN' });
});
