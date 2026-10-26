import { CocosMcpServer } from './mcp.js';
import { ProjectRegistry } from '../../../packages/application/src/registry.js';
import { CapabilityCatalog } from '../../../packages/capability-catalog/src/index.js';
import { ProjectRouter } from './project-router.js';
import type { ClientPolicy } from '../../../packages/application/src/client-policy.js';
import type { ProjectConnector } from './project-connector.js';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CocosError } from '../../../packages/contracts/src/index.js';
export { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
export { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';

/** 工具声明共用只读目录；每个会话独立持有连接器、默认工作区和 SDK 请求状态。 */
export class RouterSession {
  private static catalog: CapabilityCatalog | undefined;
  private connectorTask: Promise<ProjectConnector> | undefined;
  private closing = false;
  private inFlight = 0;
  readonly factory: CocosMcpServer;
  constructor(installation: string, workerFile: string, policy: ClientPolicy, workspacePath?: string) {
    const projects = new ProjectRegistry(), catalog = RouterSession.catalog ??= new CapabilityCatalog();
    const connector = (): Promise<ProjectConnector> => this.connectorTask ??= import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'connector.mjs')).href)
      .then(({ ProjectConnector }) => new ProjectConnector(projects, policy, installation, workerFile));
    const routing = {
      projects, catalog, instructions: ProjectRouter.instructions,
      call: (...args: Parameters<ProjectRouter['call']>) => this.run(async () => new ProjectRouter(await connector(), catalog, workspacePath).call(...args)),
      resource: (uri: string) => this.run(async () => new ProjectRouter(await connector(), catalog, workspacePath).resource(uri)),
    };
    this.factory = new CocosMcpServer(undefined, undefined, undefined, false, routing);
  }
  connected(): boolean { return Boolean(this.connectorTask); }
  private async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.closing) throw new CocosError('RESOURCE_BUSY', 'Router session is closing');
    this.inFlight++;
    try { return await task(); } finally { this.inFlight--; }
  }
  async close(): Promise<void> {
    this.closing = true;
    // SDK 关闭已取消当前会话的请求；等待回调收尾后才释放工程租约。
    while (this.inFlight || this.factory.active()) await new Promise(resolve => setTimeout(resolve, 20));
    await (await this.connectorTask)?.close();
  }
}
