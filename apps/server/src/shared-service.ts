import { parseArgs } from 'node:util';
import { ProjectRegistry } from '../../../packages/application/src/registry.js';
import { ProjectPaths } from '../../../packages/application/src/paths.js';
import { ClientPolicies } from '../../../packages/application/src/client-policy.js';
import { ProjectLocator } from '../../../packages/application/src/project-locator.js';
import { ServiceHost } from './service-host.js';
import { SharedWorkerLifecycle } from './shared-worker-lifecycle.js';

/** 共享进程不属于某个 stdio 父进程；只有租约和实际任务都空闲时才自动退出。 */
class SharedService {
  async run(): Promise<void> {
    const { values } = parseArgs({ options: { project: { type: 'string' }, installation: { type: 'string' } } });
    if (!values.project || !values.installation) throw new Error('Missing --project / --installation');
    const policy = await new ClientPolicies().load(await ProjectPaths.open(values.installation));
    const paths = await new ProjectLocator(policy.allowedRoots).locate(values.project);
    for (const directory of ['tmp', 'cache', 'logs'] as const) await paths.work(directory);
    Object.assign(process.env, paths.environment());
    const projects = new ProjectRegistry(); await projects.add(paths.root);
    const host = new ServiceHost(projects), lifecycle = new SharedWorkerLifecycle(policy.clientLeaseTtlSeconds * 1000, policy.idleExitSeconds * 1000);
    let closing = false;
    const close = async () => { closing = true; lifecycle.stop(); await host.close(); };
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void close().catch(error => console.error(error)); });
    await host.start({ transport: 'http', owner: 'client', sharedControl: lifecycle, allowProjectCode: policy.allowProjectCode });
    if (!closing) lifecycle.start(() => host.busy(), close);
  }
}
void new SharedService().run().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
