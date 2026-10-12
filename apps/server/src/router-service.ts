import { rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CocosApplication, ProjectPaths, ProjectRegistry } from '../../../packages/application/src/index.js';
import { ClientPolicies } from '../../../packages/application/src/client-policy.js';
import { CocosMcpServer } from './mcp.js';
import { McpTransport } from './transport.js';
import { ProjectConnector } from './project-connector.js';
import { ProjectRouter } from './project-router.js';

export class RouterService {
  async run(installationPath: string, workspaceRoot: string, workerFile: string): Promise<void> {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Unified Cocos MCP requires Node.js 24 or higher');
    const installation = await ProjectPaths.open(installationPath), workspace = await ProjectPaths.open(workspaceRoot);
    const policy = await new ClientPolicies().load(installation);
    const temporary = await workspace.work('tmp', `cocos-client-${process.pid}-${randomUUID()}`);
    for (const directory of ['cache', 'logs'] as const) await workspace.work(directory);
    Object.assign(process.env, { ...workspace.environment(), TMPDIR: temporary, TMP: temporary, TEMP: temporary });
    const projects = new ProjectRegistry(), connector = new ProjectConnector(projects, policy, installation.root, workerFile), transport = new McpTransport();
    // 此输入须由宿主显式绑定到本次 stdio 会话；安装 workspaceRoot 只用于客户端运行状态落盘。
    const router = new ProjectRouter(connector, undefined, process.env.COCOS_WORKSPACE_PATH), factory = new CocosMcpServer(new CocosApplication(projects), undefined, undefined, false, router);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      await connector.close(); await transport.close();
      await rmdir(temporary).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; });
    })();
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void close().catch(error => console.error('[CocosMCP client]', String(error))); });
    process.stdin.once('end', () => { void close().catch(error => console.error('[CocosMCP client]', String(error))); });
    // 初始化无需工程、端口、工程锁或 Creator；仅在工具连接工程时创建对应后端。
    transport.startStdio(factory);
  }
}
