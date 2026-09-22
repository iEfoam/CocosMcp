import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { VerificationBuild } from './verification.mjs';
import files from '../packages/native-adapters/src/extension-files.json' with { type: 'json' };

const output = '.codex-work/build/releases';
const verification = new VerificationBuild();
const fingerprint = await verification.fingerprint();
const evidence = JSON.parse(await readFile(verification.recordPath, 'utf8'));
if (!evidence.records.length || evidence.records.some(row => row.sourceFingerprint !== fingerprint)) throw new Error('Run pnpm check before packaging: source verification is missing or stale');
const reportHash = createHash('sha256').update(await readFile(evidence.report)).digest('hex');
if (evidence.records.some(row => row.reportSha256 !== reportHash)) throw new Error('Verification report checksum mismatch');
await mkdir(output, { recursive: true });
const artifacts = [], packages = [];
const save = async (name, content) => {
  const bytes = Buffer.from(content);
  await writeFile(join(output, name), bytes);
  artifacts.push({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
};
for (const major of [2, 3]) {
  const root = `.codex-work/build/extensions/creator${major}`;
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.sourceFingerprint !== fingerprint || manifest.verificationReportSha256 !== reportHash) throw new Error(`Creator ${major} build is stale; run pnpm check`);
  if (packages.length && packages[0].version !== manifest.version) throw new Error('Creator versions do not match');
  packages.push({ major, version: manifest.version, buildId: manifest.buildId });
  const rows = [], archive = {};
  for (const path of [...files[major], ...files.presentation]) {
    const bytes = await readFile(join(root, path));
    rows.push({ path, content: bytes.toString('base64') });
    // ZIP 和更新包使用同一份字节及白名单，不夹带本机凭据、缓存或 service-config。
    archive[path] = [bytes, { mtime: new Date('2000-01-01T00:00:00Z') }];
  }
  const bundle = { major, version: manifest.version, buildId: manifest.buildId, rows };
  await save(`cocos-mcp-creator${major}.full.json`, JSON.stringify(bundle));
  await save(`cocos-mcp-creator${major}.zip`, zipSync(archive));
  // 已发布的旧更新器要求精确的文件数，继续保留兼容资产。
  await save(`cocos-mcp-creator${major}.json`, JSON.stringify({ ...bundle, rows: rows.filter(row => files[major].includes(row.path)) }));
}
await save('release-manifest.json', JSON.stringify({ sourceFingerprint: fingerprint, packages, artifacts: artifacts.slice() }, null, 2));
await writeFile(join(output, 'SHA256SUMS'), artifacts.map(row => `${row.sha256}  ${row.name}\n`).join(''));
console.log(`Packaged ${packages.length} Creator versions from verified source ${fingerprint.slice(0, 12)} in ${output}`);
