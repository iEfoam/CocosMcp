import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EditorBridge } from '../packages/editor-bridge/src/index.js';
import { CocosError, Json, type BridgeDescriptor, type BridgeRequest, type EditorAdapter, type JsonObject, type JsonValue } from '../packages/contracts/src/index.js';
import { TestWorkspace } from './workspace.js';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PreviewRefresh } from '../extensions/shared/preview-refresh.js';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { BridgeClient } from '../packages/application/src/bridge-client.js';

class RecoveryAdapter implements EditorAdapter {
  readonly major = 3;
  writes = 0;
  reads = 0;
  failRevision = false;
  executionError?: CocosError;
  supportedCapabilities(): string[] { return ['node.create']; }
  async execute(_id: string, _params: JsonObject): Promise<JsonValue> { if (this.executionError) throw this.executionError; this.writes++; return { nodeId: 'created' }; }
  async revision(): Promise<string> { if (++this.reads === 2 && this.failRevision) throw new Error('revision unavailable'); return 'revision'; }
  async dispose(): Promise<void> {}
}

class RecoveryFixture {
  readonly adapter = new RecoveryAdapter();
  async setup(): Promise<{ bridge: EditorBridge; internal: { descriptor: BridgeDescriptor; perform(request: BridgeRequest): Promise<JsonValue>; writeLedger(path: string, row: JsonObject): void }; request: BridgeRequest }> {
    const root = await new TestWorkspace().create('bridge-recovery-');
    const bridge = new EditorBridge(this.adapter, root, '3.8.8');
    // 直接驱动认证后的执行阶段；不启动监听，不修改生产适配器。
    const internal = bridge as unknown as { descriptor: BridgeDescriptor; perform(request: BridgeRequest): Promise<JsonValue>; writeLedger(path: string, row: JsonObject): void };
    internal.descriptor = { protocolVersion: 1, projectId: 'p', instanceId: 'i', projectPath: root, creatorMajor: 3, editorVersion: '3.8.8', endpoint: '', token: '', pid: process.pid, startedAt: new Date().toISOString() };
    return { bridge, internal, request: { protocolVersion: 1, projectId: 'p', instanceId: 'i', operationId: 'write', capabilityId: 'node.create', params: { name: 'Created' } } };
  }
}

class BridgeWire {
  constructor(private readonly bridge: EditorBridge) {}
  async call(body: BridgeRequest, authenticated = true): Promise<JsonObject> {
    const request = Object.assign(new EventEmitter(), { headers: { authorization: authenticated ? 'Bearer ' : 'invalid' }, method: 'POST', url: '/rpc' });
    let result: JsonObject = {};
    const response = { destroyed: false, writeHead() {}, end(value: string) { result = Json.object(JSON.parse(value)); } };
    const handling = (this.bridge as unknown as { handle(request: IncomingMessage, response: ServerResponse): Promise<void> })
      .handle(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    request.emit('data', Buffer.from(JSON.stringify(body))); request.emit('end');
    await handling; return result;
  }
  async bounded<T>(task: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Control request blocked by mutation')), 500); })]); }
    finally { clearTimeout(timer); }
  }
}

test('successful read ledgers retain identity without large results and never permit same-ID writes', async () => {
  const fixture = new RecoveryFixture(), { internal, request } = await fixture.setup();
  let calls = 0;
  fixture.adapter.supportedCapabilities = () => ['node.query', 'node.create'];
  fixture.adapter.execute = async () => ({ node: { sequence: ++calls, payload: 'x'.repeat(1024 * 1024) } });
  const query = { ...request, operationId: 'read-large', capabilityId: 'node.query', params: { nodeId: 'root' } };
  await internal.perform(query);
  const directory = join(internal.descriptor.projectPath, '.codex-work/cache/cocos-mcp/operations/i');
  const names = await readdir(directory); assert.equal(names.length, 1);
  const path = join(directory, names[0]!); const bytes = await readFile(path);
  assert.ok(bytes.length < 256); const record = JSON.parse(bytes.toString());
  assert.equal(record.resultRetention, 'not-retained-read'); assert.equal(record.result, undefined); assert.equal(record.revision, undefined);
  const second = Json.object(await internal.perform(query));
  assert.equal(Json.object(Json.object(second.result).node).sequence, 2);
  await assert.rejects(internal.perform({ ...query, params: { nodeId: 'other' } }), { code: 'OPERATION_CONFLICT' });
  await assert.rejects(internal.perform({ ...request, operationId: query.operationId }), { code: 'OPERATION_CONFLICT' });
  assert.equal(calls, 2);
  // 旧版完整读记录仍然原位重放，不能在升级后悄悄改写历史内容。
  const legacy = JSON.stringify({ ...record, resultRetention: undefined, result: { node: { sequence: 99 } }, revision: 'old' });
  await writeFile(path, legacy);
  const replay = Json.object(await internal.perform(query));
  assert.equal(Json.object(Json.object(replay.result).node).sequence, 99); assert.equal(calls, 2);
  assert.equal(await readFile(path, 'utf8'), legacy);
});

class LocalWireClient extends BridgeClient {
  constructor(private readonly wire: BridgeWire) { super(); }
  override async call(_descriptor: BridgeDescriptor, request: BridgeRequest): Promise<{ result: JsonValue; revision: string }> {
    const response = await this.wire.call(request);
    if (response.error) { const error = Json.object(response.error); throw new CocosError(error.code as CocosError['code'], String(error.message), error.details); }
    return { result: response.result!, revision: String(response.revision ?? '') };
  }
}

test('application and bridge allow refresh cancellation during a blocked write without rolling back native import', async () => {
  const fixture = new RecoveryFixture(), { bridge, internal } = await fixture.setup(), wire = new BridgeWire(bridge);
  const root = internal.descriptor.projectPath, projects = new ProjectRegistry(), { projectId } = await projects.add(root);
  internal.descriptor.projectId = projectId; projects.instance = async () => internal.descriptor;
  const app = new CocosApplication(projects, undefined, new LocalWireClient(wire));
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets/fixture.ts'), 'export {};');
  let releaseWrite!: () => void, enterWrite!: () => void, releaseImport!: () => void, enterImport!: () => void;
  const writeStarted = new Promise<void>(resolve => { enterWrite = resolve; }), importStarted = new Promise<void>(resolve => { enterImport = resolve; });
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; }), importGate = new Promise<void>(resolve => { releaseImport = resolve; });
  let imported = 0, compiled = 0, nodeCalls = 0;
  const refresh = new PreviewRefresh({ projectPath: root, importResource: async () => { enterImport(); await importGate; imported++; }, compile: async () => { compiled++; return {}; } });
  fixture.adapter.supportedCapabilities = () => ['node.create', 'preview.refresh', 'preview.refresh.status', 'preview.refresh.cancel', 'console.query'];
  fixture.adapter.execute = async (id, params) => {
    if (id.startsWith('preview.')) return refresh.execute(id.slice(8), params);
    if (id === 'console.query') return { rows: [], nextCursor: 0 };
    nodeCalls++; if (nodeCalls === 1) { enterWrite(); await writeGate; } return { nodeId: 'created' };
  };
  const started = await app.execute({ projectId, capabilityId: 'preview.refresh', params: { urls: ['db://assets/fixture.ts'], reload: false } });
  await importStarted; const operationId = Json.object(started.result).operationId!;
  const first = app.execute({ projectId, capabilityId: 'node.create', params: { name: 'First' } });
  let second: ReturnType<CocosApplication['execute']> | undefined;
  let bridgeQueued: Promise<JsonObject> | undefined;
  try {
    await writeStarted;
    second = app.execute({ projectId, capabilityId: 'node.create', params: { name: 'Second' } });
    bridgeQueued = wire.call({ protocolVersion: 1, projectId, instanceId: 'i', operationId: 'direct-write', capabilityId: 'node.create', params: { name: 'Direct' } });
    const controlRequest: BridgeRequest = { protocolVersion: 1, projectId, instanceId: 'i', operationId: 'control', capabilityId: 'preview.refresh.cancel', params: { operationId } };
    assert.equal(Json.object((await wire.bounded(wire.call(controlRequest, false))).error).code, 'UNAUTHORIZED');
    assert.equal(Json.object(await refresh.execute('refresh.status', { operationId })).status, 'pending');
    assert.equal(Json.object((await wire.bounded(wire.call({ ...controlRequest, capabilityId: 'bridge.identity', params: { includeLoginState: false } }))).result).instanceId, 'i');
    const cancel = await wire.bounded(app.execute({ projectId, capabilityId: 'preview.refresh.cancel', params: { operationId } }));
    assert.equal(Json.object(cancel.result).status, 'cancelled'); assert.equal(Json.object(cancel.result).nativePending, true);
    assert.match(String(Json.object(cancel.result).reason), /in-flight native import may still finish/);
    await wire.bounded(app.execute({ projectId, capabilityId: 'console.query', params: {} }));
    const status = await wire.bounded(app.execute({ projectId, capabilityId: 'preview.refresh.status', params: { operationId } }));
    assert.equal(Json.object(status.result).nativePending, true); assert.equal(nodeCalls, 1); assert.equal(imported, 0);
    // 按验收场景将写操作保持五秒；第二个写入在整个窗口内仍不得进入原生执行。
    await new Promise(resolve => setTimeout(resolve, 5000)); assert.equal(nodeCalls, 1);
  } finally { releaseImport(); releaseWrite(); await first; if (second) await second; if (bridgeQueued) await bridgeQueued; }
  for (let attempt = 0; attempt < 50 && Json.object(await refresh.execute('refresh.status', { operationId })).nativePending; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(imported, 1); assert.equal(compiled, 0); assert.equal(nodeCalls, 3);
  assert.equal(Json.object(await refresh.execute('refresh.status', { operationId })).nativePending, false);
  refresh.dispose();
});

test('post-mutation output contract failure remains unknown and cannot replay the write', async () => {
  const fixture = new RecoveryFixture(), { internal, request } = await fixture.setup();
  fixture.adapter.supportedCapabilities = () => ['ui.apply'];
  fixture.adapter.execute = async () => { fixture.adapter.writes++; return { rootId: 'root', rows: [], needsSave: 'true' }; };
  const mutation = { ...request, capabilityId: 'ui.apply' };
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(internal.perform(mutation), (error: unknown) => {
    assert.ok(error instanceof CocosError); assert.equal(error.code, 'OUTCOME_UNKNOWN');
    const details = Json.object(error.details);
    assert.equal(Json.object(details.cause).code, 'VERIFICATION_FAILED');
    assert.equal(Json.object(details.confirmedResult).needsSave, 'true');
    return true;
  });
  assert.equal(fixture.adapter.writes, 1);
});

test('bridge control queries remain authenticated and available during a pending mutation', async () => {
  const fixture = new RecoveryFixture(), { bridge, request } = await fixture.setup(), wire = new BridgeWire(bridge);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  fixture.adapter.execute = async () => { fixture.adapter.writes++; entered(); await gate; return { nodeId: 'created' }; };
  const mutation = wire.call(request);
  try {
    await started;
    const identity = { ...request, capabilityId: 'bridge.identity', params: { includeLoginState: false } };
    assert.equal(Json.object((await wire.bounded(wire.call(identity))).result).instanceId, 'i');
    assert.equal(Json.object((await wire.bounded(wire.call(identity, false))).error).code, 'UNAUTHORIZED');
    const ledger = await wire.bounded(wire.call({ ...request, capabilityId: 'bridge.operation', params: { operationId: 'write' } }));
    assert.equal(Json.object(ledger.result).status, 'pending');
    assert.equal(fixture.adapter.reads, 1);
    const invalid = await wire.bounded(wire.call({ ...identity, instanceId: 'another-instance' }));
    assert.equal(Json.object(invalid.error).code, 'UNAUTHORIZED');
  } finally { release(); await mutation; }
  assert.equal(fixture.adapter.writes, 1);
});

test('bridge preserves unknown post-write revision failures and replays details without a second mutation', async () => {
  const fixture = new RecoveryFixture(), { internal, request } = await fixture.setup();
  fixture.adapter.failRevision = true;
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(internal.perform(request), (error: unknown) => {
    assert.ok(error instanceof CocosError); assert.equal(error.code, 'OUTCOME_UNKNOWN');
    assert.equal(Json.object(error.details).stage, 'post-execution');
    assert.deepEqual(Json.object(error.details).confirmedResult, { nodeId: 'created' }); return true;
  });
  assert.equal(fixture.adapter.writes, 1);
});

test('bridge preserves pending protection when completed and recovery ledger writes fail', async () => {
  const fixture = new RecoveryFixture(), { internal, request } = await fixture.setup();
  const original = internal.writeLedger.bind(internal);
  internal.writeLedger = (path, row) => { if (row.status !== 'pending') throw new Error('disk failure'); original(path, row); };
  await assert.rejects(internal.perform(request), (error: unknown) => {
    assert.ok(error instanceof CocosError); assert.equal(error.code, 'OUTCOME_UNKNOWN');
    assert.deepEqual(Json.object(error.details).auditWarnings, ['AUDIT_WRITE_FAILED']); return true;
  });
  await assert.rejects(internal.perform(request), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(fixture.adapter.writes, 1);
});

test('bridge returns separate native, revision, validation and ledger timing without replaying completed operations', async () => {
  const fixture = new RecoveryFixture(), { internal, request } = await fixture.setup();
  const response = Json.object(await internal.perform(request));
  const timings = response.timings as JsonObject[];
  assert.deepEqual(timings.map(row => row.stage), ['revision-before', 'ledger-intent', 'native-execution', 'output-validation', 'revision-after', 'ledger-complete']);
  assert.ok(timings.every(row => Number(row.durationMs) >= 0 && row.calls === 1));
  await internal.perform(request); assert.equal(fixture.adapter.writes, 1);
});

test('bridge retains known rejection details for repeated operation IDs', async () => {
  const fixture = new RecoveryFixture(), { internal, request } = await fixture.setup();
  fixture.adapter.executionError = new CocosError('STALE_REVISION', 'changed', { actualRevision: 'new' });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(internal.perform(request), (error: unknown) => {
    assert.ok(error instanceof CocosError); assert.equal(error.code, 'STALE_REVISION');
    assert.deepEqual(error.details, { actualRevision: 'new' }); return true;
  });
  assert.equal(fixture.adapter.writes, 0);
});
