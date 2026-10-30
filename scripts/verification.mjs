import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';

export class VerificationBuild {
  recordPath = '.codex-work/cache/verification/source-tests.json';
  attemptPath = '.codex-work/cache/verification/latest-run.json';
  async attempt(before, sources, reportPath, exitCode) {
    const reportSha256 = createHash('sha256').update(await readFile(reportPath)).digest('hex');
    await mkdir(join(this.attemptPath, '..'), { recursive: true });
    await writeFile(this.attemptPath, JSON.stringify({ sourceFingerprint: before, endingFingerprint: await this.fingerprint(),
      completedAt: new Date().toISOString(), exitCode, sources, report: relative(process.cwd(), reportPath), reportSha256,
      environment: { node: process.version, platform: process.platform, architecture: process.arch, timeZone: 'UTC' } }, null, 2));
  }
  async overview(fingerprint, root = process.cwd()) {
    let attempt;
    try { attempt = JSON.parse(await readFile(join(root, this.attemptPath), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { state: 'unknown', reason: 'No recorded full test attempt', counts: null }; throw error; }
    // 报告路径固定在工程日志内；摘要损坏或被后续运行覆盖时不授予当前通过状态。
    if (attempt.report !== '.codex-work/logs/verification-tests.jsonl') return { state: 'unknown', reason: 'Unexpected report path', counts: null };
    let bytes;
    try { bytes = await readFile(join(root, attempt.report)); }
    catch (error) { if (error.code === 'ENOENT') return { state: 'unknown', reason: 'Test report missing', counts: null }; throw error; }
    const actualReportSha256 = createHash('sha256').update(bytes).digest('hex');
    if (actualReportSha256 !== attempt.reportSha256) return { state: 'unknown', reason: 'Report checksum mismatch', counts: null };
    const events = bytes.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const counts = { passed: 0, failed: 0, skipped: 0, cancelled: 0 };
    for (const event of events) {
      if (event.cancelled) counts.cancelled++;
      else if (event.skipped) counts.skipped++;
      else if (event.event === 'test:pass') counts.passed++;
      else if (event.event === 'test:fail') counts.failed++;
    }
    const current = attempt.sourceFingerprint === fingerprint && attempt.endingFingerprint === fingerprint;
    const passed = attempt.exitCode === 0 && counts.passed > 0 && counts.failed === 0 && counts.cancelled === 0;
    return { ...attempt, counts, state: current ? passed ? 'passed' : 'failed' : 'historical',
      reason: current ? 'Full test attempt matches current source and report bytes' : 'Source changed; this attempt cannot verify the current build' };
  }
  async fingerprint() {
    const paths = [];
    const visit = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.codex-work'].includes(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path); else if (entry.isFile()) paths.push(path);
      }
    };
    for (const directory of ['apps', 'packages', 'extensions', 'scripts', 'tests', 'examples', '.github']) await visit(directory);
    // 验证入口与包管理配置也是制品来源的一部分，改变后不能继续使用旧证据。
    paths.push('package.json', 'pnpm-lock.yaml', 'tsconfig.json', '.npmrc', 'pnpm-workspace.yaml');
    const hash = createHash('sha256');
    for (const path of paths.sort()) { hash.update(path); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0'); }
    return hash.digest('hex');
  }
  async clear() { await unlink(this.recordPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  async verifiedRecords(root = process.cwd()) {
    let records = [];
    try {
      const stored = JSON.parse(await readFile(join(root, this.recordPath), 'utf8'));
      if (stored.report !== '.codex-work/logs/verification-tests.jsonl' || !Array.isArray(stored.records)) throw new Error('Invalid verification record');
      const hash = createHash('sha256').update(await readFile(join(root, stored.report))).digest('hex');
      records = stored.records.filter(row => row.reportSha256 === hash);
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return records;
  }
  async definitions() {
    const records = await this.verifiedRecords();
    return { __COCOS_SOURCE_FINGERPRINT__: JSON.stringify(await this.fingerprint()), __COCOS_VERIFICATION_EVIDENCE__: JSON.stringify(records) };
  }
  async record(before, sources, reportPath) {
    if (before !== await this.fingerprint()) throw new Error('Source changed while tests were running; verification was not recorded');
    const bytes = await readFile(reportPath), reportSha256 = createHash('sha256').update(bytes).digest('hex');
    const events = bytes.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const mapping = JSON.parse(await readFile('packages/capability-catalog/src/verification-suites.json', 'utf8'));
    const records = [];
    for (const suite of mapping) {
      if (!sources.includes(suite.source)) throw new Error(`Missing verification test suite: ${suite.source}`);
      const name = basename(suite.source).replace(/\.ts$/, '.mjs');
      const results = events.filter(event => event.file && basename(event.file) === name && ['test:pass', 'test:fail'].includes(event.event));
      // 跳过、取消、失败或没有执行的用例都不能提升验收级别。
      if (!results.length || results.some(row => row.event !== 'test:pass' || row.skipped)) continue;
      records.push({ id: `source-tests:${suite.source}`, level: suite.level, entryIds: suite.entryIds, source: suite.source,
        sourceFingerprint: before, reportSha256, limitations: '仅覆盖所列测试文件中的断言；适配器测试使用桩，不代表真实编辑器、GPU 或真机验收。' });
    }
    await mkdir(join(this.recordPath, '..'), { recursive: true });
    await writeFile(this.recordPath, JSON.stringify({ report: relative(process.cwd(), reportPath), records }, null, 2));
    console.log(`Recorded ${records.length} source-matched verification suites; rebuild to embed them in release artifacts.`);
  }
}
