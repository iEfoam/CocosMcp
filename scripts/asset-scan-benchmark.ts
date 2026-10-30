import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AssetOrganization } from '../packages/asset-policy/src/index.js';
import type { JsonObject } from '../packages/contracts/src/index.js';

/** 独立文件系统夹具，仅评估只读扫描/摘要；不是 Creator 导入资产或原生 AssetDB 性能测试。 */
class AssetScanBenchmark {
  async run(): Promise<void> {
    const temporary = join(process.cwd(), '.codex-work/tmp'); await mkdir(temporary, { recursive: true });
    const root = await mkdtemp(join(temporary, 'asset-scan-benchmark-'));
    let passed = false;
    try {
      for (const directory of ['Materials', 'Models', 'Incoming', 'Large', 'Unrelated/deep']) await mkdir(join(root, 'assets', directory), { recursive: true });
      for (let index = 0; index < 12; index++) {
        const path = join(root, 'assets/Incoming', `Material-${index}.mtl`);
        await writeFile(path, Buffer.alloc(64 * 1024, 32)); await writeFile(path + '.meta', JSON.stringify({ uuid: `material-${index}` }));
      }
      // 候选枚举上限为 2000；无关子树超过上限，范围计划仍应成功且不读取其损坏元数据。
      for (let batch = 0; batch < 51; batch++) await Promise.all(Array.from({ length: Math.min(100, 5001 - batch * 100) }, async (_, offset) => {
        await writeFile(join(root, 'assets/Unrelated/deep', `Unrelated-${batch * 100 + offset}.bin`), '');
      }));
      await writeFile(join(root, 'assets/Unrelated/deep/Unrelated-0.bin.meta'), 'invalid metadata outside scope');
      const model = join(root, 'assets/Large/Large.glb'), handle = await open(model, 'wx');
      try { const chunk = Buffer.alloc(1024 * 1024, 17); for (let index = 0; index < 128; index++) await handle.writeFile(chunk); }
      finally { await handle.close(); }
      await writeFile(model + '.meta', '{"uuid":"large-model"}');
      const service = new AssetOrganization({ projectPath: root, request: async () => { throw new Error('Read-only benchmark must not call AssetDB'); } });
      const rows: JsonObject[] = [];
      for (const scenario of [
        { label: 'scoped-small', params: { scopeUrl: 'db://assets/Incoming/' }, count: 12, bytes: 12 * 64 * 1024 },
        { label: 'explicit-large', params: { urls: ['db://assets/Large/Large.glb'] }, count: 1, bytes: 128 * 1024 * 1024 },
      ]) {
        for (let sample = 0; sample < 5; sample++) {
          const started = performance.now(), rssStart = process.memoryUsage().rss; let peakRss = rssStart;
          const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
          try {
            const result = await service.plan(scenario.params);
            assert.equal((result.rows as unknown[]).length, scenario.count);
            assert.equal(typeof result.planHash, 'string');
            peakRss = Math.max(peakRss, process.memoryUsage().rss);
            rows.push({ label: scenario.label, sample, durationMs: performance.now() - started, assetBytes: scenario.bytes, rssStart, sampledPeakRss: peakRss });
          } finally { clearInterval(timer); }
        }
      }
      await assert.rejects(service.plan({ recursive: true }), { code: 'INVALID_ARGUMENT', message: 'Organize at most 2000 files per plan' });
      const summary = ['scoped-small', 'explicit-large'].map(label => {
        const values = rows.filter(row => row.label === label).map(row => Number(row.durationMs)).sort((a, b) => a - b);
        return { label, samples: values.length, p50Ms: values[2], p95Ms: values[4] };
      });
      const output = join(process.cwd(), '.codex-work/artifacts/asset-scan-benchmark', new Date().toISOString().replace(/[:.]/g, '-'));
      await mkdir(output, { recursive: true });
      await writeFile(join(output, 'REPORT.json'), JSON.stringify({ createdAtUTC: new Date().toISOString(),
        environment: { node: process.version, platform: process.platform, architecture: process.arch }, summary, rows,
        fixture: { unrelatedFiles: 5001, smallAssets: 12, largeAssetBytes: 128 * 1024 * 1024 },
        checks: { scopedPlanIgnoresOversizedUnrelatedTree: true, fullTreeCandidateBudgetEnforced: true, nativeCalls: 0 },
        limitations: ['Synthetic files; no Creator import or AssetDB timing', 'No cache eviction or historical implementation comparison', 'RSS sampled every 5 ms for whole process; not a per-operation allocation or hard peak bound'] }, null, 2));
      console.log(JSON.stringify({ report: join(output, 'REPORT.json'), summary })); passed = true;
    } finally {
      if (passed) await rm(root, { recursive: true });
      else console.error('Asset benchmark fixture retained: ' + root);
    }
  }
}

await new AssetScanBenchmark().run();
