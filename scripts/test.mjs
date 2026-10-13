import { VerificationBuild } from './verification.mjs';
import { build } from 'esbuild';
import { readdir, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const verification = new VerificationBuild();
await verification.clear();
const sourceFingerprint = await verification.fingerprint();
const sources = (await readdir('tests')).filter(path => path.endsWith('.test.ts')).map(path => join('tests', path));
if (!sources.length) throw new Error('No tests found');
const output = '.codex-work/build/tests';
await mkdir(output, { recursive: true });
await build({ entryPoints: sources, outdir: output, outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external', platform: 'node', target: 'node24', format: 'esm', sourcemap: true });
const paths = sources.map(path => join(output, path.split('/').pop().replace(/\.ts$/, '.mjs')));
await mkdir('.codex-work/tmp', { recursive: true });
const temporary = await mkdtemp(join(process.cwd(), '.codex-work/tmp/tests-'));
await writeFile(join(temporary, '.codex-task.json'), JSON.stringify({ kind: 'test-run', pid: process.pid, createdAtUTC: new Date().toISOString() }));
await mkdir('.codex-work/logs', { recursive: true });
const evidencePath = '.codex-work/logs/verification-tests.jsonl';
// 所有 fixture 使用同一运行目录，避免并行任务目录混入清理范围。
const processTest = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=./scripts/test-evidence-reporter.mjs', `--test-reporter-destination=${evidencePath}`, ...paths], { stdio: 'inherit', env: { ...process.env, COCOS_TEST_TMP: temporary, TMPDIR: temporary, TMP: temporary, TEMP: temporary } });
processTest.on('error', error => { console.error(error); process.exitCode = 1; });
const code = await new Promise((resolve, reject) => { processTest.once('error', reject); processTest.once('close', resolve); });
process.exitCode = code ?? 1;
if (code === 0) {
  await verification.record(sourceFingerprint, sources, evidencePath);
  // close 已确认测试子进程及其句柄退出；仅删除本次创建且可再生的 fixture。
  await rm(temporary, { recursive: true });
  console.log('Removed completed test workspace: ' + temporary);
} else {
  console.error('Failed test workspace retained for diagnosis: ' + temporary);
}
