import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ProjectRegistry } from '../packages/application/src/registry.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
import { WorkspaceStorage } from './workspace-storage.mjs';

/** 默认配额、真实回环 HTTP；不连接 Creator，不包含引擎执行或真实截图耗时。 */
class RuntimeCapacityBenchmark {
  async run(): Promise<void> {
    const storage = new WorkspaceStorage(process.cwd()), receipt = await storage.createTestRun();
    const projects = new ProjectRegistry(), identities: Array<{ projectId: string; projectPath: string; token: string }> = [];
    const gateway = new RuntimeGateway(projects, 60000, 120000); let passed = false;
    const samples: JsonObject[] = []; const rssStart = process.memoryUsage().rss; let sampledPeakRss = rssStart;
    const sampling = setInterval(() => { sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss); }, 5);
    try {
      for (let i = 0; i < 5; i++) {
        const root = join(receipt.directory, `project-${i}`); await mkdir(root);
        identities.push({ ...await projects.add(root), token: '' });
      }
      const port = await gateway.start();
      for (const project of identities) project.token = JSON.parse(await readFile(join(project.projectPath, `.codex-work/cache/cocos-mcp/runtime-${process.pid}.json`), 'utf8')).token;
      const post = async (project: typeof identities[number], route: string, body: JsonObject): Promise<JsonObject> => {
        const response = await fetch(`http://127.0.0.1:${port}/runtime/${route}`, { method: 'POST', headers: { authorization: `Bearer ${project.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, projectId: project.projectId }), signal: AbortSignal.timeout(10000) });
        return Json.object(await response.json());
      };
      const sessions: Array<{ project: typeof identities[number]; runtimeInstanceId: string }> = [];
      for (const project of identities.slice(0, 4)) for (let i = 0; i < 32; i++) {
        const started = performance.now(), result = await post(project, 'register', {});
        sessions.push({ project, runtimeInstanceId: Json.string(result.runtimeInstanceId, 'runtimeInstanceId') });
        samples.push({ phase: 'register', durationMs: performance.now() - started });
      }
      assert.equal(Json.object((await post(identities[0]!, 'register', {})).error).code, 'RESOURCE_BUSY');
      assert.equal(Json.object((await post(identities[4]!, 'register', {})).error).code, 'RESOURCE_BUSY');
      const selected = [sessions[0]!, sessions[32]!, sessions[64]!, sessions[96]!];
      const outcomes: Promise<JsonObject>[] = [];
      for (const session of selected) {
        for (let i = 0; i < 128; i++) outcomes.push(gateway.execute(session.project.projectId, session.runtimeInstanceId, 'runtime.scene.query', {}).then(result => ({ result }), error => ({ error: String(error) })));
        await assert.rejects(gateway.execute(session.project.projectId, session.runtimeInstanceId, 'runtime.scene.query', {}), { code: 'RESOURCE_BUSY' });
      }
      await assert.rejects(gateway.execute(sessions[1]!.project.projectId, sessions[1]!.runtimeInstanceId, 'runtime.scene.query', {}), { code: 'RESOURCE_BUSY' });
      for (const session of selected) for (let i = 0; i < 128; i++) {
        const started = performance.now(), command = Json.object((await post(session.project, 'poll', { runtimeInstanceId: session.runtimeInstanceId })).command);
        assert.equal((await post(session.project, 'reply', { runtimeInstanceId: session.runtimeInstanceId, commandId: command.id!, result: { ok: true } })).accepted, true);
        samples.push({ phase: 'saturated-drain', durationMs: performance.now() - started });
      }
      for (const outcome of await Promise.all(outcomes)) assert.deepEqual(outcome, { result: { ok: true } });
      const session = selected[0]!, payload = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 20; i++) {
        const started = performance.now(), task = gateway.execute(session.project.projectId, session.runtimeInstanceId, 'runtime.capture', {}).then(result => ({ result }), error => ({ error: String(error) }));
        const command = Json.object((await post(session.project, 'poll', { runtimeInstanceId: session.runtimeInstanceId })).command);
        assert.equal((await post(session.project, 'reply', { runtimeInstanceId: session.runtimeInstanceId, commandId: command.id!, result: payload })).accepted, true);
        assert.deepEqual(await task, { result: payload }); samples.push({ phase: 'recovered-1MiB-reply', durationMs: performance.now() - started });
      }
      const rows = ['register', 'saturated-drain', 'recovered-1MiB-reply'].map(phase => {
        const values = samples.filter(row => row.phase === phase).map(row => Number(row.durationMs)).sort((a, b) => a - b);
        return { phase, count: values.length, p50Ms: values[Math.ceil(values.length * .5) - 1]!, p95Ms: values[Math.ceil(values.length * .95) - 1]! };
      });
      const directory = join(process.cwd(), '.codex-work/artifacts/runtime-capacity-benchmark', new Date().toISOString().replaceAll(':', '-'));
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'REPORT.json'), JSON.stringify({ environment: { node: process.version, platform: process.platform, architecture: process.arch }, sessions: 128, pendingAtCapacity: 512,
        rejection: 'RESOURCE_BUSY', recoveryReplies: 20, rssStart, sampledPeakRss: Math.max(sampledPeakRss, process.memoryUsage().rss), processMaxRssKiB: process.resourceUsage().maxRSS,
        rows, samples, limitations: ['Synthetic loopback clients; no Creator or GPU execution', 'Drain timings measure poll/reply transport, not time spent queued', 'Reply payload is 1 MiB text, not a decoded image', 'Body-reader/slow-stream boundaries are covered by tests, not this benchmark', 'RSS is process-wide and sampled, not a precise gateway allocation measurement'] }, null, 2));
      console.log(JSON.stringify({ report: join(directory, 'REPORT.json'), rows })); passed = true;
    } finally {
      clearInterval(sampling); await gateway.close(); await storage.finish(receipt, passed);
      if (passed) console.log(await storage.cleanup(receipt));
    }
  }
}
await new RuntimeCapacityBenchmark().run();
