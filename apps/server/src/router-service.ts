import { request } from 'node:http';
import { ProjectPaths } from '../../../packages/application/src/paths.js';
import { RouterRuntime } from './router-runtime.js';

export class RouterService {
  async run(installationPath: string, workspaceRoot: string, workerFile: string): Promise<void> {
    const workspace = await ProjectPaths.open(workspaceRoot);
    const { descriptor, token } = await new RouterRuntime().ensure(installationPath, workspace, workerFile);
    // 兼容入口只转发字节，不加载 SDK、Schema、应用或工程执行器。
    const call = request(new URL('/stdio', descriptor.endpoint!), { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/x-ndjson', 'transfer-encoding': 'chunked',
      'x-cocos-workspace': Buffer.from(process.env.COCOS_WORKSPACE_PATH ?? '', 'utf8').toString('base64'),
    } });
    const close = (): void => { process.stdin.unpipe(call); process.stdin.pause(); call.destroy(); };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, close);
    process.stdin.once('error', close); process.stdout.once('error', close);
    call.on('response', response => {
      if (response.statusCode !== 200) { console.error('[CocosMCP bridge] Shared router rejected connection:', response.statusCode); process.exitCode = 1; response.resume(); close(); return; }
      response.pipe(process.stdout, { end: false }); response.once('close', close);
    });
    call.once('error', error => { console.error('[CocosMCP bridge]', error.message); process.exitCode = 1; close(); });
    call.flushHeaders(); process.stdin.pipe(call);
  }
}
