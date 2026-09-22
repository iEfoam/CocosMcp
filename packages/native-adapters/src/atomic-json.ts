import { writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

/** 同目录原子替换，避免构建状态读取者看到 truncate 后尚未写完的 JSON。 */
export class AtomicJsonFile {
  private readonly pending = new Map<string, Promise<void>>();
  async write(path: string, value: unknown): Promise<void> {
    const content = JSON.stringify(value, null, 2);
    const previous = this.pending.get(path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      // Creator 2 内置 Node 不提供 randomUUID；临时文件名只需要足够随机且不可碰撞。
      const temporary = `${path}.${randomBytes(16).toString('hex')}.writing`;
      try { await writeFile(temporary, content, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
    this.pending.set(path, next);
    try { await next; } finally { if (this.pending.get(path) === next) this.pending.delete(path); }
  }
}
