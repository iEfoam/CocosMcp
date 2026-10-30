import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { VerificationBuild } from './verification.mjs';
import { BuildPlan } from './build-plan.mjs';
import files from '../packages/native-adapters/src/extension-files.json' with { type: 'json' };
import clientFiles from '../packages/native-adapters/src/client-files.json' with { type: 'json' };

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--directory' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(args[1]))) throw new Error('Expected --directory <unique-candidate-name>');
const output = args.length ? join('.codex-work/build/release-candidates', args[1]) : '.codex-work/build/releases';
const verification = new VerificationBuild();
const fingerprint = await verification.fingerprint();
const profile = JSON.parse(await readFile('.codex-work/build/build-profile.json', 'utf8'));
BuildPlan.assertRelease(profile, fingerprint);
// 同一源码在旧成功记录之后也可能测试失败，不能只消费成功缓存。
if ((await verification.overview(fingerprint)).state !== 'passed') throw new Error('Latest full test attempt must pass for the current source before packaging');
const evidence = JSON.parse(await readFile(verification.recordPath, 'utf8'));
if (!evidence.records.length || evidence.records.some(row => row.sourceFingerprint !== fingerprint)) throw new Error('Run pnpm check before packaging: source verification is missing or stale');
const reportHash = createHash('sha256').update(await readFile(evidence.report)).digest('hex');
if (evidence.records.some(row => row.reportSha256 !== reportHash)) throw new Error('Verification report checksum mismatch');
const artifacts = [], packages = [];
const contents = new Map();
const save = async (name, content) => {
  const bytes = Buffer.from(content);
  contents.set(name, bytes);
  artifacts.push({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
};
// 发布阶段只消费已校验制品；说明文件也在构建阶段生成并纳入摘要。
await save('release-notes.md', `Verified ${process.env.COCOS_RELEASE_CHANNEL ?? 'local'} build from source fingerprint ${fingerprint}.\n\n` + await readFile('.github/release-notes.md', 'utf8'));
for (const major of [2, 3]) {
  const root = `.codex-work/build/extensions/creator${major}`;
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.sourceFingerprint !== fingerprint || manifest.verificationReportSha256 !== reportHash) throw new Error(`Creator ${major} build is stale; run pnpm check`);
  if (packages.length && packages[0].version !== manifest.version) throw new Error('Creator versions do not match');
  packages.push({ major, version: manifest.version, buildId: manifest.buildId });
  const rows = [], archive = {};
  for (const path of [...files[major], ...files.presentation]) {
    const bytes = await readFile(join(root, path));
    if (!bytes.length || (path !== 'package.json' && createHash('sha256').update(bytes).digest('hex') !== manifest.fileHashes?.[path])) throw new Error(`Creator ${major} release file is incomplete or corrupt: ${path}`);
    rows.push({ path, content: bytes.toString('base64') });
    // ZIP 和更新包使用同一份字节及白名单，不夹带本机凭据、缓存或 service-config。
    archive[path] = [bytes, { mtime: new Date('2000-01-01T00:00:00Z') }];
  }
  const bundle = { major, version: manifest.version, buildId: manifest.buildId, rows };
  await save(`cocos-mcp-creator${major}.full.json`, JSON.stringify(bundle));
  await save(`cocos-mcp-creator${major}.zip`, zipSync(archive));
  // Creator 2 旧更新器的七文件白名单不含 runtime，无法安全兼容新完整包。
  // 升级必须使用整包本地安装/ZIP；禁止为旧白名单继续发布缺运行文件的包。
  await save(`cocos-mcp-creator${major}.json`, JSON.stringify({ ...bundle, rows: rows.filter(row => files[major].includes(row.path)) }));
}
const clientRoot = '.codex-work/build/client', clientManifest = JSON.parse(await readFile(join(clientRoot, 'manifest.json'), 'utf8')), clientArchive = {};
if (clientManifest.sourceFingerprint !== fingerprint || clientManifest.verificationReportSha256 !== reportHash) throw new Error('Unified client build is stale; run pnpm check');
for (const name of [...clientFiles, 'manifest.json']) {
  const bytes = await readFile(join(clientRoot, name));
  if (!bytes.length || (name !== 'manifest.json' && createHash('sha256').update(bytes).digest('hex') !== clientManifest.fileHashes[name])) throw new Error(`Invalid client release file: ${name}`);
  clientArchive[name] = [bytes, { mtime: new Date('2000-01-01T00:00:00Z') }];
}
await save('cocos-mcp-client.zip', zipSync(clientArchive));
await save('release-manifest.json', JSON.stringify({ sourceFingerprint: fingerprint, packages, client: { version: clientManifest.version, buildId: clientManifest.buildId }, artifacts: artifacts.slice() }, null, 2));
contents.set('SHA256SUMS', Buffer.from(artifacts.map(row => `${row.sha256}  ${row.name}\n`).join('')));
// 校验所有输入之后再排他创建目录；重复打包不得覆盖已有制品，失败目录留作诊断。
await mkdir(join(output, '..'), { recursive: true });
await mkdir(output);
for (const [name, bytes] of contents) await writeFile(join(output, name), bytes, { flag: 'wx' });
console.log(`Packaged ${packages.length} Creator versions from verified source ${fingerprint.slice(0, 12)} in ${output}`);
