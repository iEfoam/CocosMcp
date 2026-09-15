import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { BuildArtifacts } from '../packages/native-adapters/src/build-artifacts.js';
import { BuildJobs } from '../packages/native-adapters/src/build.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
class ArtifactFixture {
  project = ''; jobId = randomUUID(); root = '';
  async setup(state = 'succeeded'): Promise<void> {
    this.project = await mkdtemp(join(process.cwd(), '.codex-work/tmp/artifacts-'));
    this.root = join(this.project, '.codex-work/build/creator', this.jobId);
    await mkdir(join(this.root, 'game'), { recursive: true });
    await writeFile(join(this.root, 'game/index.html'), '<html>test</html>');
    const cache = join(this.project, '.codex-work/cache/cocos-mcp'); await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'build-jobs.json'), JSON.stringify([{ jobId: this.jobId, projectId: 'project', projectPath: this.project, state, platform: 'web-mobile', creatorVersion: '3.8.8', outputPath: '/untrusted/path', logPath: join(this.project, '.codex-work/logs/job.log') }]));
  }
}
test('build artifact inspection binds task identity, hashes files and separates files from runtime acceptance', async () => {
  const f = new ArtifactFixture(); await f.setup();
  const jobs = new BuildJobs(), result = Json.object(await jobs.artifacts('project', f.project, f.jobId, ['game/index.html']));
  assert.equal(result.status, 'files-verified'); assert.equal(result.launchVerified, false); assert.equal(result.installVerified, false);
  assert.equal((result.rows as JsonObject[])[0]!.sha256, createHash('sha256').update('<html>test</html>').digest('hex'));
  const again = Json.object(await jobs.artifacts('project', f.project, f.jobId, ['game/index.html'])); assert.equal(result.manifestHash, again.manifestHash);
  await writeFile(join(f.root, 'game/index.html'), 'changed');
  assert.notEqual(Json.object(await jobs.artifacts('project', f.project, f.jobId, ['game/index.html'])).manifestHash, result.manifestHash);
  assert.equal(Json.object(await jobs.artifacts('project', f.project, f.jobId, ['missing.apk'])).status, 'incomplete');
  await assert.rejects(jobs.artifacts('other-project', f.project, f.jobId, ['game/index.html']), { code: 'NOT_FOUND' });
});
test('artifact paths, symbolic links, resource bounds and unfinished jobs are rejected', async () => {
  const f = new ArtifactFixture(); await f.setup(); const tool = new BuildArtifacts();
  for (const entries of [[], ['../secret'], ['/absolute'], ['game/index.html', 'game/index.html']]) await assert.rejects(tool.inspect(f.project, f.jobId, entries), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(tool.inspect(f.project, '../escape', ['game/index.html']), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(new BuildArtifacts(100, 1).inspect(f.project, f.jobId, ['game/index.html']), /limit/);
  await symlink(join(f.root, 'game/index.html'), join(f.root, 'link'));
  await assert.rejects(tool.inspect(f.project, f.jobId, ['game/index.html']), { code: 'PATH_OUTSIDE_PROJECT' });
  const failed = new ArtifactFixture(); await failed.setup('failed');
  await assert.rejects(new BuildJobs().artifacts('project', failed.project, failed.jobId, ['game/index.html']), { code: 'OPERATION_CONFLICT' });
});
