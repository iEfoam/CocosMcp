import { createHash } from 'crypto';
import { constants, type Stats } from 'fs';
import { open, lstat, type FileHandle } from 'fs/promises';
import { CocosError } from '../../contracts/src/index.js';

export interface FileSnapshot { bytes: number; sha256: string; identity: Stats; text?: string }

/** 绑定同一个打开的文件描述符读取；读取后同时检查句柄和路径，拒绝增长、原位修改或替换。 */
export class FileSnapshots {
  protected async *chunks(_path: string, file: FileHandle, limit: number): AsyncIterable<Buffer> {
    // 多读一个字节识别增长；直接分块读句柄，避免流提前退出时自动关闭 fd 并掩盖原始错误。
    let position = 0;
    while (position <= limit) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit - position + 1));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead; yield buffer.subarray(0, bytesRead);
    }
  }
  private same(before: Stats, after: Stats): boolean {
    return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
      && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
  }
  async verify(path: string, identity: Stats): Promise<void> {
    if (!this.same(identity, await lstat(path))) throw new CocosError('STALE_REVISION', 'Asset changed during snapshot inspection');
  }
  async read(path: string, limit: number, collectText = false): Promise<FileSnapshot> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new CocosError('INVALID_ARGUMENT', 'Invalid asset byte budget');
    const initial = await lstat(path);
    if (!initial.isFile() || initial.isSymbolicLink()) throw new CocosError('INVALID_ARGUMENT', 'Asset snapshot requires a regular non-symlink file');
    if (initial.size > limit) throw new CocosError('RESOURCE_BUSY', 'Asset snapshot byte budget exceeded');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const identity = await file.stat();
      if (!this.same(initial, identity)) throw new CocosError('STALE_REVISION', 'Asset was replaced before snapshot read');
      const hash = createHash('sha256'), chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of this.chunks(path, file, limit)) {
        bytes += chunk.length;
        if (bytes > limit || bytes > identity.size) throw new CocosError('RESOURCE_BUSY', 'Asset grew beyond snapshot budget');
        hash.update(chunk); if (collectText) chunks.push(chunk);
      }
      if (bytes !== identity.size || !this.same(identity, await file.stat())) throw new CocosError('STALE_REVISION', 'Asset changed while reading snapshot');
      await this.verify(path, identity);
      return { bytes, sha256: hash.digest('hex'), identity, ...(collectText ? { text: Buffer.concat(chunks).toString('utf8') } : {}) };
    } finally { await file.close(); }
  }
}
