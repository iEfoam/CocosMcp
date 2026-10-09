import { CocosApplication, ProjectRegistry } from '../../../packages/application/src/index.js';
import { ServiceConnections, type ServiceLease } from '../../../packages/application/src/service-connections.js';
import { RuntimeGateway } from '../../../packages/application/src/runtime-gateway.js';
import { BuildJobs } from '../../../packages/native-adapters/src/build.js';
import { CocosError } from '../../../packages/contracts/src/index.js';
import { CocosMcpServer } from './mcp.js';
import { McpTransport } from './transport.js';

interface ServiceOptions {
  transport: 'stdio' | 'http'; owner: 'client' | 'extension'; port?: number; tokenFile?: string;
  runtime?: boolean; allowProjectCode?: boolean; allTools?: boolean;
}

/** CLI、离线 stdio 和面板共享同一启动/退出流程，服务归属不随面板打开关闭变化。 */
export class ServiceHost {
  private readonly transport = new McpTransport();
  private readonly builds = new BuildJobs();
  private gateway: RuntimeGateway | undefined;
  private readonly leases: ServiceLease[] = [];
  private closing: Promise<void> | undefined;
  private starting: Promise<string | null> | undefined;
  private cleaning: Promise<void> | undefined;
  constructor(private readonly projects: ProjectRegistry) {}
  start(options: ServiceOptions): Promise<string | null> {
    if (this.starting) return this.starting;
    if (this.closing) return Promise.reject(new CocosError('RESOURCE_BUSY', 'MCP service is closing'));
    this.starting = this.launch(options);
    return this.starting;
  }
  private async launch(options: ServiceOptions): Promise<string | null> {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('MCP 服务需要 Node.js 24 或更高版本');
    const connections = this.projects.list().rows.map(row => new ServiceConnections(this.projects.paths(row.projectId)));
    if (!connections.length) throw new CocosError('INVALID_ARGUMENT', 'Missing project');
    try {
      for (const connection of [...connections].sort((a, b) => a.projectId.localeCompare(b.projectId))) {
        this.leases.push(await connection.claim(options.transport, options.owner, connection === connections[0] ? options.tokenFile : undefined));
      }
      if (options.runtime !== false) { this.gateway = new RuntimeGateway(this.projects); console.error(`[CocosMCP] Development runtime gateway: 127.0.0.1:${await this.gateway.start()}`); }
      const application = new CocosApplication(this.projects, undefined, undefined, options.allowProjectCode ?? false, this.gateway);
      const factory = new CocosMcpServer(application, this.gateway, this.builds, options.allTools ?? false);
      let endpoint: string | null = null;
      if (options.transport === 'http') {
        const saved = [...new Set((await Promise.all(connections.map(connection => connection.port()))).filter(port => port > 0))];
        if (options.port === undefined && saved.length > 1) throw new CocosError('OPERATION_CONFLICT', 'Projects have different saved HTTP ports; start them separately or choose --port explicitly');
        const requested = options.port ?? saved[0] ?? 0;
        let port: number;
        try { port = await this.transport.startHttp(factory, requested, this.leases.map(lease => lease.token())); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new CocosError('RESOURCE_BUSY', `MCP 端口 ${requested} 已被占用；请释放端口或显式修改连接配置，不会自动切换端口`);
          throw error;
        }
        endpoint = `http://127.0.0.1:${port}/mcp`;
        for (const connection of connections) await connection.savePort(port);
      }
      for (const lease of this.leases) await lease.publish(endpoint);
      if (options.transport === 'stdio') { this.transport.startStdio(factory); process.stdin.once('end', () => { void this.close().catch(error => console.error(error)); }); }
      return endpoint;
    } catch (error) { await this.cleanup(); throw error; }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      // 等待启动收尾，避免退出信号发生在网关赋值前而遗漏后来创建的资源。
      await this.starting?.catch(() => {});
      await this.cleanup();
    })();
    return this.closing;
  }
  private cleanup(): Promise<void> {
    return this.cleaning ??= this.releaseResources();
  }
  private async releaseResources(): Promise<void> {
    const results = await Promise.allSettled([this.transport.close(), this.gateway?.close(), this.builds.close()]);
    const released = await Promise.allSettled(this.leases.map(lease => lease.close()));
    const failure = [...results, ...released].find(row => row.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
