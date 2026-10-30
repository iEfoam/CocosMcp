import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { AssetReferenceAudit } from '../packages/asset-policy/src/reference-audit.js';
import { Creator2Adapter } from '../packages/creator2-adapter/src/index.js';
import { Creator3Adapter } from '../packages/creator3-adapter/src/index.js';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { OutputContracts } from '../packages/capability-catalog/src/output-contracts.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
import { TestWorkspace } from './workspace.js';

test('reference review matches compressed UUIDs while retaining raw evidence and subasset boundaries', () => {
  const full = 'fc991dd7-0033-4b80-9d41-c8a86a702e59', compressed = 'fcmR3XADNLgJ1ByKhqcC5Z';
  const result = new AssetReferenceAudit(process.cwd()).inspect('db://assets/Panel.prefab', JSON.stringify([
    { texture: { __uuid__: compressed } }, { texture: { __uuid__: compressed + '@sub' } },
  ]), [{ url: 'db://assets/Textures/Image.png', uuid: full.toUpperCase() }]);
  const rows = (result.rows as JsonObject[]).filter(row => row.kind === 'uuid');
  assert.equal(rows[0]!.targetUuid, compressed); assert.equal(rows[0]!.canonicalTargetUuid, full);
  assert.deepEqual(rows[0]!.targetUrls, ['db://assets/Textures/Image.png']);
  assert.equal(rows[1]!.resolved, 'unresolved'); assert.deepEqual(rows[1]!.targetUrls, []);
  assert.ok(rows.every(row => row.automaticRewriteAllowed === false));
});

class ReferenceFixture {
  root = '';
  async setup(): Promise<void> {
    this.root = await new TestWorkspace().create('asset-references-');
    for (const folder of ['resources/ui', 'GameBundle', 'Scripts']) await mkdir(join(this.root, 'assets', folder), { recursive: true });
    await writeFile(join(this.root, 'assets/resources/ui/Card.prefab'), '{}');
    await writeFile(join(this.root, 'assets/resources/ui/Card.prefab.meta'), '{"uuid":"card-uuid"}');
    await writeFile(join(this.root, 'assets/GameBundle/Panel.prefab'), JSON.stringify([{ __type__: 'CustomComponent', card: { __uuid__: 'card-uuid' }, broken: { __uuid__: 'missing-or-compressed' } }]));
    await writeFile(join(this.root, 'assets/GameBundle.meta'), '{"userData":{"isBundle":true,"bundleName":"game"}}');
    await writeFile(join(this.root, 'assets/Scripts/Panel.ts'), [
      '// resources.load("ui/Card") is a comment',
      'resources.load("ui/Card");',
      'assetManager.getBundle("game").load("ui/Card");',
      'resources.load(`ui/${name}`);',
      'cc.loader.loadRes("ui/" + name);',
    ].join('\n'));
  }
  params(): JsonObject { return { urls: ['db://assets/resources/ui/Card.prefab'] }; }
}

test('reference audit separates UUID fields, literal candidates and unresolved dynamic/Bundle loading without writing assets', async () => {
  const f = new ReferenceFixture(); await f.setup(); const path = join(f.root, 'assets/Scripts/Panel.ts'), before = await readFile(path);
  const result = await new AssetReferenceAudit(f.root).audit(f.params()), rows = result.rows as JsonObject[];
  new OutputContracts().validate('asset.references.scan', result);
  assert.throws(() => new OutputContracts().validate('asset.references.scan', { ...result, referenceCoverageComplete: true }), { code: 'VERIFICATION_FAILED' });
  assert.equal(result.scanComplete, true); assert.equal(result.referenceCoverageComplete, false); assert.equal(result.automaticRewriteAllowed, false);
  const uuid = rows.find(row => row.kind === 'uuid' && row.targetUuid === 'card-uuid')!;
  assert.deepEqual(uuid.targetUrls, f.params().urls); assert.match(String(uuid.jsonPath), /card/);
  assert.equal(rows.find(row => row.targetUuid === 'missing-or-compressed')?.resolved, 'unresolved');
  const literals = rows.filter(row => row.kind === 'literal-path');
  assert.deepEqual(literals.map(row => row.line), [2, 3]); assert.ok(literals.every(row => row.confidence === 'text-candidate-only'));
  assert.ok(rows.some(row => row.confidence === 'template-syntax-only'));
  assert.ok(rows.some(row => row.callName === 'loadRes'));
  assert.ok(rows.every(row => row.automaticRewriteAllowed === false)); assert.deepEqual(await readFile(path), before);
});

test('audit supports both adapter routes and declares a read-only public capability', async () => {
  const f = new ReferenceFixture(); await f.setup();
  const creator2 = new Creator2Adapter({ projectPath: f.root, version: '2.4.15' } as ConstructorParameters<typeof Creator2Adapter>[0]);
  const creator3 = new Creator3Adapter({ projectPath: f.root, version: '3.8.8' } as ConstructorParameters<typeof Creator3Adapter>[0]);
  for (const adapter of [creator2, creator3]) {
    assert.ok(adapter.supportedCapabilities().includes('asset.references.scan'));
    assert.ok((Json.object(await adapter.execute('asset.references.scan', f.params())).rows as unknown[]).length > 0);
  }
  const capability = new CapabilityCatalog().validate('asset.references.scan', f.params()); assert.equal(capability.effect, 'read');
  assert.equal(new CapabilityCatalog().validate('asset.references.audit', { url: 'db://assets/Panel.prefab' }).effect, 'read');
});

test('audit exposes incomplete scopes and malformed sources, rejects metadata links and oversized files', async () => {
  const f = new ReferenceFixture(); await f.setup(); const audit = new AssetReferenceAudit(f.root);
  assert.equal((await audit.audit({ ...f.params(), recursive: false })).scanComplete, false);
  await writeFile(join(f.root, 'assets/broken.json'), '{invalid');
  assert.ok(((await audit.audit(f.params())).issues as JsonObject[]).some(row => row.code === 'STRUCTURED_PARSE_UNAVAILABLE'));
  await symlink(join(f.root, 'assets/resources'), join(f.root, 'assets/alias'));
  assert.ok(((await audit.audit(f.params())).skipped as JsonObject[]).some(row => row.reason === 'symbolic-link'));
  await assert.rejects(audit.audit({ urls: ['db://assets/alias/ui/Card.prefab'] }), { code: 'PATH_OUTSIDE_PROJECT' });
  await writeFile(join(f.root, 'assets/Linked.prefab'), '{}');
  await symlink(join(f.root, 'assets/resources/ui/Card.prefab.meta'), join(f.root, 'assets/Linked.prefab.meta'));
  await assert.rejects(audit.audit({ urls: ['db://assets/Linked.prefab'] }), { code: 'INVALID_ARGUMENT' });
  const file = await open(join(f.root, 'assets/Large.ts'), 'wx'); try { await file.truncate(8 * 1024 * 1024 + 1); } finally { await file.close(); }
  await assert.rejects(audit.audit(f.params()), { code: 'RESOURCE_BUSY' });
});

test('same short path preserves all candidates and excessive lexical uncertainty refuses a partial success', () => {
  const audit = new AssetReferenceAudit('/unused');
  const result = audit.inspect('db://assets/Script.ts', 'const path = "ui/Card";', [
    { url: 'db://assets/resources/ui/Card.prefab', uuid: 'one' }, { url: 'db://assets/Bundle/ui/Card.prefab', uuid: 'two' },
  ]);
  assert.equal(((result.rows as JsonObject[])[0]!.targetUrls as string[]).length, 2);
  assert.throws(() => audit.inspect('db://assets/Script.ts', String.raw`'ui\x2fCard';`.repeat(1001), []), { code: 'RESOURCE_BUSY' });
});
