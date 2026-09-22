import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = join(root, '.codex-work');
for (const directory of ['tmp', 'cache', 'build', 'logs', 'downloads']) {
  mkdirSync(join(work, directory), { recursive: true });
}
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node scripts/project-env.mjs <command> [...args]');
const environment = {
  ...process.env,
  TMPDIR: join(work, 'tmp'), TMP: join(work, 'tmp'), TEMP: join(work, 'tmp'),
  XDG_CACHE_HOME: join(work, 'cache'),
  XDG_CONFIG_HOME: join(work, 'cache', 'config'),
  XDG_DATA_HOME: join(work, 'cache', 'data'),
  XDG_STATE_HOME: join(work, 'cache', 'state'),
  COREPACK_HOME: join(work, 'cache', 'corepack'),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  PNPM_HOME: join(work, 'cache', 'pnpm-home'),
  npm_config_cache: join(work, 'cache', 'npm'),
  NODE_COMPILE_CACHE: join(work, 'cache', 'node'),
  PYTHONDONTWRITEBYTECODE: '1', TZ: 'UTC',
};
const child = spawn(command, args, { cwd: root, env: environment, stdio: 'inherit', shell: false });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
