import { parseArgs } from 'node:util';
import { ProjectRegistry } from '../../../packages/application/src/registry.js';
import { ServiceConnections } from '../../../packages/application/src/service-connections.js';
import { ServiceHost } from './service-host.js';

class ManagedService {
  async run(): Promise<void> {
    const { values } = parseArgs({ options: { project: { type: 'string' }, 'configure-port': { type: 'string' } } });
    if (!values.project) throw new Error('Missing project');
    const projects = new ProjectRegistry();
    const project = await projects.add(values.project);
    if (values['configure-port'] !== undefined) { await new ServiceConnections(projects.paths(project.projectId)).configurePort(Number(values['configure-port'])); return; }
    const host = new ServiceHost(projects);
    const close = async (): Promise<void> => { try { await host.close(); } finally { if (process.connected) process.disconnect(); } };
    // 编辑器退出或扩展卸载时 IPC 断开，只有扩展拥有的服务随之退出。
    process.once('disconnect', () => { void close().catch(error => console.error(error)); });
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void close().catch(error => console.error(error)); });
    const endpoint = await host.start({ transport: 'http', owner: 'extension' });
    process.send?.({ type: 'ready', endpoint });
  }
}
void new ManagedService().run().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; if (process.connected) process.disconnect(); });
