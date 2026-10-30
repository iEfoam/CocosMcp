import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 登录状态只落在工程内；锁冲突和路径异常均失败关闭，不借重试删除别人的锁或凭据。 */
export class CreatorSessionStore {
  constructor(root) { this.root = root; }
  async safe(path) {
    let ancestor = path;
    while (true) {
      try {
        const actual = await realpath(ancestor);
        if (actual !== this.root && !actual.startsWith(this.root + '/')) throw new Error('Creator account path escapes project');
        break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
    }
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1) throw new Error('Creator account file must not be a link');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return path;
  }
  async directory(path) { await this.safe(path); await mkdir(path, { recursive: true, mode: 0o700 }); await this.safe(path); }
  async read(path) {
    await this.safe(path);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Creator session state exceeds limit');
      return await readFile(path);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async write(path, bytes, expected) {
    await this.directory(dirname(path)); await this.safe(path);
    const current = await this.read(path);
    if (expected !== undefined && (current === null ? expected !== null : !expected || !current.equals(expected))) throw new Error('Creator session changed concurrently; retry after inspecting the existing window');
    const temporary = path + '.' + randomUUID() + '.writing';
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try {
      // 原生编辑器不持有本工具锁，因此替换前再次比较；已打开的编辑器另外由调用层保护。
      const latest = await this.read(path);
      if (expected !== undefined && (latest === null ? expected !== null : !expected || !latest.equals(expected))) throw new Error('Creator session changed concurrently; original profile preserved');
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async backup(bytes) {
    const path = join(this.root, '.codex-work/backups/creator-account', randomUUID() + '.json');
    await this.write(path, bytes, null); return path;
  }
  async locked(name, task) {
    const directory = join(this.root, '.codex-work/cache/creator-session'); await this.directory(directory);
    const path = join(directory, name + '.lock'); await this.safe(path);
    const token = JSON.stringify({ pid: process.pid, owner: randomUUID() });
    let file;
    try { file = await open(path, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Creator session operation is already running or needs recovery; existing lock preserved'); throw error; }
    try { await file.writeFile(token); await file.sync(); return await task(); }
    finally {
      await file.close();
      const current = await this.read(path);
      if (current?.toString() === token) await unlink(path);
    }
  }
}
