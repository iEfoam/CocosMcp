import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = resolve('.codex-work/build/contract-examples.mjs');
await mkdir(resolve('.codex-work/build'), { recursive: true });
await build({ entryPoints: ['packages/capability-catalog/src/contract-examples.ts'], outfile: output, bundle: true, packages: 'external', platform: 'node', target: 'node24', format: 'esm' });
const { ContractExamples } = await import(pathToFileURL(output).href);
await writeFile('docs/contract-examples.md', new ContractExamples().markdown());
console.log('Validated and generated docs/contract-examples.md');
