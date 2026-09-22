import { constants } from 'node:fs';
import { lstat, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CocosError, type JsonValue } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';

interface Artifact { path: string; bytes: number; signature: string }
/** 构建成功不等于产物可运行；只核对固定任务目录内的完整文件集，不执行其中代码。 */
export class BuildArtifacts {
  constructor(private readonly maxFiles = 10000, private readonly maxBytes = 2 * 1024 ** 3) {}
  private signature(stat: Awaited<ReturnType<typeof lstat>>): string { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
  private async scan(root: string): Promise<{ files: Artifact[]; directories: Array<{ path: string; signature: string }> }> {
    const files: Artifact[] = [], directories: Array<{ path: string; signature: string }> = []; let bytes = 0;
    const visit = async (relative: string, depth: number): Promise<void> => {
      if (depth > 32 || directories.length >= this.maxFiles) throw new CocosError('INVALID_ARGUMENT', 'Artifact directory limit exceeded');
      const path = join(root, relative), before = await lstat(path);
      if (before.isSymbolicLink() || !before.isDirectory()) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Artifact directory must not be a symlink');
      directories.push({ path: relative, signature: this.signature(before) });
      for (const name of (await readdir(path)).sort()) {
        const child = relative ? `${relative}/${name}` : name, stat = await lstat(join(root, child));
        if (stat.isSymbolicLink()) throw new CocosError('PATH_OUTSIDE_PROJECT', `Artifact symlink is not allowed: ${child}`);
        if (stat.isDirectory()) await visit(child, depth + 1);
        else if (stat.isFile()) {
          bytes += stat.size;
          if (files.length >= this.maxFiles || bytes > this.maxBytes) throw new CocosError('INVALID_ARGUMENT', 'Artifact size or file count limit exceeded');
          files.push({ path: child, bytes: stat.size, signature: this.signature(stat) });
        } else throw new CocosError('INVALID_ARGUMENT', `Unsupported artifact file type: ${child}`);
      }
      if (this.signature(await lstat(path)) !== this.signature(before)) throw new CocosError('OPERATION_CONFLICT', 'Artifact directory changed during inspection');
    };
    await visit('', 0); return { files, directories };
  }
  async inspect(projectPath: string, jobId: string, entryPaths: string[]): Promise<JsonValue> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(jobId)) throw new CocosError('INVALID_ARGUMENT', 'Invalid build job ID');
    if (!Array.isArray(entryPaths) || entryPaths.length < 1 || entryPaths.length > 32 || new Set(entryPaths).size !== entryPaths.length || entryPaths.some(path => typeof path !== 'string' || path.length > 1024 || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..'))) throw new CocosError('INVALID_ARGUMENT', 'Provide 1–32 unique relative entry file paths');
    const paths = await ProjectPaths.open(projectPath);
    // 逐级拒绝链接，连指向同工程的链接也不接受，防止任务输出身份被替换。
    let root = paths.root;
    for (const part of ['.codex-work', 'build', 'creator', jobId]) {
      root = join(root, part); const stat = await lstat(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Build artifact root must be an ordinary directory');
    }
    const before = await this.scan(root), rows: Array<{ path: string; bytes: number; sha256: string }> = [];
    const entries = entryPaths.map(path => ({ path, present: before.files.some(file => file.path === path && file.bytes > 0) }));
    const buffer = Buffer.alloc(1024 * 1024);
    for (const file of before.files) {
      const handle = await open(join(root, file.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (this.signature(await handle.stat()) !== file.signature) throw new CocosError('OPERATION_CONFLICT', 'Artifact file changed before hashing');
        const hash = createHash('sha256'); let total = 0;
        while (true) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
          total += bytesRead; if (total > file.bytes) throw new CocosError('OPERATION_CONFLICT', 'Artifact grew while hashing');
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (total !== file.bytes || this.signature(await handle.stat()) !== file.signature) throw new CocosError('OPERATION_CONFLICT', 'Artifact changed while hashing');
        rows.push({ path: file.path, bytes: total, sha256: hash.digest('hex') });
      } finally { await handle.close(); }
    }
    if (JSON.stringify(await this.scan(root)) !== JSON.stringify(before)) throw new CocosError('OPERATION_CONFLICT', 'Artifact tree changed; inspect again after the build is idle');
    return { jobId, status: rows.length && entries.every(entry => entry.present) ? 'files-verified' : 'incomplete', entries, rows, totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
      manifestHash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), limits: { maxFiles: this.maxFiles, maxBytes: this.maxBytes },
      architecture: 'unverified', installVerified: false, launchVerified: false, limitations: ['入口存在与文件哈希不证明依赖完整、签名有效或设备运行成功', '结果为检查时快照，发布前须重新核对 manifestHash'] };
  }
}
