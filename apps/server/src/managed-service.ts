import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CocosApplication, ProjectRegistry } from '../../../packages/application/src/index.js';
import { RuntimeGateway } from '../../../packages/application/src/runtime-gateway.js';
import { BuildJobs } from '../../../packages/native-adapters/src/build.js';
import { CocosMcpServer } from './mcp.js';
import { McpTransport } from './transport.js';

class ManagedService {
  async run(): Promise<void> {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('MCP 服务需要 Node.js 24 或更高版本');
    const { values } = parseArgs({ options: { project: { type: 'string' } } });
    if (!values.project) throw new Error('Missing project');
    const projects = new ProjectRegistry();
    const project = await projects.add(values.project);
    const gateway = new RuntimeGateway(projects);
    const transport = new McpTransport();
    const builds = new BuildJobs();
    let closing = false;
    const close = async (): Promise<void> => {
      if (closing) return; closing = true;
      await transport.close(); await gateway.close(); await builds.close();
      if (process.connected) process.disconnect();
    };
    // 编辑器退出或扩展卸载时 IPC 断开，服务随拥有者退出。
    process.once('disconnect', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
    process.once('SIGINT', () => { void close(); });
    try {
      await gateway.start();
      const directory = await projects.paths(project.projectId).work('cache', 'cocos-mcp');
      const tokenPath = join(directory, 'mcp-http-token');
      let token: string;
      try { token = (await readFile(tokenPath, 'utf8')).trim(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        token = randomBytes(32).toString('hex'); await writeFile(tokenPath, token, { flag: 'wx', mode: 0o600 });
      }
      if (token.length < 32) throw new Error('Invalid MCP authentication token');
      const application = new CocosApplication(projects, undefined, undefined, false, gateway);
      const port = await transport.startHttp(new CocosMcpServer(application, gateway, builds, false), 0, token);
      process.send?.({ type: 'ready', endpoint: `http://127.0.0.1:${port}/mcp` });
    } catch (error) { await close(); throw error; }
  }
}
void new ManagedService().run().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; if (process.connected) process.disconnect(); });
