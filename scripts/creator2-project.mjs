import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';

const root = await realpath(process.cwd());
const project = resolve(root, '.codex-work/build/creator2-test-project');
await mkdir(project, { recursive: true });
const expected = '71851d93-3567-4909-bb4e-f025c9861424';
try { if (JSON.parse(await readFile(join(project, 'project.json'), 'utf8')).id !== expected) throw new Error('Refusing to overwrite unrelated project'); }
catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(join(project, 'project.json'), JSON.stringify({ engine: 'cocos-creator-js', packages: 'packages', name: 'CocosMcp-Creator2-Acceptance', id: expected, version: '2.4.15', isNew: false }, null, 2)); }
await writeFile(join(project, '.gitignore'), '.codex-work/\nlibrary/\nlocal/\ntemp/\n');
for (const directory of ['assets', 'settings', 'packages', '.codex-work/tmp', '.codex-work/cache', '.codex-work/logs']) await mkdir(join(project, directory), { recursive: true });
if (process.argv.includes('--launch')) {
  const work = join(project, '.codex-work');
  const log = createWriteStream(join(work, 'logs/editor.log'), { flags: 'a' });
  const executable = '/Applications/Cocos/Creator/2.4.15/CocosCreator.app/Contents/MacOS/CocosCreator';
  // Creator 自身的 library/local/temp 是编辑器内部目录；受控临时路径和测试输出都置于 .codex-work。
  const child = spawn(executable, ['--path', project, '--project', project], { cwd: project,
    env: { ...process.env, TMPDIR: join(work, 'tmp'), TMP: join(work, 'tmp'), TEMP: join(work, 'tmp'), XDG_CACHE_HOME: join(work, 'cache') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  console.log(JSON.stringify({ project, pid: child.pid }));
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { log.end(); process.exitCode = code ?? 1; });
} else console.log(JSON.stringify({ project }));
