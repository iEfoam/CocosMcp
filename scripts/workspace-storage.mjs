import { lstat, realpath, mkdir, mkdtemp, open, writeFile, rename, readdir, opendir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** 仅管理本进程新建的测试夹具；历史清单没有删除入口。 */
export class WorkspaceStorage {
  constructor(root, probe = WorkspaceStorage.openReferences) { this.root = resolve(root); this.probe = probe; this.owned = new WeakMap(); }
  async readMarker(path) {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 16384) throw new Error('Invalid ownership marker');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const buffer = Buffer.alloc(16385); let position = 0;
      while (position < buffer.length) {
        const { bytesRead } = await file.read(buffer, position, buffer.length - position, position);
        if (!bytesRead) break; position += bytesRead;
      }
      const after = await file.stat(), current = await lstat(path);
      if (position > 16384 || position !== before.size || [after, current].some(info => !info.isFile() || info.isSymbolicLink() || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size || info.mtimeMs !== before.mtimeMs || info.ctimeMs !== before.ctimeMs)) throw new Error('Ownership marker changed during read');
      return buffer.subarray(0, position).toString('utf8');
    } finally { await file.close(); }
  }
  static async openReferences(directory) {
    try {
      const result = await promisify(execFile)('lsof', ['-nP', '-F', 'p', '+D', directory], { timeout: 5000, maxBuffer: 1024 * 1024 });
      return { clear: false, reason: result.stderr ? 'open-file inspection warning' : 'open file references remain' };
    } catch (error) {
      // lsof 的 1 且无输出表示没有匹配；权限警告、超时或缺少工具均不能推断为无人使用。
      if (error.code === 1 && !error.stdout && !error.stderr) return { clear: true, reason: 'no open file references observed' };
      return { clear: false, reason: 'open-file inspection unavailable or incomplete' };
    }
  }
  async workDirectory(relative) {
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('Invalid workspace directory');
    let directory = await realpath(this.root);
    for (const part of ['.codex-work', ...parts]) {
      directory = join(directory, part);
      try { await lstat(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(directory); }
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Workspace directory must not be a symbolic-link alias');
    }
    return directory;
  }
  async temporaryRoot() { return this.workDirectory('tmp'); }
  async createTestRun() { return this.createRun('test-run', 'isolated regenerable test fixtures', randomUUID()); }
  async createBuildRun(jobId) { return this.createRun('creator-build', 'isolated regenerable Creator CLI configuration', jobId); }
  async createRun(kind, purpose, taskId) {
    if (!['test-run', 'creator-build'].includes(kind) || !/^[a-f\d-]{36}$/.test(taskId)) throw new Error('Invalid temporary task kind or ID');
    const parent = await this.temporaryRoot(), directory = await mkdtemp(join(parent, kind === 'test-run' ? 'tests-' : 'creator-'));
    const owner = { version: 1, taskId, kind, purpose, pid: process.pid,
      createdAtUTC: new Date().toISOString(), state: 'active', retentionReason: 'active task', recyclable: true };
    const identity = await lstat(directory), receipt = { directory, owner, dev: identity.dev, ino: identity.ino };
    await writeFile(join(directory, '.codex-task.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    this.owned.set(receipt, { directory, taskId: owner.taskId, dev: identity.dev, ino: identity.ino });
    return receipt;
  }
  async verify(receipt) {
    const created = this.owned.get(receipt);
    if (!created || created.directory !== receipt.directory || created.taskId !== receipt.owner.taskId || created.dev !== receipt.dev || created.ino !== receipt.ino) throw new Error('Receipt was not created by this runner');
    const parent = await this.temporaryRoot();
    if (!receipt.directory.startsWith(parent + sep) || receipt.directory.slice(parent.length + 1).includes(sep) || receipt.owner.pid !== process.pid || !['test-run', 'creator-build'].includes(receipt.owner.kind) || receipt.owner.recyclable !== true) throw new Error('Task ownership does not match this runner');
    const info = await lstat(receipt.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== receipt.dev || info.ino !== receipt.ino || await realpath(receipt.directory) !== receipt.directory) throw new Error('Owned temporary directory identity changed');
    if (await this.readMarker(join(receipt.directory, '.codex-task.json')) !== JSON.stringify(receipt.owner)) throw new Error('Task ownership marker changed');
  }
  async finish(receipt, succeeded) {
    await this.verify(receipt);
    const owner = { ...receipt.owner, state: succeeded ? 'succeeded' : 'failed', finishedAtUTC: new Date().toISOString(), retentionReason: succeeded ? 'awaiting reference check' : 'failed task diagnostic evidence' };
    const temporary = join(receipt.directory, `.codex-task.${receipt.owner.taskId}.writing`);
    await writeFile(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(receipt.directory, '.codex-task.json')); receipt.owner = owner;
  }
  async cleanup(receipt) {
    await this.verify(receipt);
    if (receipt.owner.state !== 'succeeded') return { removed: false, reason: 'task did not succeed; retain diagnostics' };
    const references = await this.probe(receipt.directory);
    if (!references.clear) return { removed: false, reason: references.reason };
    // 检查期间若所有权或目录身份改变，禁止将原检查结果用于替换后的目录。
    await this.verify(receipt);
    await rm(receipt.directory, { recursive: true });
    return { removed: true, reason: 'owned successful regenerable files; no observed open references' };
  }
  processState(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown';
    try { process.kill(pid, 0); return 'alive'; } catch (error) { return error.code === 'ESRCH' ? 'not-observed' : 'unknown'; }
  }
  async inventory(maxEntries = 250000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('Invalid inventory budget');
    const root = await realpath(this.root), rows = []; let visited = 0;
    const measure = async (path, depth = 0) => {
      if (visited >= maxEntries || depth > 128) return { logicalBytes: 0, allocatedBytes: 0, entries: 0, complete: false };
      visited++; const info = await lstat(path);
      const total = { logicalBytes: info.size, allocatedBytes: (info.blocks ?? 0) * 512, entries: 1, complete: true };
      if (info.isDirectory() && !info.isSymbolicLink()) {
        const directory = await opendir(path);
        for await (const entry of directory) {
          if (visited >= maxEntries) { total.complete = false; break; }
          try {
            const child = await measure(join(path, entry.name), depth + 1);
            total.logicalBytes += child.logicalBytes; total.allocatedBytes += child.allocatedBytes; total.entries += child.entries; total.complete &&= child.complete;
          } catch { total.complete = false; }
        }
      }
      return total;
    };
    for (const category of ['tmp', 'build', 'cache', 'downloads', 'backups', 'logs', 'artifacts']) {
      const directory = join(root, '.codex-work', category);
      let entries;
      try {
        if (await realpath(directory) !== directory) { rows.push({ path: directory, category, complete: false, retentionReason: 'symbolic-link category not traversed', canDelete: false }); continue; }
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) { if (error.code !== 'ENOENT') rows.push({ path: directory, category, complete: false, retentionReason: 'unreadable category', canDelete: false }); continue; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name); let owner = null, size;
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          try {
            {
              const record = JSON.parse(await this.readMarker(join(path, '.codex-task.json')));
              // 历史记录只是自述信息，不作为清理授权或进程归属证明。
              owner = { taskId: record.taskId ?? null, kind: record.kind ?? null, purpose: record.purpose ?? null, pid: record.pid ?? null,
                createdAtUTC: record.createdAtUTC ?? null, state: record.state ?? 'legacy-unverified', processState: this.processState(record.pid) };
            }
          } catch { /* 无有效标记即保持归属未知，不推断可删除。 */ }
        }
        try { size = await measure(path); } catch { size = { complete: false }; }
        const retentionReason = ['backups', 'logs', 'artifacts'].includes(category) ? 'backup, audit or deliverable; preserve'
          : owner?.processState === 'alive' ? 'owner PID exists; activity requires verification'
          : owner?.state === 'failed' ? 'failed task diagnostics'
          : 'historical ownership and references require separate review';
        rows.push({ path, category, ...size, owner, retentionReason, canDelete: false });
      }
    }
    return { createdAtUTC: new Date().toISOString(), root, visited, maxEntries, rows,
      limitations: ['Read-only snapshot; no deletion authorization', 'PID existence does not prove process identity', 'Allocated byte sums can double-count hard links or clones and are not reclaimable physical space', 'Incomplete rows are lower bounds; files may change during inspection'] };
  }
}
