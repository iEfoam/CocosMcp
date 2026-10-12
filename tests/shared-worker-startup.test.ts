import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ServiceHost } from '../apps/server/src/service-host.js';
import { SharedWorkerLifecycle } from '../apps/server/src/shared-worker-lifecycle.js';
import { ProjectRegistry } from '../packages/application/src/registry.js';
import { ProjectPaths } from '../packages/application/src/paths.js';
import { ServiceConnections } from '../packages/application/src/service-connections.js';
import { TestWorkspace } from './workspace.js';

test('shared backend restores live build protection before serving requests and cannot idle-exit with that orphan', async () => {
  const root = await new TestWorkspace().create('shared-startup-'), paths = await ProjectPaths.open(root), projects = new ProjectRegistry();
  const project = await projects.add(root), jobId = randomUUID(), cache = await paths.work('cache', 'cocos-mcp'), logs = await paths.work('logs', 'builds');
  await writeFile(join(cache, 'build-jobs.json'), JSON.stringify([{ jobId, projectId: project.projectId, projectPath: root, state: 'running', platform: 'web-mobile', creatorVersion: '3.8.8',
    logPath: join(logs, `${jobId}.log`), outputPath: join(root, '.codex-work/build/creator', jobId), spawnAttempted: true, childPid: process.pid }]));
  const host = new ServiceHost(projects), lifecycle = new SharedWorkerLifecycle(3000, 1), connections = new ServiceConnections(paths);
  try {
    await host.start({ transport: 'http', owner: 'client', sharedControl: lifecycle }); assert.equal(host.busy(), true);
    await delay(5); let exited = false; await lifecycle.sweep(() => host.busy(), async () => { exited = true; await host.close(); });
    assert.equal(exited, false); assert.equal((await connections.active())?.status, 'running');
  } finally { await host.close(); }
});
