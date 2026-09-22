import { parseArgs } from 'node:util';
import { realpath, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// 固定沿用项目的 Creator 账号目录；不能为每次调试或启动创建新的 profile。
const { values } = parseArgs({ options: {
  project: { type: 'string' }, creator: { type: 'string' }, 'dry-run': { type: 'boolean' },
} });
if (!values.project || !values.creator) throw new Error('Usage: node scripts/open-creator.mjs --project <project> --creator <Creator 3.x executable> [--dry-run]');
const project = await realpath(values.project);
const executable = await realpath(values.creator);
if (!(await stat(project)).isDirectory() || !(await stat(executable)).isFile()) throw new Error('Expected a project directory and a Creator executable');
const work = join(project, '.codex-work');
const home = join(work, 'cache/creator-home');
// 保留当前测试工程已经使用的目录，避免修复启动入口时再次切换登录环境。
const userData = join(work, 'cache/shader-editor');
const args = ['--home', home, `--user-data-dir=${userData}`, '--project', project];
const environment = { ...process.env, TMPDIR: join(work, 'tmp'), TMP: join(work, 'tmp'), TEMP: join(work, 'tmp'),
  XDG_CACHE_HOME: join(work, 'cache'), XDG_CONFIG_HOME: join(work, 'cache/config'),
  XDG_DATA_HOME: join(work, 'cache/data'), XDG_STATE_HOME: join(work, 'cache/state'), NODE_COMPILE_CACHE: join(work, 'cache/node') };
// dry-run 只检查目标并输出参数，不启动编辑器或接触账号文件。
if (values['dry-run']) {
  console.log(JSON.stringify({ executable, args }, null, 2));
} else {
  for (const path of [home, userData, environment.TMPDIR, environment.XDG_CONFIG_HOME, environment.XDG_DATA_HOME, environment.XDG_STATE_HOME, environment.NODE_COMPILE_CACHE]) {
    // 拒绝通过已有符号链接将主动创建的内容写到工程外。
    let ancestor = path;
    while (true) {
      try {
        const actual = await realpath(ancestor);
        if (actual !== project && !actual.startsWith(project + '/')) throw new Error('Creator profile path escapes project');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        ancestor = join(ancestor, '..');
      }
    }
    await mkdir(path, { recursive: true });
  }
  const child = spawn(executable, args, { cwd: project, env: environment, stdio: 'inherit', shell: false });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
