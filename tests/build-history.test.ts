import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BuildHistory, type BuildJob } from '../packages/native-adapters/src/build-history.js';
import { BuildJobs } from '../packages/native-adapters/src/build.js';
import { AtomicJsonFile } from '../packages/native-adapters/src/atomic-json.js';
import { TestWorkspace } from './workspace.js';
import { Json } from '../packages/contracts/src/index.js';

class HistoryFixture {
  root = '';
  async open(): Promise<void> { this.root = await new TestWorkspace().create('build-history-'); }
  job(): BuildJob { return { jobId: randomUUID(), projectId: 'project', projectPath: this.root, state: 'failed', platform: 'web-mobile', creatorVersion: '3.8.8', startedAt: '2026-10-29T00:00:00.000Z', outputPath: join(this.root, '.codex-work/build/output'), logPath: join(this.root, '.codex-work/logs/build.log') }; }
  index(job: BuildJob): string { return join(this.root, '.codex-work/cache/cocos-mcp/build-history', job.jobId.slice(0, 2), job.jobId + '.json'); }
}
class IndexFailure extends AtomicJsonFile {
  fail = false; afterCommit = false;
  override async write(path: string, value: unknown): Promise<void> {
    if (this.fail && path.includes('/cache/')) {
      if (this.afterCommit) await super.write(path, value);
      throw new Error('injected index commit failure');
    }
    await super.write(path, value);
  }
}

test('build history separates large records from indexes and preserves the legacy index unchanged', async () => {
  const f = new HistoryFixture(); await f.open(); const legacy = f.job(), cache = join(f.root, '.codex-work/cache/cocos-mcp');
  await mkdir(cache, { recursive: true }); const original = JSON.stringify([legacy]); await writeFile(join(cache, 'build-jobs.json'), original);
  const store = new BuildHistory(); const jobs: BuildJob[] = [];
  for (let index = 0; index < 18; index++) {
    const job = { ...f.job(), error: 'e'.repeat(1024 * 1024), operationId: `operation-${index}`, requestHash: 'a'.repeat(64) };
    await store.save(job); jobs.push(job);
    assert.ok((await readFile(f.index(job))).length < 2048);
  }
  const restarted = new BuildHistory(), rows = await restarted.load(f.root);
  assert.equal(rows.length, 19); assert.equal(rows.filter(row => row.error !== undefined).length, 0);
  assert.equal((await restarted.detail(rows.find(row => row.jobId === jobs[0]!.jobId)!)).error?.length, 1024 * 1024);
  const unchanged = await readFile(f.index(jobs[1]!), 'utf8');
  await restarted.save({ ...jobs[0]!, error: 'only this task changed' });
  assert.equal(await readFile(f.index(jobs[1]!), 'utf8'), unchanged);
  assert.equal(await readFile(join(cache, 'build-jobs.json'), 'utf8'), original);
});

test('failed index commit preserves previous complete state; concurrent saves commit in invocation order', async () => {
  const f = new HistoryFixture(); await f.open(); const fault = new IndexFailure(), history = new BuildHistory(fault), job = f.job();
  await history.save(job); const before = await readFile(f.index(job), 'utf8'); fault.fail = true;
  await assert.rejects(history.save({ ...job, state: 'outcome-unknown', recoveryRequired: true }), /injected/);
  assert.equal(await readFile(f.index(job), 'utf8'), before);
  assert.equal((await new BuildHistory().load(f.root))[0]!.state, 'failed');
  fault.afterCommit = true;
  await assert.rejects(history.save({ ...job, state: 'outcome-unknown', recoveryRequired: true }), /injected/);
  const committed = (await new BuildHistory().load(f.root))[0]!;
  assert.equal(committed.state, 'outcome-unknown'); assert.equal(committed.recoveryRequired, true);
  fault.fail = false;
  await Promise.all([history.save({ ...job, state: 'running' }), history.save({ ...job, state: 'outcome-unknown', recoveryRequired: true })]);
  assert.equal((await new BuildHistory().load(f.root))[0]!.state, 'outcome-unknown');
  const snapshots = await readdir(join(f.root, '.codex-work/logs/build-history', job.jobId)); assert.ok(snapshots.length >= 3);
});

test('build history validates record integrity and keeps unknown operation recovery across restarts', async () => {
  const f = new HistoryFixture(); await f.open(); const job = { ...f.job(), state: 'running' as const, spawnAttempted: true, operationId: 'unknown-op', requestHash: 'b'.repeat(64) };
  await new BuildHistory().save(job);
  const jobs = new BuildJobs();
  const state = Json.object(await jobs.status('project', f.root, job.jobId));
  assert.equal(state.state, 'outcome-unknown'); assert.equal(state.recoveryRequired, true);
  assert.equal(Json.object((await jobs.operation('project', f.root, 'unknown-op'))!).status, 'unknown');
  await assert.rejects(jobs.start('project', f.root, '/unused', 'web-mobile'), { code: 'RESOURCE_BUSY' });
  await jobs.close();
  const history = new BuildHistory(), rows = await history.load(f.root), index = JSON.parse(await readFile(f.index(job), 'utf8'));
  await writeFile(join(f.root, '.codex-work/logs/build-history', job.jobId, index.digest + '.json'), JSON.stringify({ ...rows[0], error: 'tampered' }));
  await assert.rejects(history.detail(rows[0]!), { code: 'VERIFICATION_FAILED' });
  index.summary.state = 'succeeded'; await writeFile(f.index(job), JSON.stringify(index));
  await assert.rejects(new BuildHistory().load(f.root), { code: 'VERIFICATION_FAILED' });
});
