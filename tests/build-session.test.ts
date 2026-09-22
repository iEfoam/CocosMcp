import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { BuildJobs } from '../packages/native-adapters/src/build.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';

class BuildSessionHarness {
  project = '';
  creator = '';
  async setup(): Promise<void> {
    this.project = await mkdtemp(join(process.cwd(), '.codex-work/tmp/build-session-'));
    this.creator = join(this.project, 'Creator.app');
    const resources = join(this.creator, 'Contents/Resources/app');
    const executable = join(this.creator, 'Contents/MacOS/CocosCreator');
    await mkdir(resources, { recursive: true });
    await mkdir(join(this.creator, 'Contents/MacOS'), { recursive: true });
    await writeFile(join(resources, 'package.json'), JSON.stringify({ version: '3.8.8' }));
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
  async build(): Promise<{ job: JsonObject; result: JsonObject }> {
    const service = new BuildJobs();
    try {
      let job = Json.object(await service.start('project', this.project, this.creator, 'web-mobile'));
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
});
