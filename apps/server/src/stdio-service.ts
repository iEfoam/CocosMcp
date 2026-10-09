import { parseArgs } from 'node:util';
import { ProjectRegistry } from '../../../packages/application/src/registry.js';
import { ServiceHost } from './service-host.js';

/** 离线扩展包含完整依赖；客户端直接运行此入口，不依赖源码仓库、pnpm 或 IPC 父进程。 */
class StdioService {
  async run(): Promise<void> {
    const { values } = parseArgs({ options: { project: { type: 'string' } } });
    if (!values.project) throw new Error('Missing --project');
    const projects = new ProjectRegistry();
    const project = await projects.add(values.project), paths = projects.paths(project.projectId);
    for (const directory of ['tmp', 'cache', 'logs'] as const) await paths.work(directory);
    Object.assign(process.env, paths.environment());
    const host = new ServiceHost(projects);
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void host.close().catch(error => console.error(error)); });
    await host.start({ transport: 'stdio', owner: 'client' });
  }
}
void new StdioService().run().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
