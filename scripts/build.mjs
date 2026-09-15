import { VerificationBuild } from './verification.mjs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = process.cwd();
const define = await new VerificationBuild().definitions();
const output = resolve(root, '.codex-work/build');
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
  if (major === 3) await build({ define, entryPoints: ['packages/runtime3-bridge/src/bootstrap.ts'], outfile: join(extensionRoot, 'dist/runtime.js'), bundle: true,
    platform: 'browser', target: 'es2018', format: 'iife', globalName: 'CocosMCPRuntime' });
  await writeFile(join(extensionRoot, 'service-config.json'), JSON.stringify({ nodeExecutable: process.execPath }));
  const manifest = JSON.parse(await readFile(`extensions/creator${major}/package.json`, 'utf8'));
  const hash = createHash('sha256');
  for (const file of [`main.${extension}`, `scene.${extension}`, `panel.${extension}`, 'service.mjs', 'update.mjs']) hash.update(await readFile(join(extensionRoot, 'dist', file)));
  if (major === 3) hash.update(await readFile(join(extensionRoot, 'dist/runtime.js')));
  manifest.buildId = process.env.COCOS_RELEASE_TAG || hash.digest('hex').slice(0, 12);
  if (process.env.COCOS_RELEASE_TAG) manifest.version = process.env.COCOS_RELEASE_TAG.replace(/^v/, '');
  await writeFile(join(extensionRoot, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await copyFile('LICENSE', join(extensionRoot, 'LICENSE'));
}
await mkdir(join(output, 'runtime'), { recursive: true });
await build({ define, entryPoints: ['packages/runtime3-bridge/src/bootstrap.ts'], outfile: join(output, 'runtime/cocos-mcp.js'), bundle: true,
  platform: 'browser', target: 'es2018', format: 'iife', globalName: 'CocosMCPRuntime', sourcemap: true });
await build({ define, entryPoints: ['packages/runtime3-bridge/src/bootstrap.ts'], outfile: join(output, 'runtime/cocos-mcp.mjs'), bundle: true,
  platform: 'browser', target: 'es2018', format: 'esm', sourcemap: true });
console.log('Built MCP server, Creator 2/3 extensions and development runtime bridges in .codex-work/build/');
await build({ define, entryPoints: ['scripts/ui-preview-smoke.ts'], outfile: join(output, 'ui-preview-smoke.mjs'), bundle: true,
  platform: 'node', target: 'node24', format: 'esm', packages: 'external' });
