import { BuildArtifacts } from './build-artifacts.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import { AtomicJsonFile } from './atomic-json.js';
import { CreatorLocator } from './creator.js';
import { CreatorAccount } from '../../../scripts/creator-account.mjs';
import { OperationAudit } from '../../application/src/operation-audit.js';

interface BuildJob {
  jobId: string; projectId: string; projectPath: string; state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown';
  platform: string; creatorVersion: string; startedAt: string; completedAt?: string;
  exitCode?: number | null; outputPath: string; logPath: string; error?: string;
  operationId?: string; requestHash?: string; childPid?: number; spawnAttempted?: boolean; recoveryRequired?: boolean;
}

export class BuildJobs {
  constructor(private readonly account = new CreatorAccount()) {}
  private readonly json = new AtomicJsonFile();
  private readonly jobs = new Map<string, BuildJob>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly reports = new Map<string, string>();
  private readonly admissions = new Set<string>();
  private readonly requests = new Map<string, { hash: string; task: Promise<JsonValue> }>();
  private readonly hydration = new Map<string, Promise<void>>();
  private readonly preparations = new Set<Promise<JsonValue>>();
  private readonly completions = new Set<Promise<void>>();
  private readonly audit = new OperationAudit();
  private closing = false;

  private async indexPath(projectPath: string): Promise<string> {
    const paths = await ProjectPaths.open(projectPath);
    const directory = await paths.work('cache', 'cocos-mcp');
    return join(directory, 'build-jobs.json');
  }

  private async hydrate(projectId: string, projectPath: string): Promise<void> {
    let loading = this.hydration.get(projectId);
    if (!loading) { loading = this.load(projectId, projectPath); this.hydration.set(projectId, loading); }
    try { await loading; } catch (error) { this.hydration.delete(projectId); throw error; }
  }

  private async load(projectId: string, projectPath: string): Promise<void> {
    const path = await this.indexPath(projectPath);
    const paths = await ProjectPaths.open(projectPath);
    let rows: BuildJob[];
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new CocosError('VERIFICATION_FAILED', 'Invalid build index'); rows = JSON.parse(await readFile(path, 'utf8')) as BuildJob[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!Array.isArray(rows) || rows.length > 10000) throw new CocosError('VERIFICATION_FAILED', 'Invalid build index rows');
    let changed = false;
    for (const row of rows) {
      if (!row || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(row.jobId) || row.projectPath !== paths.root || !['running', 'succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(row.state) || typeof row.logPath !== 'string' || row.childPid !== undefined && (!Number.isInteger(row.childPid) || row.childPid < 1)) throw new CocosError('VERIFICATION_FAILED', 'Invalid persisted build job');
      const logPath = await paths.resolve(row.logPath);
      if (!logPath.startsWith(join(paths.root, '.codex-work/logs') + sep)) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Build log must remain inside project logs');
      if (row.projectId !== projectId || this.jobs.has(row.jobId)) continue;
      // 旧构建可能仍占用持久账号目录；未知结果不能直接解除占用并启动第二个构建。
      if (row.state === 'running') { row.state = row.spawnAttempted === false ? 'failed' : 'outcome-unknown'; row.recoveryRequired = row.spawnAttempted !== false && (!row.childPid || this.alive(row.childPid)); row.error = 'Build state unknown after MCP service restart'; row.completedAt = new Date().toISOString(); changed = true; }
      this.jobs.set(row.jobId, row);
      this.reports.set(row.jobId, await paths.resolve(join(dirname(logPath), `${row.jobId}.json`)));
    }
    if (changed) await this.persist(projectPath);
  }

  private async persist(projectPath: string): Promise<void> {
    const path = await this.indexPath(projectPath);
    const rows = [...this.jobs.values()].filter(row => row.projectPath === projectPath);
    await this.json.write(path, rows);
  }

  async start(projectId: string, projectPath: string, creatorPath: string, platform: string, options: JsonObject = {}, operationId?: string): Promise<JsonValue> {
    if (this.closing) throw new CocosError('RESOURCE_BUSY', 'Build runner is closing');
    if (operationId !== undefined && !/^[a-zA-Z0-9:_-]{1,128}$/.test(operationId)) throw new CocosError('INVALID_ARGUMENT', 'Invalid build operationId');
    const hash = createHash('sha256').update(Json.canonical({ projectPath, creatorPath, platform, options })).digest('hex');
    const key = operationId ? `${projectId}:${operationId}` : undefined, pending = key ? this.requests.get(key) : undefined;
    if (pending) { if (pending.hash !== hash) throw new CocosError('OPERATION_CONFLICT', 'Build operationId has different parameters'); return pending.task; }
    // 必须在任何 await 前预留启动名额，覆盖定位编辑器、读取账号及创建配置期间的并发请求。
    if (this.admissions.has(projectId)) throw new CocosError('RESOURCE_BUSY', 'Another build is being prepared for this project');
    this.admissions.add(projectId);
    const task = this.launch(projectId, projectPath, creatorPath, platform, options, operationId, hash).catch(async error => {
      for (const job of this.jobs.values()) if (job.projectId === projectId && job.state === 'running' && !this.children.has(job.jobId)) {
        job.state = job.spawnAttempted ? 'outcome-unknown' : 'failed'; job.recoveryRequired = Boolean(job.spawnAttempted); job.error = 'Build preparation failed'; job.completedAt = new Date().toISOString();
        await this.json.write(this.reports.get(job.jobId)!, job); await this.persist(projectPath);
      }
      throw error;
    }).finally(() => { this.admissions.delete(projectId); this.preparations.delete(task); if (key) this.requests.delete(key); });
    this.preparations.add(task);
    if (key) this.requests.set(key, { hash, task });
    return task;
  }

  private async launch(projectId: string, projectPath: string, creatorPath: string, platform: string, options: JsonObject, operationId: string | undefined, requestHash: string): Promise<JsonValue> {
    await this.hydrate(projectId, projectPath);
    const previous = operationId ? [...this.jobs.values()].find(job => job.projectId === projectId && job.operationId === operationId) : undefined;
    if (previous) {
      if (previous.requestHash !== requestHash) throw new CocosError('OPERATION_CONFLICT', 'Build operationId has different parameters');
      return Json.value(previous);
    }
    if (!/^[a-z][a-z\d-]*$/.test(platform)) throw new CocosError('INVALID_ARGUMENT', 'Invalid build platform');
    for (const job of this.jobs.values()) if (job.projectId === projectId) {
      if (job.recoveryRequired && job.childPid && !this.alive(job.childPid)) { job.recoveryRequired = false; await this.persist(projectPath); }
      if (job.state === 'running' || job.recoveryRequired) throw new CocosError('RESOURCE_BUSY', 'Another build is running or requires recovery; inspect its job before starting again', { jobId: job.jobId, recoveryRequired: Boolean(job.recoveryRequired) });
    }
    const installation = await new CreatorLocator().inspect(creatorPath);
    const paths = await ProjectPaths.open(projectPath); const jobId = randomUUID();
    const outputPath = await paths.work('build', `creator/${jobId}`);
    const temporary = await paths.work('tmp', `creator-${jobId}`);
    // 登录状态必须跨任务保留；按编辑器版本隔离，避免升级污染配置，也不占用 GUI 的用户目录。
    const cache = await paths.work('cache', `creator-build/${installation.version}`);
    const account = installation.major === 3 ? await this.account.prepare(paths.root, 3) : { ...await this.account.local(2), home: '' };
    // 2.x 的 CLI 不继承 Dashboard 会话，缺少其原生账号时启动只会产生重复登录窗口。
    if (account.account === 'unavailable') throw new CocosError('UNAUTHORIZED', installation.major === 2
      ? 'Creator 2 CLI has no reusable native account. Use the already signed-in Dashboard and its editor build entry.'
      : 'No reusable Creator 3 native session. Inspect the preserved project account profile; another login window was not started.');
    const creatorHome = account.home;
    const logs = await paths.work('logs', 'builds'); const logPath = join(logs, `${jobId}.log`);
    for (const reserved of ['project', 'projectPath', 'configPath', 'buildPath', 'dest', 'platform']) if (reserved in options) throw new CocosError('INVALID_ARGUMENT', `Build option is controlled by the runner: ${reserved}`);
    const configPath = join(temporary, 'build.json');
    if (configPath.includes(';')) throw new CocosError('INVALID_ARGUMENT', 'Creator CLI cannot safely encode a config path containing a semicolon');
    await writeFile(configPath, JSON.stringify({ ...options, platform, buildPath: outputPath, outputName: 'game' }, null, 2));
    if (this.closing) throw new CocosError('CANCELLED', 'Build runner closed during preparation');
    // 构建与编辑器写操作共用持久 operationId 空间，防止同一 ID 被绑定到不同能力。
    const recovery = operationId ? await this.audit.reserve(paths, operationId, requestHash, { capabilityId: 'build.start', projectId, startedAt: new Date().toISOString() }) : undefined;
    const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
    log.on('error', error => { console.error('[CocosMCP build log]', error.message); });
    const report = join(logs, `${jobId}.json`); this.reports.set(jobId, report);
    const job: BuildJob = { jobId, projectId, projectPath: paths.root, state: 'running', platform, creatorVersion: installation.version, startedAt: new Date().toISOString(), outputPath, logPath, spawnAttempted: false,
      ...(operationId ? { operationId, requestHash } : {}) };
    this.jobs.set(jobId, job);
    try {
      await this.json.write(report, job);
      await this.persist(paths.root);
      await mkdir(join(cache, 'user-data'), { recursive: true });
      if (this.closing) throw new CocosError('CANCELLED', 'Build runner closed before dispatch');
    // 先落盘派发意图；若进程恰好在 spawn 前后崩溃，恢复方保守地保留未知状态。
    job.spawnAttempted = true; await this.persist(paths.root);
    if (this.closing) { job.spawnAttempted = false; throw new CocosError('CANCELLED', 'Build runner closed before dispatch'); }
    // 使用参数数组，不经过 shell；配置文件也避免了 --build 内的参数注入。
    const child = spawn(installation.executable, [...(installation.major === 3 ? ['--home', creatorHome] : []), `--user-data-dir=${join(cache, 'user-data')}`, installation.major === 2 ? '--path' : '--project', paths.root, '--build', `configPath=${configPath}`],
      { cwd: paths.root, env: { ...paths.environment(), TMPDIR: temporary, TMP: temporary, TEMP: temporary, ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    this.children.set(jobId, child); child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false });
    if (child.pid) job.childPid = child.pid;
    child.once('error', error => { job.error = error.message; });
    child.once('close', (code, signal) => {
      const completing = (async () => {
        log.end(); job.exitCode = code; job.completedAt = new Date().toISOString();
        if (job.state !== 'cancelled') {
          const hasOutput = (await readdir(outputPath)).length > 0;
          // Creator 使用 36 表示成功；部分启动链返回 0，仍必须同时存在构建产物。
          job.state = !job.error && !signal && (code === 36 || code === 0) && hasOutput ? 'succeeded' : 'failed';
          if (job.state === 'failed' && !job.error) job.error = `Creator exited with ${code ?? signal}; outputPresent=${hasOutput}`;
        }
        await this.json.write(report, job);
        await this.persist(paths.root);
        if (recovery) await this.audit.finish(recovery, { status: job.state === 'succeeded' ? 'completed' : 'failed', resultAvailable: true, completedAt: job.completedAt });
      })().catch(async error => {
        job.state = 'failed'; job.error = String(error); job.completedAt ??= new Date().toISOString();
        await this.json.write(report, job); await this.persist(paths.root);
        console.error('[CocosMCP build]', error);
      }).catch(failure => console.error('[CocosMCP build] Failed to persist failure state', failure)).finally(() => { this.children.delete(jobId); this.completions.delete(completing); });
      this.completions.add(completing);
    });
    await this.json.write(report, job); await this.persist(paths.root);
    return JSON.parse(JSON.stringify(job)) as JsonValue;
    } catch (error) { if (!this.children.has(jobId)) log.end(); throw error; }
  }

  private get(projectId: string, jobId: string): BuildJob {
    const job = this.jobs.get(jobId);
    if (!job || job.projectId !== projectId) throw new CocosError('NOT_FOUND', 'Build job not found in this project');
    return job;
  }

  async status(projectId: string, projectPath: string, jobId: string): Promise<JsonValue> {
    await this.hydrate(projectId, projectPath); return JSON.parse(JSON.stringify(this.get(projectId, jobId))) as JsonValue;
  }
  async list(projectId: string, projectPath: string): Promise<JsonValue> {
    await this.hydrate(projectId, projectPath);
    return { rows: [...this.jobs.values()].filter(job => job.projectId === projectId).map(job => JSON.parse(JSON.stringify(job)) as JsonValue) };
  }
  async artifacts(projectId: string, projectPath: string, jobId: string, entryPaths: string[]): Promise<JsonValue> {
    await this.hydrate(projectId, projectPath);
    const job = this.get(projectId, jobId);
    if (job.state !== 'succeeded') throw new CocosError('OPERATION_CONFLICT', 'Only successful, completed build jobs can be inspected');
    const result = await new BuildArtifacts().inspect(projectPath, jobId, entryPaths);
    return { ...result as JsonObject, platform: job.platform, creatorVersion: job.creatorVersion };
  }
  async logs(projectId: string, projectPath: string, jobId: string, offset = 0, limit = 200): Promise<JsonValue> {
    await this.hydrate(projectId, projectPath);
    const job = this.get(projectId, jobId); const lines = (await readFile(job.logPath, 'utf8')).split(/\r?\n/);
    return { rows: lines.slice(offset, offset + limit), total: lines.length, nextOffset: offset + limit < lines.length ? offset + limit : null };
  }
  async cancel(projectId: string, projectPath: string, jobId: string): Promise<JsonValue> {
    await this.hydrate(projectId, projectPath);
    const job = this.get(projectId, jobId); const child = this.children.get(jobId);
    if (job.state === 'cancelled') return Json.value(job);
    if (!child || job.state !== 'running') throw new CocosError('OPERATION_CONFLICT', 'Build is not running');
    job.state = 'cancelled'; child.kill('SIGTERM');
    await this.json.write(this.reports.get(jobId)!, job); await this.persist(projectPath); return this.status(projectId, projectPath, jobId);
  }
  private alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
  active(): boolean { return this.admissions.size > 0 || this.children.size > 0 || this.completions.size > 0 || [...this.jobs.values()].some(job => job.recoveryRequired && job.childPid && this.alive(job.childPid)); }
  async operation(projectId: string, projectPath: string, operationId: string): Promise<JsonValue | undefined> {
    await this.hydrate(projectId, projectPath);
    const job = [...this.jobs.values()].find(row => row.projectId === projectId && row.operationId === operationId);
    if (!job) return undefined;
    return { operationId, status: job.state === 'running' ? 'pending' : job.state === 'outcome-unknown' ? 'unknown' : job.state === 'succeeded' ? 'completed' : 'failed', build: Json.value(job) };
  }
  async recover(projectId: string, projectPath: string, jobId: string): Promise<JsonValue> {
    await this.hydrate(projectId, projectPath); const job = this.get(projectId, jobId);
    if (job.state !== 'outcome-unknown' || !job.recoveryRequired) throw new CocosError('OPERATION_CONFLICT', 'Build does not require recovery');
    // PID 存活时不能因人工确认就解除保护，更不能自动终止一个可能已被系统复用的 PID。
    if (job.childPid && this.alive(job.childPid)) throw new CocosError('RESOURCE_BUSY', 'Recorded build PID is still alive; inspect and stop the original build before recovery');
    job.recoveryRequired = false; await this.json.write(this.reports.get(jobId)!, job); await this.persist(projectPath); return Json.value(job);
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.preparations);
    // 关闭期间仍持有工程锁；等待子进程真正退出，不能把账号目录交给第二个服务。
    await Promise.all([...this.children].map(async ([id, child]) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = new Promise<void>(resolve => child.once('close', () => resolve()));
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { const job = this.jobs.get(id)!; if (job.state === 'running') await this.cancel(job.projectId, job.projectPath, id); }
      finally { await done; clearTimeout(timer); }
    }));
    await Promise.allSettled(this.completions);
  }
}
