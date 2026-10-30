import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ProjectRegistry } from '../packages/application/src/registry.js';
import type { BridgeDescriptor, JsonObject } from '../packages/contracts/src/index.js';

/** 真实回环 HTTP + 合成描述符；不连接用户编辑器、不改授权、不以固定延迟冒充原生性能。 */
class DiscoveryBenchmark {
  private server?: Server;
  private root = '';
  private probes = 0;
  private active = 0;
  private peak = 0;
  private revoked = false;
  private readonly registry = new ProjectRegistry();
  private readonly samples: JsonObject[] = [];

  private async measure(label: string, callers: number, projectId: string, instanceId?: string): Promise<void> {
    const before = this.probes; this.peak = 0;
    const started = performance.now();
    const rows = await Promise.all(Array.from({ length: callers }, () => this.registry.instances(projectId, instanceId)));
    const expectedProbes = instanceId ? 1 : 16;
    assert.equal(this.probes - before, expectedProbes);
    assert.ok(this.peak <= 4);
    assert.ok(rows.every(row => row.length === (instanceId ? 1 : 8)));
    this.samples.push({ label, callers, durationMs: performance.now() - started, probes: this.probes - before, peakConcurrentProbes: this.peak, activeInstances: rows[0]!.length });
  }

  async run(): Promise<void> {
    const temporary = join(process.cwd(), '.codex-work/tmp');
    await mkdir(temporary, { recursive: true });
    this.root = await mkdtemp(join(temporary, 'discovery-benchmark-'));
    let passed = false;
    try {
      const { projectId } = await this.registry.add(this.root);
      this.server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          this.probes++; this.active++; this.peak = Math.max(this.peak, this.active);
          const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const authenticated = request.headers.authorization === `Bearer ${'a'.repeat(64)}` && command.projectId === projectId;
          const live = String(command.instanceId).startsWith('live-') && !(this.revoked && command.instanceId === 'live-0');
          setTimeout(() => {
            response.writeHead(authenticated ? 200 : 403, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ result: { instanceId: command.instanceId, projectPath: this.root, pid: live ? process.pid : process.pid + 1 } }));
            this.active--;
          }, 3);
        });
      });
      await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve); });
      const address = this.server.address(); assert.ok(address && typeof address !== 'string');
      const directory = join(this.root, '.codex-work/cache/cocos-mcp/instances'); await mkdir(directory, { recursive: true });
      for (let index = 0; index < 16; index++) {
        const instanceId = `${index < 8 ? 'live' : 'stale'}-${index % 8}`;
        const descriptor: BridgeDescriptor = { protocolVersion: 1, projectId, projectPath: this.root, instanceId, creatorMajor: 3,
          editorVersion: '3.8.8', pid: process.pid, endpoint: `http://127.0.0.1:${address.port}/rpc`, token: 'a'.repeat(64), startedAt: new Date().toISOString() };
        await writeFile(join(directory, instanceId + '.json'), JSON.stringify(descriptor));
      }
      await this.measure('cold-full', 1, projectId);
      for (let sample = 0; sample < 10; sample++) {
        await this.measure('warm-full', 1, projectId);
        await this.measure('concurrent-full', 10, projectId);
        await this.measure('explicit-instance', 1, projectId, 'live-0');
      }
      await assert.rejects(this.registry.instance(projectId), { code: 'AMBIGUOUS_TARGET' });
      const beforeRevocation = this.probes; this.revoked = true;
      await assert.rejects(this.registry.instance(projectId, 'live-0'), { code: 'CONTEXT_UNAVAILABLE' });
      assert.equal(this.probes - beforeRevocation, 1);
      const summary = [...new Set(this.samples.map(row => String(row.label)))].map(label => {
        const rows = this.samples.filter(row => row.label === label), durations = rows.map(row => Number(row.durationMs)).sort((a, b) => a - b);
        return { label, samples: rows.length, p50Ms: durations[Math.ceil(durations.length * 0.5) - 1], p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
          probesPerSample: rows[0]!.probes, callersPerSample: rows[0]!.callers };
      });
      const output = join(process.cwd(), '.codex-work/artifacts/discovery-benchmark', new Date().toISOString().replace(/[:.]/g, '-'));
      await mkdir(output, { recursive: true });
      const report = { createdAtUTC: new Date().toISOString(), environment: { node: process.version, platform: process.platform, architecture: process.arch },
        fixture: { descriptors: 16, authenticatedInstances: 8, stalePidIdentities: 8, injectedReplyDelayMs: 3 },
        summary, rows: this.samples, checks: { concurrencyLimit: 4, ambiguityRejected: true, revocationReauthenticated: true },
        limitations: ['Synthetic identities over real loopback HTTP; no native Creator execution', 'Warm means OS/HTTP warmup, not cached authentication', 'Concurrent callers share one discovery; this is not a historical implementation timing comparison'] };
      await writeFile(join(output, 'REPORT.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ report: join(output, 'REPORT.json'), summary })); passed = true;
    } finally {
      if (this.server?.listening) { this.server.closeAllConnections(); await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve())); }
      // 只删除此次创建且已关闭监听的合成描述符；失败时保留现场。
      if (passed) await rm(this.root, { recursive: true });
      else console.error('Discovery benchmark fixture retained: ' + this.root);
    }
  }
}

await new DiscoveryBenchmark().run();
