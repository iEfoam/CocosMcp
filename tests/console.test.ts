import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CreatorConsole } from '../extensions/creator3/src/console.js';
import { CreatorSelection } from '../extensions/creator3/src/selection.js';
import { Creator3Adapter } from '../packages/creator3-adapter/src/index.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';
import { EditorBridge } from '../packages/editor-bridge/src/index.js';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';

test('console queries retain native level, process, stack and UTC time while paging filtered rows', async () => {
  const logs = [
    { type: 'log', message: 'Editor started', time: 0 },
    { type: 'error', message: 'Unknown material value type', process: 'Scene', stack: 'Error\n  at MaterialValues.value', time: '2026-09-14T12:00:00+08:00' },
    { type: 'warn', message: 'You are trying to destroy a object twice or more.', process: 'Scene', stack: ['at MiniPreview.clearByComponent'], time: '2026-09-14 12:00:00' },
  ];
  const reader = new CreatorConsole({ query: () => logs });
  const first = await reader.query({ process: 'Scene', limit: 1 });
  const row = (first.rows as JsonObject[])[0]!;
  assert.equal(row.level, 'error');
  assert.equal(row.occurredAt, '2026-09-14T04:00:00.000Z');
  assert.match(String(row.stack), /MaterialValues/);
  assert.equal(first.hasMore, true);
  const second = await reader.query({ cursor: first.nextCursor!, process: 'Scene', limit: 1 });
  assert.equal((second.rows as JsonObject[])[0]!.level, 'warn');
  assert.equal((second.rows as JsonObject[])[0]!.occurredAt, null);
  assert.equal(second.hasMore, false);
  const byStack = await reader.query({ contains: 'minipreview', level: 'warn' });
  assert.equal((byStack.rows as JsonObject[]).length, 1);
  assert.equal((await reader.query({ level: 'info' })).retained, 3);
  logs.length = 0;
  logs.push({ type: 'error', message: 'new after clear', time: 1 });
  const afterClear = await reader.query({ cursor: second.nextCursor! });
  assert.equal((afterClear.rows as JsonObject[])[0]!.message, 'new after clear');
});

test('console rejects incompatible APIs and bounds responses', async () => {
  await assert.rejects(new CreatorConsole({ query: () => ({ rows: [] }) }).query({}), /unsupported log format/);
  const reader = new CreatorConsole({ query: () => Array.from({ length: 5001 }, () => ({ type: 'info', message: 'x'.repeat(17000) })) });
  const result = await reader.query({ limit: 1 });
  assert.equal(result.retained, 5000);
  assert.equal(result.truncated, true);
  assert.equal(String((result.rows as JsonObject[])[0]!.message).length, 16384);
  await assert.rejects(reader.query({ limit: 501 }), /1\.\.500/);
  await assert.rejects(reader.query({ cursor: -1 }), /non-negative/);
  await assert.rejects(reader.query({ level: 'fatal' }), /Unknown console level/);
});

test('console capability is read-only and only advertised by an available verified native host', () => {
  const catalog = new CapabilityCatalog();
  assert.equal(catalog.validate('console.query', { level: 'error', limit: 20 }).effect, 'read');
  assert.throws(() => catalog.validate('console.query', { limit: 501 }));
  const host = { version: '3.8.8', consoleAvailable: true, consoleQuery: async () => ({ rows: [] }) } as unknown as EditorPort;
  assert.equal(new Creator3Adapter(host).supportedCapabilities().includes('console.query'), true);
  assert.equal(new Creator3Adapter({ ...host, version: '3.7.4' }).supportedCapabilities().includes('console.query'), false);
  assert.equal(new Creator3Adapter({ ...host, consoleAvailable: false }).supportedCapabilities().includes('console.query'), false);
});

test('authenticated console reads work when scene revision is broken and never echo queries into logs', async () => {
  const root = await mkdtemp(resolve('.codex-work/tmp/console-query-'));
  const reader = new CreatorConsole({ query: () => [{ type: 'error', message: 'Scene compilation failed', process: 'Scene' }] });
  const bridge = new EditorBridge({ major: 3, supportedCapabilities: () => ['console.query'], dispose: async () => {},
    revision: async () => { throw new Error('Scene unavailable'); }, execute: async (_id, p) => reader.query(p) }, root, '3.8.8');
  try {
    const descriptor = await bridge.start();
    const count = bridge.panelState().logs.length;
    const response = await fetch(descriptor.endpoint, { method: 'POST', headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, projectId: descriptor.projectId, instanceId: descriptor.instanceId, operationId: 'console-read', capabilityId: 'console.query', params: { level: 'error' } }) });
    assert.equal(response.status, 200);
    const body = Json.object(await response.json());
    assert.match(JSON.stringify(body), /Scene compilation failed/);
    assert.equal(bridge.panelState().logs.length, count);
  } finally { await bridge.stop(); }
});

test('identical camera selection and repeated clearing do not repeat native preview lifecycle events', () => {
  let current = ['camera'];
  const calls: string[] = [];
  const selection = new CreatorSelection({ getSelected: () => current, clear: () => { calls.push('clear'); current = []; }, select: (_type, ids) => { calls.push('select'); current = ids; } });
  selection.update('node', ['camera', 'camera']);
  assert.deepEqual(calls, []);
  selection.update('node', ['other']);
  assert.deepEqual(calls, ['clear', 'select']);
  selection.update('node', []);
  selection.update('node', []);
  assert.deepEqual(calls, ['clear', 'select', 'clear']);
});
