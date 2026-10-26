import { basename, dirname, join } from 'node:path';
import { open, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { ProjectPaths } from '../../../packages/application/src/paths.js';
import { ServiceConnections, type ServiceDescriptor } from '../../../packages/application/src/service-connections.js';
import { CocosError } from '../../../packages/contracts/src/index.js';

/** 每个不可变客户端版本只有一个路由服务；升级不抢占旧会话持有的服务。 */
export class RouterRuntime {
  async connections(workspace: ProjectPaths, workerFile: string): Promise<ServiceConnections> {
    const version = basename(dirname(workerFile));
    if (!/^[a-f\d]{16}$/.test(version)) throw new CocosError('VERIFICATION_FAILED', 'Router requires an installed immutable client version');
    return new ServiceConnections(await ProjectPaths.open(await workspace.work('cache', `cocos-router/${version}`)));
  }
  async ensure(installation: string, workspace: ProjectPaths, workerFile: string): Promise<{ descriptor: ServiceDescriptor; token: string }> {
    const connections = await this.connections(workspace, workerFile), deadline = performance.now() + 15_000;
    let launched = false;
    while (performance.now() < deadline) {
      let active: ServiceDescriptor | null | undefined;
      try { active = await connections.active(); }
      catch (error) { if (!(error instanceof CocosError) || error.code !== 'RESOURCE_BUSY') throw error; }
      if (active?.status === 'running' && active.endpoint) return { descriptor: active, token: await connections.token(active.tokenFile, false) };
      if (active === null && !launched) {
        launched = true;
        const daemon = join(dirname(workerFile), 'router-daemon.mjs'), info = await lstat(daemon);
        if (!info.isFile() || info.isSymbolicLink()) throw new CocosError('VERIFICATION_FAILED', 'Missing router daemon');
        const logPath = await workspace.resolve('.codex-work/logs/cocos-router.log'); await workspace.work('logs');
        try { const info = await lstat(logPath); if (!info.isFile() || info.isSymbolicLink()) throw new CocosError('VERIFICATION_FAILED', 'Invalid router log'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const log = await open(logPath, 'a', 0o600);
        try {
          const env = workspace.environment(); delete env.COCOS_WORKSPACE_PATH;
          const child = spawn(process.execPath, [daemon, '--installation', installation, '--workspace', workspace.root, '--worker', workerFile],
            { cwd: workspace.root, env, detached: true, stdio: ['ignore', log.fd, log.fd], shell: false });
          child.on('error', error => console.error('[CocosMCP router startup]', error.message)); child.unref();
        } finally { await log.close(); }
      }
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    throw new CocosError('RESOURCE_BUSY', 'Shared router identity unavailable; inspect cocos-router.log without stopping other clients');
  }
}
