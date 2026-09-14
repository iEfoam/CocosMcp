import { realpath, mkdir, lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, dirname, join } from 'node:path';
import { CocosError } from '../../contracts/src/index.js';

export class ProjectPaths {
  private constructor(readonly root: string) {}

  static async open(root: string): Promise<ProjectPaths> {
    const actual = await realpath(root);
    if (!(await lstat(actual)).isDirectory()) throw new CocosError('INVALID_ARGUMENT', 'Project path is not a directory');
    return new ProjectPaths(actual);
  }

  private contains(path: string): boolean {
    const rel = relative(this.root, path);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  }

  async resolve(path: string): Promise<string> {
    const target = resolve(this.root, path);
    if (!this.contains(target)) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Path must remain inside the project');
    // 尚不存在的目标也逐级检查祖先，防止经符号链接写到工程外。
    let ancestor = target;
    while (true) {
      try {
        const actual = await realpath(ancestor);
        if (!this.contains(actual)) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Symbolic link escapes project');
        return target;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }

  async work(directory: 'tmp' | 'cache' | 'build' | 'logs' | 'downloads', child = ''): Promise<string> {
    const target = await this.resolve(join('.codex-work', directory, child));
    await mkdir(target, { recursive: true });
    return target;
  }

  async asset(url: string): Promise<string> {
    if (!url.startsWith('db://assets/') || url.includes('\\') || url.includes('\0')) throw new CocosError('INVALID_ARGUMENT', 'Expected db://assets/ URL');
    const suffix = url.slice('db://assets/'.length);
    if (suffix.split('/').some(part => part === '..' || part === '.')) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Asset URL contains traversal');
    return this.resolve(join('assets', suffix));
  }

  environment(): NodeJS.ProcessEnv {
    const work = join(this.root, '.codex-work');
    return { ...process.env, TMPDIR: join(work, 'tmp'), TMP: join(work, 'tmp'), TEMP: join(work, 'tmp'),
      XDG_CACHE_HOME: join(work, 'cache'), XDG_CONFIG_HOME: join(work, 'cache', 'config'),
      XDG_DATA_HOME: join(work, 'cache', 'data'), XDG_STATE_HOME: join(work, 'cache', 'state'),
      NODE_COMPILE_CACHE: join(work, 'cache', 'node'), TZ: 'UTC' };
  }
}
