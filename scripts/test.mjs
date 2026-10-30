import { VerificationBuild } from './verification.mjs';
import { build } from 'esbuild';
import { readdir, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { WorkspaceStorage } from './workspace-storage.mjs';

const verification = new VerificationBuild();
const args = process.argv.slice(2), focused = args[0] === '--files';
if (args.length && (!focused || args.length < 2 || args.slice(1).some(name => !/^[a-zA-Z0-9_-]+\.test\.ts$/.test(name)))) throw new Error('Focused tests require --files <name.test.ts> ...');
if (!focused) await verification.clear();
const sourceFingerprint = await verification.fingerprint();
const available = (await readdir('tests')).filter(path => path.endsWith('.test.ts'));
if (focused && args.slice(1).some(name => !available.includes(name))) throw new Error('Unknown focused test file');
const sources = (focused ? [...new Set(args.slice(1))] : available).map(path => join('tests', path));
if (!sources.length) throw new Error('No tests found');
const output = focused ? '.codex-work/build/profiles/dev/tests' : '.codex-work/build/tests';
await mkdir(output, { recursive: true });
await build({ entryPoints: sources, outdir: output, outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external', platform: 'node', target: 'node24', format: 'esm', sourcemap: true });
const paths = sources.map(path => join(output, path.split('/').pop().replace(/\.ts$/, '.mjs')));
const storage = new WorkspaceStorage(process.cwd()), receipt = await storage.createTestRun(), temporary = receipt.directory;
await mkdir('.codex-work/logs', { recursive: true });
const evidencePath = focused ? '.codex-work/logs/verification-dev-tests.jsonl' : '.codex-work/logs/verification-tests.jsonl';
// 所有 fixture 使用同一运行目录，避免并行任务目录混入清理范围。
const processTest = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=./scripts/test-evidence-reporter.mjs', `--test-reporter-destination=${evidencePath}`, ...paths], { stdio: 'inherit', env: { ...process.env, COCOS_TEST_TMP: temporary, TMPDIR: temporary, TMP: temporary, TEMP: temporary } });
processTest.on('error', error => { console.error(error); process.exitCode = 1; });
let code;
try { code = await new Promise((resolve, reject) => { processTest.once('error', reject); processTest.once('close', resolve); }); }
catch (error) { await storage.finish(receipt, false); throw error; }
process.exitCode = code ?? 1;
try {
  if (!focused) await verification.attempt(sourceFingerprint, sources, evidencePath, code ?? 1);
  if (code === 0 && !focused) await verification.record(sourceFingerprint, sources, evidencePath);
} catch (error) { await storage.finish(receipt, false); throw error; }
await storage.finish(receipt, code === 0);
if (code === 0) {
  // 局部通过不生成或替换全量发布证据，避免开发检查冒充发布验收。
  // close 已确认测试子进程及其句柄退出；仅删除本次创建且可再生的 fixture。
  const cleanup = await storage.cleanup(receipt);
  console.log(`${cleanup.removed ? 'Removed completed' : 'Retained'} test workspace: ${temporary}; ${cleanup.reason}`);
} else {
  console.error('Failed test workspace retained for diagnosis: ' + temporary);
}
