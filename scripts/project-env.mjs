import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = join(root, '.codex-work');
const requestedTmp = process.env.TMPDIR;
const taskTmp = requestedTmp && requestedTmp.startsWith(join(work, 'tmp') + '/') ? requestedTmp : join(work, 'tmp', `process-${process.pid}`);
mkdirSync(taskTmp, { recursive: true });
for (const directory of ['tmp', 'cache', 'build', 'logs', 'downloads']) {
  mkdirSync(join(work, directory), { recursive: true });
}
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node scripts/project-env.mjs <command> [...args]');
const environment = {
  ...process.env,
  TMPDIR: taskTmp, TMP: taskTmp, TEMP: taskTmp,
  XDG_CACHE_HOME: join(work, 'cache'),
  XDG_CONFIG_HOME: join(work, 'cache', 'config'),
  XDG_DATA_HOME: join(work, 'cache', 'data'),
  XDG_STATE_HOME: join(work, 'cache', 'state'),
  COREPACK_HOME: join(homedir(), '.codex-cache', 'corepack'),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  PNPM_HOME: join(work, 'cache', 'pnpm-home'),
  npm_config_cache: join(homedir(), '.codex-cache', 'npm'),
  npm_config_store_dir: join(homedir(), '.codex-cache', 'pnpm-store'),
  NODE_COMPILE_CACHE: join(work, 'cache', 'node'),
  PYTHONDONTWRITEBYTECODE: '1', TZ: 'UTC',
};
const child = spawn(command, args, { cwd: root, env: environment, stdio: 'inherit', shell: false });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
