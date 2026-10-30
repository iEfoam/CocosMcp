import { TestWorkspace } from './workspace.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { BuildJobs } from '../packages/native-adapters/src/build.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
import { CreatorAccount } from '../scripts/creator-account.mjs';
import { WorkspaceStorage } from '../scripts/workspace-storage.mjs';

class BuildSessionHarness {
  project = '';
  creator = '';
  async setup(): Promise<void> {
    this.project = await new TestWorkspace().create('build-session-');
    this.creator = join(this.project, 'Creator.app');
    const resources = join(this.creator, 'Contents/Resources/app');
    const executable = join(this.creator, 'Contents/MacOS/CocosCreator');
    await mkdir(resources, { recursive: true });
    await mkdir(join(this.creator, 'Contents/MacOS'), { recursive: true });
    await writeFile(join(resources, 'package.json'), JSON.stringify({ version: '3.8.8' }));
    const account = join(this.project, '.codex-work/cache/creator-home/profiles/v2/editor');
    await mkdir(account, { recursive: true });
    await writeFile(join(account, 'user.json'), JSON.stringify({ session_id: 'fake-session', session_key: 'fake-key', cocos_uid: 1 }));
    // 用假的持久会话验证跨服务重启的目录复用，不读取任何真实账号凭证。
    await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2);
const profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice(16);
const home = args[args.indexOf('--home') + 1];
const configPath = args[args.indexOf('--build') + 1].slice(11);
const config = JSON.parse(fs.readFileSync(configPath));
const marker = path.join(profile, 'test-session');
const reused = fs.existsSync(marker);
fs.writeFileSync(marker, 'fake-session');
fs.writeFileSync(path.join(config.buildPath, 'result.json'), JSON.stringify({profile, home, configPath, reused}));
process.exit(36);
`);
    await chmod(executable, 0o700);
  }
  async build(operationId?: string): Promise<{ job: JsonObject; result: JsonObject }> {
    const service = new BuildJobs(new CreatorAccount(join(this.project, 'fake-native-account')));
    try {
      let job = Json.object(await service.start('project', this.project, this.creator, 'web-mobile', {}, operationId));
      for (let retry = 0; job.state === 'running' && retry < 100; retry++) {
        await setTimeout(20);
        job = Json.object(await service.status('project', this.project, String(job.jobId)));
      }
      assert.equal(job.state, 'succeeded');
      return { job, result: JSON.parse(await readFile(join(String(job.outputPath), 'result.json'), 'utf8')) };
    } finally { await service.close(); }
  }
}

test('Creator builds preserve a session across service restarts while isolating build outputs', { skip: process.platform !== 'darwin' }, async () => {
  const harness = new BuildSessionHarness(); await harness.setup();
  const first = await harness.build();
  const second = await harness.build();
  assert.equal(first.result.reused, false);
  assert.equal(second.result.reused, true);
  assert.equal(first.result.profile, second.result.profile);
  assert.equal(first.result.home, second.result.home);
  assert.notEqual(first.result.configPath, second.result.configPath);
  assert.notEqual(first.job.outputPath, second.job.outputPath);
  assert.ok(String(first.result.profile).startsWith(harness.project + '/.codex-work/'));
  assert.equal(first.result.home, join(harness.project, '.codex-work/cache/creator-home'));
  await assert.rejects(lstat(String(first.result.configPath)), { code: 'ENOENT' });
  await assert.rejects(lstat(String(second.result.configPath)), { code: 'ENOENT' });
  assert.ok(await lstat(String(first.job.logPath)));
  assert.ok(await lstat(String(first.job.outputPath)));
  const configuration = JSON.parse(await readFile(join(harness.project, '.codex-work/logs/builds', `${first.job.jobId}.config.json`), 'utf8'));
  assert.equal(configuration.buildPath, first.job.outputPath); assert.equal(configuration.platform, 'web-mobile');
});

test('completed build operation replays from split history after restart without launching again', { skip: process.platform !== 'darwin' }, async () => {
  const harness = new BuildSessionHarness(); await harness.setup();
  const first = await harness.build('durable-build'), second = await harness.build('durable-build');
  assert.equal(first.job.jobId, second.job.jobId); assert.deepEqual(first.result, second.result);
  const service = new BuildJobs(new CreatorAccount(join(harness.project, 'fake-native-account')));
  try {
    await assert.rejects(service.start('project', harness.project, harness.creator, 'web-desktop', {}, 'durable-build'), { code: 'OPERATION_CONFLICT' });
    assert.equal((Json.object(await service.list('project', harness.project)).rows as unknown[]).length, 1);
  } finally { await service.close(); }
});

test('failed Creator build retains its owned temporary configuration and diagnostic marker', { skip: process.platform !== 'darwin' }, async () => {
  const harness = new BuildSessionHarness(); await harness.setup();
  await writeFile(join(harness.creator, 'Contents/MacOS/CocosCreator'), `#!${process.execPath}\nprocess.exit(1);\n`);
  const service = new BuildJobs(new CreatorAccount(join(harness.project, 'fake-native-account')));
  let job: JsonObject;
  try {
    job = Json.object(await service.start('project', harness.project, harness.creator, 'web-mobile'));
    for (let retry = 0; job.state === 'running' && retry < 100; retry++) { await setTimeout(20); job = Json.object(await service.status('project', harness.project, String(job.jobId))); }
    assert.equal(job.state, 'failed');
  } finally { await service.close(); }
  const inventory = await new WorkspaceStorage(harness.project).inventory();
  const retained = inventory.rows.find(row => row.category === 'tmp' && row.owner?.taskId === job.jobId);
  assert.equal(retained?.owner?.state, 'failed'); assert.ok(await lstat(join(retained!.path, 'build.json')));
});
