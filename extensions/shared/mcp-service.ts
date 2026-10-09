import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import { ProjectPaths } from '../../packages/application/src/paths.js';
import { ServiceConnections } from '../../packages/application/src/service-connections.js';

export interface McpServiceState { status: 'stopped' | 'starting' | 'running' | 'error'; endpoint: string | null; error: string | null; owner?: 'client' | 'extension'; transport?: 'stdio' | 'http'; managed?: boolean; configuredPort?: number }

/** 只管理本扩展启动的子进程，不能停止终端或其他客户端拥有的服务。 */
export class McpService {
  private child: ChildProcess | undefined;
  private pending: Promise<void> | undefined;
  private state: McpServiceState = { status: 'stopped', endpoint: null, error: null };
  constructor(private readonly project: string, private readonly extension: string) {}
  snapshot(): McpServiceState { return { ...this.state }; }
  private async connections(): Promise<ServiceConnections> { return new ServiceConnections(await ProjectPaths.open(this.project)); }
  async inspect(): Promise<McpServiceState> {
    try {
      const connections = await this.connections(), configuredPort = await connections.port(), active = await connections.active();
      if (active) this.state = { status: active.status, endpoint: active.endpoint, error: null, owner: active.owner,
        transport: active.transport, managed: Boolean(this.child && this.child.pid === active.pid), configuredPort };
      else this.state = { ...(this.child || this.state.status === 'error' ? this.state : { status: 'stopped' as const, endpoint: null, error: null }), configuredPort };
    } catch (error) { this.state = { status: 'error', endpoint: null, error: error instanceof Error ? error.message : String(error) }; }
    return this.snapshot();
  }
  private executable(): string {
    const config = JSON.parse(readFileSync(join(this.extension, 'service-config.json'), 'utf8')) as { nodeExecutable?: string };
    if (!config.nodeExecutable || !isAbsolute(config.nodeExecutable) || !existsSync(config.nodeExecutable)) throw new Error('未找到 Node.js，请使用 Node.js 24 或更高版本重新安装扩展');
    return config.nodeExecutable;
  }
  private async environment(): Promise<NodeJS.ProcessEnv> {
    const paths = await ProjectPaths.open(this.project), temporary = await paths.work('tmp', `mcp-service-${process.pid}`);
    for (const directory of ['cache', 'logs'] as const) await paths.work(directory);
    return { ...paths.environment(), TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  }
  async configurePort(value: unknown): Promise<void> {
    if (typeof value !== 'string' || !/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new Error('端口必须为 0～65535 的整数');
    const environment = await this.environment();
    await new Promise<void>((accept, reject) => {
      const child = spawn(this.executable(), [join(this.extension, 'dist/service.mjs'), '--project', this.project, '--configure-port', value],
        { cwd: this.project, shell: false, stdio: ['ignore', 'ignore', 'pipe'], env: environment });
      let details = '';
      child.stderr?.on('data', chunk => { details = (details + String(chunk)).slice(-4000); });
      const timeout = setTimeout(() => { child.kill(); reject(new Error('端口设置超时')); }, 15000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); if (code === 0) accept(); else reject(new Error(details || '端口设置失败')); });
    });
  }
  async configuration(mode: unknown): Promise<string> {
    if (mode === 'stdio') {
      const entry = join(this.extension, 'dist/stdio.mjs');
      if (!existsSync(entry)) throw new Error('离线 stdio 入口未安装，请更新扩展');
      const environment = await this.environment(), env: Record<string, string> = {};
      // 仅复制受控路径与时区，不能把编辑器继承的账号、代理或其他凭证打包进客户端配置。
      for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'NODE_COMPILE_CACHE', 'TZ']) env[key] = environment[key]!;
      return JSON.stringify({ mcpServers: { cocos: { command: this.executable(), args: [entry, '--project', this.project], env } } }, null, 2);
    }
    if (mode !== 'http') throw new Error('不支持的接入方式');
    const connections = await this.connections(), service = await connections.active();
    if (!service || service.status !== 'running' || service.transport !== 'http' || !service.endpoint) throw new Error('请先启动 HTTP MCP 服务');
    // 凭证只交给主进程剪贴板，不通过面板状态、日志或 IPC 返回给渲染进程。
    return JSON.stringify({ mcpServers: { cocos: { url: service.endpoint, headers: { Authorization: `Bearer ${await connections.token(service.tokenFile, false)}` } } } }, null, 2);
  }
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
    const active = await (await this.connections()).active();
    if (active) {
      if (active.transport === 'stdio') throw new Error('此工程的 MCP 服务由 AI 客户端管理，请使用已有连接');
      await this.inspect(); return;
    }
    this.state = { status: 'starting', endpoint: null, error: null, managed: true };
    const child = spawn(this.executable(), [join(this.extension, 'dist/service.mjs'), '--project', this.project], {
      cwd: this.project, shell: false, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: await this.environment(),
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
        this.state = { status: 'running', endpoint: ready.endpoint!, error: null, owner: 'extension', transport: 'http', managed: true }; accept();
      });
    });
  }
  async stop(): Promise<void> {
    // 等待启动完成再停止，避免快速重复点击留下孤儿服务。
    await this.pending?.catch(() => {});
    const child = this.child;
    if (!child) return;
    this.state = { status: 'stopped', endpoint: null, error: null };
    await new Promise<void>(accept => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); accept(); }); child.kill('SIGTERM');
    });
  }
}
