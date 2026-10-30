import { VerificationBuild } from './verification.mjs';
import { createHash } from 'node:crypto';
import { build as esbuild } from 'esbuild';
import { BuildPlan } from './build-plan.mjs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import files from '../packages/native-adapters/src/extension-files.json' with { type: 'json' };
import clientFiles from '../packages/native-adapters/src/client-files.json' with { type: 'json' };

const root = process.cwd();
const plan = new BuildPlan(process.argv.slice(2));
const define = await new VerificationBuild().definitions();
const output = resolve(root, plan.output);
const builtAt = new Date().toISOString();
await mkdir(output, { recursive: true });
const profilePath = join(output, 'build-profile.json');
const metadata = { profile: plan.profile, majors: plan.majors, targets: plan.targets, builtAt, sourceFingerprint: JSON.parse(define.__COCOS_SOURCE_FINGERPRINT__), state: 'building', rows: [] };
await writeFile(profilePath, JSON.stringify(metadata, null, 2) + '\n');
// 记录每个实际编译入口，不并行写输出；maxRSS 是本进程高水位，并非单步骤内存差值。
const build = async options => {
  const started = performance.now();
  try { await esbuild(options); metadata.rows.push({ output: options.outfile ?? options.outdir, durationMs: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS, status: 'completed' }); }
  catch (error) { metadata.state = 'failed'; metadata.rows.push({ output: options.outfile ?? options.outdir, durationMs: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS, status: 'failed' }); throw error; }
  finally { await writeFile(profilePath, JSON.stringify(metadata, null, 2) + '\n'); }
};
if (plan.includes('server')) {
await mkdir(join(output, 'server'), { recursive: true });
await build({ define, entryPoints: ['apps/server/src/cli.ts'], outfile: join(output, 'server/cli.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm',
  packages: 'external', sourcemap: true });
}
if (plan.includes('client')) {
const clientRoot = join(output, 'client');
await mkdir(clientRoot, { recursive: true });
for (const [entry, name] of [['router-service', 'router'], ['router-daemon', 'router-daemon'], ['router-session', 'session'], ['project-connector', 'connector'], ['shared-service', 'worker'], ['install-client', 'install']]) {
  await build({ define, entryPoints: [`apps/server/src/${entry}.ts`], outfile: join(clientRoot, `${name}.mjs`), bundle: true, platform: 'node', target: 'node24', format: 'esm',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
}
await copyFile('scripts/client-launcher.mjs', join(clientRoot, 'launcher.mjs'));
await copyFile('LICENSE', join(clientRoot, 'LICENSE'));
const clientHashes = {}, clientDigest = createHash('sha256');
for (const name of clientFiles) { const bytes = await readFile(join(clientRoot, name)); clientHashes[name] = createHash('sha256').update(bytes).digest('hex'); clientDigest.update(name).update(bytes); }
const clientEvidence = JSON.parse(define.__COCOS_VERIFICATION_EVIDENCE__), clientFingerprint = JSON.parse(define.__COCOS_SOURCE_FINGERPRINT__);
await writeFile(join(clientRoot, 'manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'cocos-unified-client', apiVersion: 1,
  version: process.env.COCOS_RELEASE_TAG?.replace(/^v/, '') || '0.1.0', buildId: clientDigest.digest('hex').slice(0, 16), builtAt,
  sourceFingerprint: clientFingerprint, verificationReportSha256: clientEvidence.length && clientEvidence.every(row => row.sourceFingerprint === clientFingerprint) ? clientEvidence[0].reportSha256 : null,
  fileHashes: clientHashes }, null, 2) + '\n');
}
for (const major of plan.majors) {
  const extensionRoot = join(output, `extensions/creator${major}`);
  const extension = major === 2 ? 'js' : 'cjs';
  await mkdir(join(extensionRoot, 'dist'), { recursive: true });
  await build({ define, entryPoints: { main: `extensions/creator${major}/src/main.ts`, scene: `extensions/creator${major}/src/scene.ts`, panel: `extensions/creator${major}/src/panel.ts` },
    outdir: join(extensionRoot, 'dist'), outExtension: { '.js': `.${extension}` }, bundle: true, platform: 'node',
    target: major === 2 ? 'node8' : 'node12', format: 'cjs', sourcemap: true, external: ['cc', 'electron'] });
  await build({ define, entryPoints: ['apps/server/src/managed-service.ts'], outfile: join(extensionRoot, 'dist/service.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  await build({ define, entryPoints: ['apps/server/src/stdio-service.ts'], outfile: join(extensionRoot, 'dist/stdio.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  await build({ define, entryPoints: ['apps/server/src/update-extension.ts'], outfile: join(extensionRoot, 'dist/update.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm' });
  await build({ define, entryPoints: ['packages/runtime3-bridge/src/bootstrap.ts'], outfile: join(extensionRoot, 'dist/runtime.js'), bundle: true,
    platform: 'browser', target: 'es2018', format: 'iife', globalName: 'CocosMCPRuntime' });
  await writeFile(join(extensionRoot, 'service-config.json'), JSON.stringify({ nodeExecutable: process.execPath, clientInstallation: join(root, '.codex-work/artifacts/cocos-client') }));
  const manifest = JSON.parse(await readFile(`extensions/creator${major}/package.json`, 'utf8'));
  const hash = createHash('sha256');
  // 展示资料变化也必须更新构建身份，否则更新器会把新包误认为已经安装。
  hash.update(JSON.stringify(manifest));
  for (const path of ['README.en.md', 'README.zh.md', 'logo.png']) hash.update(await readFile(join('extensions/shared', path)));
  for (const file of [`main.${extension}`, `scene.${extension}`, `panel.${extension}`, 'service.mjs', 'stdio.mjs', 'update.mjs']) hash.update(await readFile(join(extensionRoot, 'dist', file)));
  hash.update(await readFile(join(extensionRoot, 'dist/runtime.js')));
  manifest.buildId = process.env.COCOS_RELEASE_TAG || hash.digest('hex').slice(0, 12);
  if (process.env.COCOS_RELEASE_TAG) manifest.version = process.env.COCOS_RELEASE_TAG.replace(/^v/, '');
  manifest.buildTime = builtAt;
  manifest.sourceFingerprint = JSON.parse(define.__COCOS_SOURCE_FINGERPRINT__);
  const evidence = JSON.parse(define.__COCOS_VERIFICATION_EVIDENCE__);
  manifest.verificationReportSha256 = evidence.length && evidence.every(row => row.sourceFingerprint === manifest.sourceFingerprint) ? evidence[0].reportSha256 : null;
  await writeFile(join(extensionRoot, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await copyFile('LICENSE', join(extensionRoot, 'LICENSE'));
  await copyFile('extensions/shared/logo.png', join(extensionRoot, 'logo.png'));
  // Creator 3.8.8 精确匹配当前语言的 README，不会自动从 README.md 回退。
  for (const [language, names] of [['en', ['README.md', 'README.en.md']], ['zh', ['README.zh.md', 'README.zh-CN.md']]]) {
    const template = await readFile(`extensions/shared/README.${language}.md`, 'utf8');
    const values = { major, version: manifest.version, buildId: manifest.buildId, builtAt };
    const content = template.replace(/\{\{(major|version|buildId|builtAt)\}\}/g, (_, key) => String(values[key]));
    for (const name of names) await writeFile(join(extensionRoot, name), content);
  }
  manifest.fileHashes = {};
  // package.json 不能摘要自身；其身份由更新包整体 SHA-256 与安装身份校验保护。
  for (const path of [...files[major], ...files.presentation].filter(path => path !== 'package.json')) {
    const bytes = await readFile(join(extensionRoot, path));
    if (!bytes.length) throw new Error(`Empty extension file: ${path}`);
    manifest.fileHashes[path] = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(join(extensionRoot, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
}
if (plan.includes('runtime')) {
await mkdir(join(output, 'runtime'), { recursive: true });
await build({ define, entryPoints: ['packages/runtime3-bridge/src/bootstrap.ts'], outfile: join(output, 'runtime/cocos-mcp.js'), bundle: true,
  platform: 'browser', target: 'es2018', format: 'iife', globalName: 'CocosMCPRuntime', sourcemap: true });
await build({ define, entryPoints: ['packages/runtime3-bridge/src/bootstrap.ts'], outfile: join(output, 'runtime/cocos-mcp.mjs'), bundle: true,
  platform: 'browser', target: 'es2018', format: 'esm', sourcemap: true });
}
if (plan.includes('smoke')) {
await build({ define, entryPoints: ['scripts/ui-preview-smoke.ts'], outfile: join(output, 'ui-preview-smoke.mjs'), bundle: true,
  platform: 'node', target: 'node24', format: 'esm', packages: 'external' });
}
const summaryModule = join(output, 'verification-summary.mjs');
await build({ define, entryPoints: ['packages/catalog-generator/src/verification-summary.ts'], outfile: summaryModule,
  bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external' });
const { VerificationSummary } = await import(pathToFileURL(summaryModule).href);
const summary = new VerificationSummary().create(metadata.sourceFingerprint, await new VerificationBuild().overview(metadata.sourceFingerprint));
await writeFile(join(output, 'verification-summary.json'), JSON.stringify(summary.json, null, 2) + '\n');
await writeFile(join(output, 'verification-summary.md'), summary.markdown);
metadata.state = 'completed'; metadata.completedAt = new Date().toISOString();
await writeFile(profilePath, JSON.stringify(metadata, null, 2) + '\n');
console.log(`Built ${plan.profile} profile (${[...plan.targets, ...plan.majors.map(major => `creator${major}`)].join(', ')}) in ${plan.output}`);
