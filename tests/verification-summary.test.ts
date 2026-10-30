import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TestWorkspace } from './workspace.js';
import { VerificationBuild } from '../scripts/verification.mjs';
import { VerificationSummary } from '../packages/catalog-generator/src/verification-summary.js';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { VerificationRegistry } from '../packages/capability-catalog/src/verification.js';
import { Operations } from '../packages/capability-catalog/src/operations.js';
import type { JsonObject } from '../packages/contracts/src/index.js';

test('verification summaries never promote absent, changed or corrupted test evidence', async () => {
  const root = await new TestWorkspace().create('summary-'), verification = new VerificationBuild();
  assert.equal((await verification.overview('current', root)).state, 'unknown');
  await mkdir(join(root, '.codex-work/cache/verification'), { recursive: true }); await mkdir(join(root, '.codex-work/logs'), { recursive: true });
  const report = '.codex-work/logs/verification-tests.jsonl';
  const bytes = JSON.stringify({ event: 'test:pass', skipped: false }) + '\n';
  await writeFile(join(root, report), bytes);
  const attempt = { sourceFingerprint: 'current', endingFingerprint: 'current', report, reportSha256: createHash('sha256').update(bytes).digest('hex'), exitCode: 0 };
  await writeFile(join(root, verification.attemptPath), JSON.stringify(attempt));
  await writeFile(join(root, verification.recordPath), JSON.stringify({ report, records: [{ reportSha256: attempt.reportSha256 }] }));
  assert.equal((await verification.verifiedRecords(root)).length, 1);
  const current = await verification.overview('current', root);
  assert.equal(current.state, 'passed'); assert.deepEqual(current.counts, { passed: 1, failed: 0, skipped: 0, cancelled: 0 });
  assert.equal((await verification.overview('changed', root)).state, 'historical');
  await writeFile(join(root, verification.attemptPath), JSON.stringify({ ...attempt, exitCode: 1 }));
  assert.equal((await verification.overview('current', root)).state, 'failed');
  await writeFile(join(root, report), bytes + '{}');
  assert.equal((await verification.overview('current', root)).state, 'unknown');
  assert.equal((await verification.verifiedRecords(root)).length, 0);
});

test('summary separates adapter tests, version-specific native evidence and module scope acceptance', () => {
  const evidence = new VerificationRegistry({ sourceFingerprint: 'current', records: [
    { id: 'adapter', level: 'adapter-tested', entryIds: ['scene.query'], source: 'fixture', sourceFingerprint: 'current', limitations: 'mock' },
    { id: 'old-native', level: 'editor-verified', entryIds: ['scene.query'], creatorVersion: '2.4.15', source: 'old', sourceFingerprint: 'old', limitations: 'historical' },
    { id: 'native3', level: 'editor-verified', entryIds: ['node.query'], creatorVersion: '3.8.8', source: 'native', sourceFingerprint: 'current', limitations: 'one operation' },
  ] });
  const catalog = new CapabilityCatalog(new Operations().list(), evidence);
  const summary = new VerificationSummary(catalog).create('current', { state: 'passed', counts: { passed: 1 } });
  const versions = summary.json.versions as JsonObject[];
  assert.equal(versions[0]!.currentNativeOperations, 0); assert.equal(versions[1]!.currentNativeOperations, 1);
  assert.ok((versions[1]!.unverifiedOperationIds as string[]).includes('scene.query'));
  assert.ok((summary.json.rows as JsonObject[]).every(row => row.scopeAcceptance === 'pending'));
  assert.match(summary.markdown, /unknown/); assert.match(summary.markdown, /不能.*推断通过/);
});
