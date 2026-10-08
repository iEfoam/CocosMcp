import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Creator3PreviewCompiler } from '../extensions/creator3/src/preview-compiler.js';
import { ImporterArtifacts } from '../extensions/shared/importer-artifacts.js';
import type { JsonObject } from '../packages/contracts/src/index.js';

class ProgrammingFixture {
  root = ''; source = 'export const title = "requested";'; compiled = 'const title = "requested";'; readyCalls = 0;
  hash(content: string | Buffer): string { return createHash('sha256').update(content).digest('hex'); }
  async setup(): Promise<void> {
    this.root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/programming-'));
    const directory = join(this.root, 'temp/programming/packer-driver/targets/preview');
    await mkdir(join(this.root, 'assets/Scripts'), { recursive: true }); await mkdir(join(directory, 'chunks/ab'), { recursive: true });
    await writeFile(join(this.root, 'assets/Scripts/Test.ts'), this.source);
    await writeFile(join(directory, 'import-map.json'), JSON.stringify({ imports: { [pathToFileURL(join(this.root, 'assets/Scripts/Test.ts')).href]: './chunks/ab/abcd.js' } }));
    await writeFile(join(directory, 'chunks/ab/abcd.js'), this.compiled);
    await writeFile(join(directory, 'chunks/ab/abcd.js.map'), JSON.stringify({ sourcesContent: [this.source] }));
  }
  compiler(): Creator3PreviewCompiler { return new Creator3PreviewCompiler(this.root, '3.8.8', async () => { this.readyCalls++; }, async () => ({})); }
  batch(): JsonObject { return { sourceRevision: this.hash(this.source), rows: [{ url: 'db://assets/Scripts/Test.ts', sha256: this.hash(this.source) }] }; }
}
test('Creator 3 native completion must also match the requested source map and served chunk bytes', async () => {
  const f = new ProgrammingFixture(); await f.setup();
  const result = await f.compiler().compile(f.batch(), () => false); assert.equal(result.status, 'completed'); assert.equal(f.readyCalls, 1);
  assert.deepEqual(result.artifacts, [{ url: '/scripting/x/chunks/ab/abcd.js', sha256: f.hash(f.compiled), kind: 'script' }]);
  await writeFile(join(f.root, 'temp/programming/packer-driver/targets/preview/chunks/ab/abcd.js.map'), JSON.stringify({ sourcesContent: ['old'] }));
  assert.equal((await f.compiler().compile(f.batch(), () => false)).status, 'unknown');
  assert.equal((await f.compiler().compile(f.batch(), () => true)).status, 'unknown');
});
test('importer manifests preserve native UUID subresources, binary hashes and containment boundaries', async () => {
  const root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/importer-')), uuid = 'ab000000-0000-0000-0000-000000000001';
  const directory = join(root, 'library/ab'); await mkdir(directory, { recursive: true });
  const json = join(directory, `${uuid}.json`), png = join(directory, `${uuid}@native.png`); await writeFile(json, '{"imported":true}'); await writeFile(png, Buffer.from([1, 2, 3]));
  const asset = { uuid, importer: 'image', imported: true, library: { '.json': json }, subAssets: { native: { library: { '.png': png } } } };
  const batch = { sourceRevision: 'revision', rows: [{ url: 'db://assets/test.png', sha256: 'source' }] };
  const result = await new ImporterArtifacts(root, 3, async () => asset).compile(batch, () => false);
  assert.equal(result.status, 'completed'); assert.equal((result.artifacts as JsonObject[]).length, 2);
  assert.equal((result.artifacts as JsonObject[])[1]!.sha256, createHash('sha256').update(await readFile(png)).digest('hex'));
  assert.equal((await new ImporterArtifacts(root, 2, async () => ({ uuid })).compile(batch, () => false)).status, 'unknown');
  const outside = await mkdtemp(join(process.cwd(), '.codex-work/tmp/importer-outside-')); await writeFile(join(outside, `${uuid}.json`), '{}');
  const link = join(directory, `${uuid}@escape.json`); await symlink(join(outside, `${uuid}.json`), link);
  await assert.rejects(new ImporterArtifacts(root, 3, async () => ({ ...asset, library: { '.json': link } })).compile(batch, () => false), { code: 'PATH_OUTSIDE_PROJECT' });
});
