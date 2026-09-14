import { build } from 'esbuild';
import { readdir, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const sources = (await readdir('tests')).filter(path => path.endsWith('.test.ts')).map(path => join('tests', path));
if (!sources.length) throw new Error('No tests found');
const output = '.codex-work/build/tests';
await mkdir(output, { recursive: true });
await build({ entryPoints: sources, outdir: output, outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external', platform: 'node', target: 'node24', format: 'esm', sourcemap: true });
const paths = sources.map(path => join(output, path.split('/').pop().replace(/\.ts$/, '.mjs')));
const processTest = spawn(process.execPath, ['--test', '--test-concurrency=1', ...paths], { stdio: 'inherit', env: process.env });
processTest.on('error', error => { console.error(error); process.exitCode = 1; });
processTest.on('exit', code => { process.exitCode = code ?? 1; });
