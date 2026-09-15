import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';

export class VerificationBuild {
  recordPath = '.codex-work/cache/verification/source-tests.json';
  async fingerprint() {
    const paths = [];
    const visit = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.codex-work'].includes(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path); else if (entry.isFile()) paths.push(path);
      }
    };
    for (const directory of ['apps', 'packages', 'extensions', 'scripts', 'tests', 'examples']) await visit(directory);
    paths.push('package.json', 'pnpm-lock.yaml', 'tsconfig.json');
    const hash = createHash('sha256');
    for (const path of paths.sort()) { hash.update(path); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0'); }
    return hash.digest('hex');
  }
  async clear() { await unlink(this.recordPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  async definitions() {
    let records = [];
    try { records = JSON.parse(await readFile(this.recordPath, 'utf8')).records; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Array.isArray(records)) throw new Error('Invalid verification record');
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
