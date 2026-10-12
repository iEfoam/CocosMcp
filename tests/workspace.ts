import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdtemp as createDirectory } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/** 测试目录统一归属于当前运行；子进程退出后由 runner 回收整个运行目录。 */
export class TestWorkspace {
  private directory(): string {
    const requested = process.env.COCOS_TEST_TMP ?? process.env.TMPDIR;
    if (!requested) throw new Error('Run tests through scripts/test.mjs with a project temporary directory');
    const root = realpathSync(resolve('.codex-work/tmp'));
    const directory = realpathSync(requested);
    if (!directory.startsWith(root + sep)) throw new Error('Test temporary directory escapes project');
    return directory;
  }
  async create(prefix: string): Promise<string> {
    if (!/^[a-z0-9-]+-$/.test(prefix)) throw new Error('Invalid test directory prefix');
    return createDirectory(join(this.directory(), prefix));
  }
  createSync(prefix: string): string {
    if (!/^[a-z0-9-]+-$/.test(prefix)) throw new Error('Invalid test directory prefix');
    return mkdtempSync(join(this.directory(), prefix));
  }
}
