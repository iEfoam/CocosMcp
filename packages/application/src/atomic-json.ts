import { randomUUID } from 'node:crypto';
import { open, link, rename, unlink } from 'node:fs/promises';
import { CocosError, type JsonValue } from '../../contracts/src/index.js';

export class AtomicJson {
  async write(path: string, value: JsonValue, exclusive = false): Promise<void> {
    // 临时文件必须与目标同目录，避免跨文件系统 rename，也不使用系统临时目录。
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
      finally { await file.close(); }
      // 首次发布使用原子 hard-link 保留排他创建语义，不能由 rename 覆盖已有工作流。
      if (exclusive) await link(temporary, path);
      else await rename(temporary, path);
    } catch (error) {
      if (exclusive && (error as NodeJS.ErrnoException).code === 'EEXIST') throw new CocosError('OPERATION_CONFLICT', 'Workflow ID already exists; query its status before recovery');
      throw error;
    } finally {
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }
}
