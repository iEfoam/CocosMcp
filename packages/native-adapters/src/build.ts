import { BuildArtifacts } from './build-artifacts.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CocosError, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import { AtomicJsonFile } from './atomic-json.js';
import { CreatorLocator } from './creator.js';

interface BuildJob {
  jobId: string; projectId: string; projectPath: string; state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown';
  platform: string; creatorVersion: string; startedAt: string; completedAt?: string;
  exitCode?: number | null; outputPath: string; logPath: string; error?: string;
}

export class BuildJobs {
  private readonly json = new AtomicJsonFile();
  private readonly jobs = new Map<string, BuildJob>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly reports = new Map<string, string>();

  private async indexPath(projectPath: string): Promise<string> {
    const paths = await ProjectPaths.open(projectPath);
    const directory = await paths.work('cache', 'cocos-mcp');
    return join(directory, 'build-jobs.json');
  }

  private async hydrate(projectId: string, projectPath: string): Promise<void> {
    const path = await this.indexPath(projectPath);
    let rows: BuildJob[];
    try { rows = JSON.parse(await readFile(path, 'utf8')) as BuildJob[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    let changed = false;
    for (const row of rows) if (row.projectId === projectId && !this.jobs.has(row.jobId)) {
      // 子进程属于旧服务实例，重启后无法安全推断构建是否仍在执行，必须显式标记为未知失败，避免永久占用工程。
      if (row.state === 'running') { row.state = 'outcome-unknown'; row.error = 'Build state unknown after MCP service restart'; row.completedAt = new Date().toISOString(); changed = true; }
      this.jobs.set(row.jobId, row);
      this.reports.set(row.jobId, join(row.logPath.replace(/\/[^/]+\.log$/, ''), `${row.jobId}.json`));
    }
    if (changed) await this.persist(projectPath);
  }

  private async persist(projectPath: string): Promise<void> {
    const path = await this.indexPath(projectPath);
    const rows = [...this.jobs.values()].filter(row => row.projectPath === projectPath);
    await this.json.write(path, rows);
  }

  async start(projectId: string, projectPath: string, creatorPath: string, platform: string, options: JsonObject = {}): Promise<JsonValue> {
    await this.hydrate(projectId, projectPath);
    if (!/^[a-z][a-z\d-]*$/.test(platform)) throw new CocosError('INVALID_ARGUMENT', 'Invalid build platform');
    if ([...this.jobs.values()].some(job => job.projectId === projectId && job.state === 'running')) throw new CocosError('RESOURCE_BUSY', 'Another build is running for this project');
    const installation = await new CreatorLocator().inspect(creatorPath);
    const paths = await ProjectPaths.open(projectPath); const jobId = randomUUID();
    const outputPath = await paths.work('build', `creator/${jobId}`);
    const temporary = await paths.work('tmp', `creator-${jobId}`);
    // 登录状态必须跨任务保留；按编辑器版本隔离，避免升级污染配置，也不占用 GUI 的用户目录。
    const cache = await paths.work('cache', `creator-build/${installation.version}`);
    const creatorHome = await paths.work('cache', 'creator-home');
    const logs = await paths.work('logs', 'builds'); const logPath = join(logs, `${jobId}.log`);
    for (const reserved of ['project', 'projectPath', 'configPath', 'buildPath', 'dest', 'platform']) if (reserved in options) throw new CocosError('INVALID_ARGUMENT', `Build option is controlled by the runner: ${reserved}`);
    const configPath = join(temporary, 'build.json');
    if (configPath.includes(';')) throw new CocosError('INVALID_ARGUMENT', 'Creator CLI cannot safely encode a config path containing a semicolon');
    await writeFile(configPath, JSON.stringify({ ...options, platform, buildPath: outputPath, outputName: 'game' }, null, 2));
    const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
    const report = join(logs, `${jobId}.json`); this.reports.set(jobId, report);
    const job: BuildJob = { jobId, projectId, projectPath: paths.root, state: 'running', platform, creatorVersion: installation.version, startedAt: new Date().toISOString(), outputPath, logPath };
    this.jobs.set(jobId, job);
    await this.json.write(report, job);
    await this.persist(paths.root);
    await mkdir(join(cache, 'user-data'), { recursive: true });
    // 使用参数数组，不经过 shell；配置文件也避免了 --build 内的参数注入。
    const child = spawn(installation.executable, [...(installation.major === 3 ? ['--home', creatorHome] : []), `--user-data-dir=${join(cache, 'user-data')}`, installation.major === 2 ? '--path' : '--project', paths.root, '--build', `configPath=${configPath}`],
      { cwd: paths.root, env: { ...paths.environment(), TMPDIR: temporary, TMP: temporary, TEMP: temporary, ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    this.children.set(jobId, child); child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false });
    child.once('error', error => { job.error = error.message; });
    child.once('close', (code, signal) => {
      void (async () => {
        this.children.delete(jobId); log.end(); job.exitCode = code; job.completedAt = new Date().toISOString();
        if (job.state !== 'cancelled') {
          const hasOutput = (await readdir(outputPath)).length > 0;
          // Creator 使用 36 表示成功；部分启动链返回 0，仍必须同时存在构建产物。
          job.state = !job.error && !signal && (code === 36 || code === 0) && hasOutput ? 'succeeded' : 'failed';
          if (job.state === 'failed' && !job.error) job.error = `Creator exited with ${code ?? signal}; outputPresent=${hasOutput}`;
        }
        await this.json.write(report, job);
        await this.persist(paths.root);
      })().catch(error => { void (async () => {
        job.state = 'failed'; job.error = String(error); job.completedAt ??= new Date().toISOString();
        await this.json.write(report, job); await this.persist(paths.root);
        console.error('[CocosMCP build]', error);
      })().catch(failure => console.error('[CocosMCP build] Failed to persist failure state', failure)); });
    });
    return JSON.parse(JSON.stringify(job)) as JsonValue;
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
    if (!child || job.state !== 'running') throw new CocosError('OPERATION_CONFLICT', 'Build is not running');
    job.state = 'cancelled'; child.kill('SIGTERM');
    await this.json.write(this.reports.get(jobId)!, job); await this.persist(projectPath); return this.status(projectId, projectPath, jobId);
  }
  async close(): Promise<void> { for (const job of this.jobs.values()) if (job.state === 'running') await this.cancel(job.projectId, job.projectPath, job.jobId); }
}
