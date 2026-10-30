import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { StageTimings } from '../packages/native-adapters/src/stage-timings.js';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { OperationAudit } from '../packages/application/src/operation-audit.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
import { TestWorkspace } from './workspace.js';

test('stage clocks separate queue delay and execution, retain failed phases and return detached snapshots', async () => {
  let clock = 0; const timings = new StageTimings(() => clock), leaveQueue = timings.start('queue');
  clock = 12; leaveQueue(); clock = 99; leaveQueue();
  const original = new Error('native failure');
  await assert.rejects(timings.measure('native', async () => { clock += 7; throw original; }), error => error === original);
  const rows = timings.rows(); assert.deepEqual(rows, [{ stage: 'queue', durationMs: 12, calls: 1 }, { stage: 'native', durationMs: 7, calls: 1 }]);
  rows[0]!.durationMs = 10000; assert.equal(timings.rows()[0]!.durationMs, 12);
});

test('application keeps partial evidence in warnings and audit without retrying the original capture', async () => {
  const root = await new TestWorkspace().create('partial-capture-'), projects = new ProjectRegistry(), { projectId } = await projects.add(root);
  const operationId = 'partial-capture', folder = join(root, '.codex-work/artifacts/cocos-mcp', createHash('sha256').update(operationId).digest('hex'));
  await mkdir(join(folder, 'capture-1.png'), { recursive: true });
  const dataUrl = 'data:image/png;base64,' + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4]).toString('base64');
  let calls = 0;
  const app = new CocosApplication(projects, undefined, undefined, false, { select: () => 'runtime', execute: async () => { calls++; return { rows: [{ dataUrl }, { dataUrl }] }; } });
  const request = { projectId, operationId, capabilityId: 'runtime.capture', params: {} };
  const result = await app.execute(request), details = Json.object(result.warnings?.[0]?.details);
  assert.equal((details.evidenceRefs as JsonObject[]).length, 1);
  assert.equal(Json.object(Json.object(details.evidenceFailure).pendingEvidence).path, join(folder, 'capture-1.png'));
  assert.doesNotMatch(Json.canonical(details), /base64/);
  await app.execute(request); assert.equal(calls, 1);
  const terminal = ((await new OperationAudit().rows(projects.paths(projectId), {})).rows as JsonObject[]).find(row => row.outcome === 'completed')!;
  assert.equal((terminal.evidenceRefs as JsonObject[]).length, 1);
  assert.deepEqual(terminal.evidenceFailure, details.evidenceFailure);
  assert.ok(result.timings?.some(row => row.stage === 'evidence-write'));
});

test('application exposes measured stages and persists a pre-terminal audit snapshot without payload data', async () => {
  const root = await new TestWorkspace().create('stage-audit-'), projects = new ProjectRegistry(), { projectId } = await projects.add(root);
  const app = new CocosApplication(projects, undefined, undefined, false, { select: () => 'runtime', execute: async () => ({ secretPayload: 'not-a-timing-field' }) });
  const result = await app.execute({ projectId, capabilityId: 'runtime.query', params: {} });
  assert.deepEqual(result.timings?.map(row => row.stage), ['audit-begin', 'queue', 'runtime-dispatch', 'audit-terminal']);
  assert.ok(result.timings?.every(row => typeof row.durationMs === 'number' && row.durationMs >= 0 && row.calls === 1));
  const audit = await new OperationAudit().rows(projects.paths(projectId), {});
  const terminal = (audit.rows as JsonObject[]).find(row => row.outcome === 'completed')!;
  assert.deepEqual((terminal.timings as JsonObject[]).map(row => row.stage), ['audit-begin', 'queue', 'runtime-dispatch']);
  assert.doesNotMatch(Json.canonical(terminal), /secretPayload|not-a-timing-field/);
});
