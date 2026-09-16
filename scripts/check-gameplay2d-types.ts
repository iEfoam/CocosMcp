import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GameplayTemplates } from '../packages/gameplay2d-core/src/templates.js';

// 校验生成的项目源码，而不只校验生成器字符串；声明文件由已安装 Creator 提供。
const declaration = process.argv[2];
if (!declaration) throw new Error('Pass the installed Creator cc.d.ts path');
const directory = resolve('.codex-work/build/gameplay2d-types'); await mkdir(directory, { recursive: true });
const templates = new GameplayTemplates(), files: string[] = [];
for (const [index, name] of Object.keys(templates.rows).entries()) {
  const path = join(directory, `Generated${index}.ts`); files.push(path);
  await writeFile(path, templates.source(name, `Generated${index}`).source);
}
const config = join(directory, 'tsconfig.json');
await writeFile(config, JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, experimentalDecorators: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'node', types: [] }, files: [resolve(declaration), ...files] }, null, 2));
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', config], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (!process.exitCode) console.log(`Checked ${files.length} generated components against installed Creator declarations`);
