import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { AuditLog } from '../packages/application/src/audit-log.js';
import { OperationAudit } from '../packages/application/src/operation-audit.js';
import { ProjectPaths } from '../packages/application/src/paths.js';
import { TestWorkspace } from './workspace.js';
import type { JsonObject } from '../packages/contracts/src/index.js';

test('segmented audit preserves legacy pagination and byte cursors across rotations', async () => {
  const root = await new TestWorkspace().create('audit-segments-'), paths = await ProjectPaths.open(root);
  const folder = await paths.work('logs', 'cocos-mcp'), legacy = join(folder, 'operations.jsonl');
  const content = JSON.stringify({ operationId: 'old', startedAt: '2026-10-01T00:00:00Z' }) + '\n';
  await writeFile(legacy, content);
  const writer = new AuditLog(180);
  await Promise.all(Array.from({ length: 12 }, (_, i) => writer.append(paths, { operationId: `new-${i}`, startedAt: '2026-10-02T00:00:00Z', label: '中文' })));
  assert.ok((await readdir(join(folder, 'operations'))).length > 1);
  const audit = new OperationAudit(), ids: string[] = [];
  let pageCursor: string | undefined;
  do {
    const page = await audit.rows(paths, { limit: 2, ...(pageCursor ? { pageCursor } : {}) });
    ids.push(...(page.rows as JsonObject[]).map(row => String(row.operationId)));
    pageCursor = page.nextPageCursor as string | undefined;
  } while (pageCursor);
  assert.deepEqual(ids, ['old', ...Array.from({ length: 12 }, (_, i) => `new-${i}`)]);
  const page = await audit.rows(paths, { cursor: 11, limit: 2 });
  assert.deepEqual((page.rows as JsonObject[]).map(row => row.operationId), ['new-10', 'new-11']);
  assert.equal(await readFile(legacy, 'utf8'), content);
});

test('byte cursors skip earlier data and reject replaced segments and invalid boundaries', async () => {
  const root = await new TestWorkspace().create('audit-cursors-'), paths = await ProjectPaths.open(root), audit = new OperationAudit();
  for (let i = 0; i < 3; i++) assert.equal(await audit.record(paths, { operationId: String(i), startedAt: '2026-10-01T00:00:00Z' }), true);
  const first = await audit.rows(paths, { limit: 1 }), writer = new AuditLog(), position = writer.decode(first.nextPageCursor);
  assert.ok(position.offset > 0); assert.equal(position.index, 1);
  await assert.rejects(audit.rows(paths, { pageCursor: writer.encode({ ...position, offset: position.offset + 1 }) }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(audit.rows(paths, { pageCursor: first.nextPageCursor!, cursor: 0 }), { code: 'INVALID_ARGUMENT' });
  const file = join(root, '.codex-work/logs/cocos-mcp/operations', position.segment);
  await rename(file, file + '.preserved'); await writeFile(file, await readFile(file + '.preserved'));
  await assert.rejects(audit.rows(paths, { pageCursor: first.nextPageCursor! }), { code: 'STALE_REVISION' });
  await assert.rejects(audit.rows(paths, { pageCursor: writer.encode({ ...position, segment: '../escape' }) }), { code: 'INVALID_ARGUMENT' });
});

test('audit rejects oversized metadata without affecting durable recovery protection', async () => {
  const root = await new TestWorkspace().create('audit-budget-'), paths = await ProjectPaths.open(root), audit = new OperationAudit();
  await audit.reserve(paths, 'guarded', 'fingerprint', { capabilityId: 'scene.save' });
  assert.equal(await audit.record(paths, { payload: 'x'.repeat(65536) }), false);
  await assert.rejects(audit.reserve(paths, 'guarded', 'fingerprint', {}), { code: 'OUTCOME_UNKNOWN' });
  assert.equal((await audit.rows(paths, {})).nextPageCursor, null);
});

test('audit rotates at UTC midnight and preserves ordering when allocation clock moves backwards', async () => {
  const root = await new TestWorkspace().create('audit-utc-'), paths = await ProjectPaths.open(root);
  let now = Date.parse('2026-10-29T23:59:59.999Z');
  const writer = new AuditLog(1024, () => now);
  await writer.append(paths, { operationId: 'before', startedAt: new Date(now).toISOString() });
  now++; await writer.append(paths, { operationId: 'after', startedAt: new Date(now).toISOString() });
  now -= 1000; await writer.append(paths, { operationId: 'clock-back', startedAt: new Date(now).toISOString() });
  const files = await readdir(join(root, '.codex-work/logs/cocos-mcp/operations'));
  assert.equal(files.length, 3);
  const page = await new OperationAudit().rows(paths, { from: '2026-10-30T00:00:00Z', to: '2026-10-31T00:00:00Z' });
  assert.deepEqual((page.rows as JsonObject[]).map(row => row.operationId), ['after']);
  const all = await new OperationAudit().rows(paths, {});
  assert.deepEqual((all.rows as JsonObject[]).map(row => row.operationId), ['before', 'after', 'clock-back']);
});
