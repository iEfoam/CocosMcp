import { VerificationBuild } from './verification.mjs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = process.cwd();
const define = await new VerificationBuild().definitions();
const output = resolve(root, '.codex-work/build');
const builtAt = new Date().toISOString();
await mkdir(join(output, 'server'), { recursive: true });
await build({ define, entryPoints: ['apps/server/src/cli.ts'], outfile: join(output, 'server/cli.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm',
  packages: 'external', sourcemap: true });
for (const major of [2, 3]) {
  const extensionRoot = join(output, `extensions/creator${major}`);
  const extension = major === 2 ? 'js' : 'cjs';
  await mkdir(join(extensionRoot, 'dist'), { recursive: true });
  await build({ define, entryPoints: { main: `extensions/creator${major}/src/main.ts`, scene: `extensions/creator${major}/src/scene.ts`, panel: `extensions/creator${major}/src/panel.ts` },
    outdir: join(extensionRoot, 'dist'), outExtension: { '.js': `.${extension}` }, bundle: true, platform: 'node',
    target: major === 2 ? 'node8' : 'node12', format: 'cjs', sourcemap: true, external: ['cc', 'electron'] });
  await build({ define, entryPoints: ['apps/server/src/managed-service.ts'], outfile: join(extensionRoot, 'dist/service.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  await build({ define, entryPoints: ['apps/server/src/update-extension.ts'], outfile: join(extensionRoot, 'dist/update.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm' });
  await build({ define, entryPoints: ['packages/runtime3-bridge/src/bootstrap.ts'], outfile: join(extensionRoot, 'dist/runtime.js'), bundle: true,
    platform: 'browser', target: 'es2018', format: 'iife', globalName: 'CocosMCPRuntime' });
  await writeFile(join(extensionRoot, 'service-config.json'), JSON.stringify({ nodeExecutable: process.execPath }));
  const manifest = JSON.parse(await readFile(`extensions/creator${major}/package.json`, 'utf8'));
  const hash = createHash('sha256');
  // 展示资料变化也必须更新构建身份，否则更新器会把新包误认为已经安装。
  hash.update(JSON.stringify(manifest));
  for (const path of ['README.en.md', 'README.zh.md', 'logo.png']) hash.update(await readFile(join('extensions/shared', path)));
  for (const file of [`main.${extension}`, `scene.${extension}`, `panel.${extension}`, 'service.mjs', 'update.mjs']) hash.update(await readFile(join(extensionRoot, 'dist', file)));
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
}
await mkdir(join(output, 'runtime'), { recursive: true });
await build({ define, entryPoints: ['packages/runtime3-bridge/src/bootstrap.ts'], outfile: join(output, 'runtime/cocos-mcp.js'), bundle: true,
  platform: 'browser', target: 'es2018', format: 'iife', globalName: 'CocosMCPRuntime', sourcemap: true });
await build({ define, entryPoints: ['packages/runtime3-bridge/src/bootstrap.ts'], outfile: join(output, 'runtime/cocos-mcp.mjs'), bundle: true,
  platform: 'browser', target: 'es2018', format: 'esm', sourcemap: true });
console.log('Built MCP server, Creator 2/3 extensions and development runtime bridges in .codex-work/build/');
await build({ define, entryPoints: ['scripts/ui-preview-smoke.ts'], outfile: join(output, 'ui-preview-smoke.mjs'), bundle: true,
  platform: 'node', target: 'node24', format: 'esm', packages: 'external' });
