import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { TestWorkspace } from './workspace.js';

class ReleaseFixture {
  root = ''; fingerprint = ''; attempt: Record<string, unknown> = {};
  readonly script = resolve('scripts/release-bundle.mjs');
  readonly exec = promisify(execFile);
  hash(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
  async put(path: string, value: string): Promise<void> {
    const full = join(this.root, path); await mkdir(dirname(full), { recursive: true }); await writeFile(full, value);
  }
  async setup(): Promise<void> {
    this.root = await new TestWorkspace().create('release-bundle-');
    for (const name of ['apps', 'packages', 'extensions', 'scripts', 'tests', 'examples', '.github']) await mkdir(join(this.root, name));
    for (const name of ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', '.npmrc', 'pnpm-workspace.yaml']) await this.put(name, '{}\n');
    await this.put('.github/release-notes.md', '# Fixture release\n');
    const module = pathToFileURL(resolve('scripts/verification.mjs')).href;
    this.fingerprint = (await this.exec(process.execPath, ['--input-type=module', '-e', `import {VerificationBuild} from ${JSON.stringify(module)};console.log(await new VerificationBuild().fingerprint());`], { cwd: this.root })).stdout.trim();
    const report = '.codex-work/logs/verification-tests.jsonl', events = JSON.stringify({ event: 'test:pass', file: 'fixture.mjs' }) + '\n';
    const reportSha256 = this.hash(events);
    await this.put(report, events);
    this.attempt = { sourceFingerprint: this.fingerprint, endingFingerprint: this.fingerprint, exitCode: 0, report, reportSha256 };
    await this.put('.codex-work/cache/verification/latest-run.json', JSON.stringify(this.attempt));
    await this.put('.codex-work/cache/verification/source-tests.json', JSON.stringify({ report, records: [{ sourceFingerprint: this.fingerprint, reportSha256 }] }));
    await this.put('.codex-work/build/build-profile.json', JSON.stringify({ profile: 'release', state: 'completed', sourceFingerprint: this.fingerprint, majors: [2, 3], targets: ['server', 'client', 'runtime', 'smoke'] }));
    const files = JSON.parse(await readFile(resolve('packages/native-adapters/src/extension-files.json'), 'utf8')) as Record<string, string[]>;
    for (const major of [2, 3]) {
      const root = `.codex-work/build/extensions/creator${major}`, fileHashes: Record<string, string> = {};
      for (const path of [...files[String(major)]!, ...files.presentation!]) if (path !== 'package.json') {
        const bytes = `creator${major}:${path}`; await this.put(`${root}/${path}`, bytes); fileHashes[path] = this.hash(bytes);
      }
      await this.put(`${root}/package.json`, JSON.stringify({ version: '1.0.0', buildId: `fixture-${major}`, sourceFingerprint: this.fingerprint, verificationReportSha256: reportSha256, fileHashes }));
    }
    const clientFiles = JSON.parse(await readFile(resolve('packages/native-adapters/src/client-files.json'), 'utf8')) as string[], fileHashes: Record<string, string> = {};
    for (const name of clientFiles) { const bytes = `client:${name}`; await this.put(`.codex-work/build/client/${name}`, bytes); fileHashes[name] = this.hash(bytes); }
    await this.put('.codex-work/build/client/manifest.json', JSON.stringify({ version: '1.0.0', buildId: 'fixture-client', sourceFingerprint: this.fingerprint, verificationReportSha256: reportSha256, fileHashes }));
  }
  run(args: string[] = []): Promise<unknown> { return this.exec(process.execPath, [this.script, ...args], { cwd: this.root, timeout: 15000 }); }
}

test('release bundling emits standard checksums and identical ZIP/update bytes, and never overwrites a candidate', async () => {
  const f = new ReleaseFixture(); await f.setup(); await f.run(['--directory', 'candidate-a']);
  const output = join(f.root, '.codex-work/build/release-candidates/candidate-a');
  const checksums = await readFile(join(output, 'SHA256SUMS'), 'utf8');
  assert.ok(checksums.endsWith('\n')); assert.ok(checksums.split('\n').length > 8);
  for (const line of checksums.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)$/.exec(line); assert.ok(match);
    assert.equal(f.hash(await readFile(join(output, match[2]!))), match[1]);
  }
  const zipped = unzipSync(await readFile(join(output, 'cocos-mcp-creator3.zip')));
  const update = JSON.parse(await readFile(join(output, 'cocos-mcp-creator3.full.json'), 'utf8')) as { rows: Array<{ path: string; content: string }> };
  assert.deepEqual(Object.keys(zipped).sort(), update.rows.map(row => row.path).sort());
  for (const row of update.rows) assert.deepEqual(Buffer.from(zipped[row.path]!), Buffer.from(row.content, 'base64'));
  await assert.rejects(f.run(['--directory', 'candidate-a']), /EEXIST/);
  assert.equal(await readFile(join(output, 'SHA256SUMS'), 'utf8'), checksums);
  await assert.rejects(f.run(['--directory', '../escape']), /unique-candidate-name/);
});

test('release bundling rejects the latest failed run even if an older success cache still matches', async () => {
  const f = new ReleaseFixture(); await f.setup();
  await f.put('.codex-work/cache/verification/latest-run.json', JSON.stringify({ ...f.attempt, exitCode: 1 }));
  await assert.rejects(f.run(), /Latest full test attempt must pass/);
  await assert.rejects(access(join(f.root, '.codex-work/build/releases')), { code: 'ENOENT' });
});

test('corrupt later packages cannot leave a partially rewritten release directory', async () => {
  const f = new ReleaseFixture(); await f.setup();
  await f.put('.codex-work/build/extensions/creator3/dist/main.cjs', 'corrupted');
  await assert.rejects(f.run(), /incomplete or corrupt/);
  await assert.rejects(access(join(f.root, '.codex-work/build/releases')), { code: 'ENOENT' });
});
