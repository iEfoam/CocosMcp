import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CocosError } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import { AtomicJsonFile } from './atomic-json.js';
import { FileSnapshots } from './file-snapshot.js';

export interface BuildJob {
  jobId: string; projectId: string; projectPath: string; state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown';
  platform: string; creatorVersion: string; startedAt: string; completedAt?: string;
  exitCode?: number | null; outputPath: string; logPath: string; error?: string;
  operationId?: string; requestHash?: string; childPid?: number; spawnAttempted?: boolean; recoveryRequired?: boolean;
}

interface HistoryIndex { version: 1; summary: BuildJob; digest: string; summaryDigest: string }

/** 单任务索引原子提交到不可变完整记录；旧索引保留，不通过删除历史来释放容量。 */
export class BuildHistory {
  constructor(private readonly json: Pick<AtomicJsonFile, 'write'> = new AtomicJsonFile()) {}
  private readonly references = new Map<string, { root: string; digest: string; summaryDigest: string }>();
  private readonly pending = new Map<string, Promise<void>>();
  private key(root: string, id: string): string { return `${root}\0${id}`; }
  private id(value: string): void {
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(value)) throw new CocosError('VERIFICATION_FAILED', 'Invalid build history job ID');
  }
  private async read(path: string, maxBytes: number): Promise<unknown> {
    return JSON.parse((await new FileSnapshots().read(path, maxBytes, true)).text!) as unknown;
  }
  async load(root: string): Promise<BuildJob[]> {
    const paths = await ProjectPaths.open(root), cache = await paths.work('cache', 'cocos-mcp');
    const rows = new Map<string, BuildJob>();
    try {
      const legacy = await this.read(join(cache, 'build-jobs.json'), 16 * 1024 * 1024);
      if (!Array.isArray(legacy) || legacy.length > 10000) throw new CocosError('VERIFICATION_FAILED', 'Invalid legacy build index rows');
      for (const row of legacy as BuildJob[]) { this.id(row?.jobId); if (rows.has(row.jobId)) throw new CocosError('VERIFICATION_FAILED', 'Duplicate legacy build job'); rows.set(row.jobId, row); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const directory = await paths.work('cache', 'cocos-mcp/build-history');
    for (const shard of await readdir(directory, { withFileTypes: true })) {
      if (!/^[a-f\d]{2}$/.test(shard.name) || !shard.isDirectory() || shard.isSymbolicLink()) throw new CocosError('VERIFICATION_FAILED', 'Invalid build history shard');
      const shardPath = await paths.resolve(join(directory, shard.name));
      for (const entry of await readdir(shardPath, { withFileTypes: true })) {
        // AtomicJsonFile 崩溃可能留下 writing 文件；不是提交索引，保留供诊断但不读取。
        if (/^[a-f\d-]+\.json\.[a-f\d]{32}\.writing$/.test(entry.name) && entry.isFile()) continue;
        const id = entry.name.slice(0, -5); this.id(id);
        if (entry.name !== id + '.json' || id.slice(0, 2) !== shard.name || !entry.isFile() || entry.isSymbolicLink()) throw new CocosError('VERIFICATION_FAILED', 'Invalid build history index');
        const record = await this.read(await paths.resolve(join(shardPath, entry.name)), 64 * 1024) as HistoryIndex;
        if (record?.version !== 1 || record.summary?.jobId !== id || 'error' in record.summary || !/^[a-f\d]{64}$/.test(record.digest)
          || createHash('sha256').update(JSON.stringify(record.summary)).digest('hex') !== record.summaryDigest) throw new CocosError('VERIFICATION_FAILED', 'Invalid build history reference');
        rows.set(id, record.summary); this.references.set(this.key(paths.root, id), { root: paths.root, digest: record.digest, summaryDigest: record.summaryDigest });
      }
    }
    return [...rows.values()];
  }
  async detail(job: BuildJob): Promise<BuildJob> {
    const reference = this.references.get(this.key(job.projectPath, job.jobId));
    if (!reference) return job;
    const paths = await ProjectPaths.open(reference.root);
    const path = await paths.resolve(join(reference.root, '.codex-work/logs/build-history', job.jobId, reference.digest + '.json'));
    const record = await this.read(path, 16 * 1024 * 1024) as BuildJob;
    if (!record || typeof record !== 'object' || Array.isArray(record) || createHash('sha256').update(JSON.stringify(record)).digest('hex') !== reference.digest || record.jobId !== job.jobId || record.projectPath !== job.projectPath || record.projectId !== job.projectId) throw new CocosError('VERIFICATION_FAILED', 'Build history record digest or identity mismatch');
    const { error: _error, ...summary } = record;
    if (createHash('sha256').update(JSON.stringify(summary)).digest('hex') !== reference.summaryDigest) throw new CocosError('VERIFICATION_FAILED', 'Build history summary disagrees with its record');
    // 内存中可能已有尚在持久化的更新；详细错误来自完整记录，其余字段以当前任务状态为准。
    return { ...record, ...job };
  }
  async save(job: BuildJob): Promise<void> {
    this.id(job.jobId);
    const snapshot = JSON.parse(JSON.stringify(job)) as BuildJob, key = this.key(job.projectPath, job.jobId);
    if (Buffer.byteLength(JSON.stringify(snapshot, null, 2)) > 16 * 1024 * 1024) throw new CocosError('RESOURCE_BUSY', 'Build history record exceeds 16 MiB');
    const { error: _error, ...summary } = snapshot;
    if (Buffer.byteLength(JSON.stringify(summary)) > 60 * 1024) throw new CocosError('RESOURCE_BUSY', 'Build history summary exceeds 60 KiB');
    const previous = this.pending.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const paths = await ProjectPaths.open(snapshot.projectPath);
      if (paths.root !== snapshot.projectPath) throw new CocosError('VERIFICATION_FAILED', 'Build history requires the canonical project path');
      const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      const summaryDigest = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
      const directory = await paths.work('logs', `build-history/${snapshot.jobId}`);
      const indexDirectory = await paths.work('cache', `cocos-mcp/build-history/${snapshot.jobId.slice(0, 2)}`);
      const record = await paths.resolve(join(directory, digest + '.json'));
      // 先保存完整记录再提交引用；失败只会留下未引用记录，不能把半份报告当作成功状态。
      await this.json.write(record, snapshot);
      await this.json.write(await paths.resolve(join(indexDirectory, snapshot.jobId + '.json')), { version: 1, summary, digest, summaryDigest });
      this.references.set(key, { root: paths.root, digest, summaryDigest });
    });
    this.pending.set(key, task);
    try { await task; } finally { if (this.pending.get(key) === task) this.pending.delete(key); }
  }
}
