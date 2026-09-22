import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export interface McpServiceState { status: 'stopped' | 'starting' | 'running' | 'error'; endpoint: string | null; error: string | null }

/** 只管理本扩展启动的子进程，不能停止终端或其他客户端拥有的服务。 */
export class McpService {
  private child: ChildProcess | undefined;
  private pending: Promise<void> | undefined;
  private state: McpServiceState = { status: 'stopped', endpoint: null, error: null };
  constructor(private readonly project: string, private readonly extension: string) {}
  snapshot(): McpServiceState { return { ...this.state }; }
  start(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.child) return Promise.resolve();
    this.pending = this.launch().catch(error => {
      this.state = { status: 'error', endpoint: null, error: error instanceof Error ? error.message : String(error) };
      throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async launch(): Promise<void> {
    const work = join(this.project, '.codex-work');
    const directory = join(work, 'cache/cocos-mcp');
    if (existsSync(directory)) for (const name of readdirSync(directory)) {
      const match = /^runtime-(\d+)\.json$/.exec(name);
      if (!match) continue;
      let alive = false;
      try { process.kill(Number(match[1]), 0); alive = true; } catch { /* 已退出的网关配置不阻止重新启动。 */ }
      if (alive) throw new Error('此工程已有运行时网关，请先停止外部 MCP 服务，避免重复启动');
    }
    const config = JSON.parse(readFileSync(join(this.extension, 'service-config.json'), 'utf8')) as { nodeExecutable: string };
    if (!config.nodeExecutable || !existsSync(config.nodeExecutable)) throw new Error('未找到 Node.js，请使用 Node.js 24 或更高版本重新安装扩展');
    for (const path of ['tmp', 'cache', 'logs']) mkdirSync(join(work, path), { recursive: true });
    this.state = { status: 'starting', endpoint: null, error: null };
    const child = spawn(config.nodeExecutable, [join(this.extension, 'dist/service.mjs'), '--project', this.project], {
      cwd: this.project, shell: false, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, TMPDIR: join(work, 'tmp'), TMP: join(work, 'tmp'), TEMP: join(work, 'tmp'), XDG_CACHE_HOME: join(work, 'cache'), NODE_COMPILE_CACHE: join(work, 'cache/node'), TZ: 'UTC' },
    });
    this.child = child;
    let details = '';
    child.stderr?.on('data', chunk => { details = (details + String(chunk)).slice(-4000); });
    await new Promise<void>((accept, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('MCP 服务启动超时')); }, 15000);
      child.once('error', error => { clearTimeout(timeout); this.child = undefined; reject(error); });
      child.once('exit', code => {
        clearTimeout(timeout); this.child = undefined;
        const error = `MCP 服务已退出 (${code ?? 'signal'})${details ? ': ' + details : ''}`;
        if (this.state.status !== 'stopped') this.state = { status: 'error', endpoint: null, error };
        reject(new Error(error));
      });
      child.on('message', message => {
        const ready = message as { type?: string; endpoint?: string };
        if (ready.type !== 'ready' || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(ready.endpoint ?? '')) return;
        clearTimeout(timeout);
        this.state = { status: 'running', endpoint: ready.endpoint!, error: null }; accept();
      });
    });
  }
  async stop(): Promise<void> {
    // 等待启动完成再停止，避免快速重复点击留下孤儿服务。
    await this.pending?.catch(() => {});
    const child = this.child;
    this.state = { status: 'stopped', endpoint: null, error: null };
    if (!child) return;
    await new Promise<void>(accept => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); accept(); }); child.kill('SIGTERM');
    });
  }
}
