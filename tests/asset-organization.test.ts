import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { AssetOrganization } from '../packages/creator3-adapter/src/asset-organization.js';
import { Creator3Adapter } from '../packages/creator3-adapter/src/index.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';
import { AtomicJsonFile } from '../packages/native-adapters/src/atomic-json.js';
import { FileSnapshots } from '../packages/native-adapters/src/file-snapshot.js';

class OrganizationHarness {
  root = ''; calls: string[] = []; failAt = ''; sequence = 0; failAfterMove = false; failTargetRead = false;
  async open(): Promise<void> { this.root = await mkdtemp(join(process.env.TMPDIR!, 'organization-')); await mkdir(join(this.root, 'assets')); }
  path(url: string): string { return join(this.root, 'assets', url.slice('db://assets/'.length)); }
  async put(name: string, content = '{}'): Promise<void> {
    const path = join(this.root, 'assets', name); await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content); await writeFile(`${path}.meta`, JSON.stringify({ uuid: `uuid-${++this.sequence}` }));
  }
  port(): EditorPort { return { projectPath: this.root, version: '3.8.8', request: async (_channel: string, method: string, ...args: unknown[]) => {
    const url = String(args[0]), path = this.path(url); this.calls.push(`${method}:${url}`);
    if (method === 'create-asset') {
      if (args[1] === null) await mkdir(path); else await writeFile(path, String(args[1]));
      await writeFile(`${path}.meta`, JSON.stringify({ uuid: `uuid-${++this.sequence}` }));
      return { uuid: `uuid-${this.sequence}`, url };
    }
    if (method === 'query-asset-info') {
      if (this.failTargetRead && url.includes('/Materials/')) { this.failTargetRead = false; throw new Error('simulated verification read failure'); }
      try { return { ...JSON.parse(await readFile(`${path}.meta`, 'utf8')), url }; } catch { return null; }
    }
    if (method === 'move-asset') {
      if (url === this.failAt) throw new Error('simulated move failure');
      await rename(path, this.path(String(args[1]))); await rename(`${path}.meta`, `${this.path(String(args[1]))}.meta`);
      if (this.failAfterMove) throw new Error('simulated lost native move reply');
      return {};
    }
    throw new Error(`Unexpected ${method}`);
  } } as unknown as EditorPort; }
  service(): AssetOrganization { return new AssetOrganization(this.port()); }
  async close(): Promise<void> { await rm(this.root, { recursive: true, force: true }); }
}

test('creation reuses existing type folder, creates missing parents through AssetDB, and preserves explicit paths', async () => {
  const h = new OrganizationHarness(); await h.open();
  try {
    await mkdir(join(h.root, 'assets', 'effects')); await writeFile(join(h.root, 'assets', 'effects.meta'), '{"uuid":"folder"}');
    const location = await h.service().location('db://assets/Test.effect'); assert.equal(location.url, 'db://assets/effects/Test.effect'); assert.equal(location.reuseExistingFolder, true); assert.equal(h.calls.length, 0);
    const result = await new Creator3Adapter(h.port()).execute('asset.create', { url: 'db://assets/Test.mtl', content: '{}' }) as JsonObject;
    assert.equal((result.assetLocation as JsonObject).url, 'db://assets/Materials/Test.mtl');
    assert.equal(await readFile(join(h.root, 'assets', 'Materials', 'Test.mtl'), 'utf8'), '{}');
    await assert.rejects(h.service().prepare('asset.create', { url: 'db://assets/Test.mtl', content: '{}' }), /already exists/);
    const explicit = await h.service().prepare('shader.create', { url: 'db://assets/Feature/Shaders/Water.effect' }); assert.equal(explicit.params.url, 'db://assets/Feature/Shaders/Water.effect');
    assert.deepEqual(await h.service().prepare('shader.update', { url: 'db://assets/Legacy.effect' }), { params: { url: 'db://assets/Legacy.effect' } });
  } finally { await h.close(); }
});

class CheckpointFault extends AtomicJsonFile {
  calls = 0; path = '';
  constructor(private readonly failAt: number, private readonly afterWrite = false, private readonly continuous = false) { super(); }
  override async write(path: string, value: unknown): Promise<void> {
    this.path = path; const fail = ++this.calls === this.failAt || this.continuous && this.calls > this.failAt;
    if (fail && !this.afterWrite) throw new Error('checkpoint-before-write');
    await super.write(path, value);
    if (fail) throw new Error('checkpoint-after-write');
  }
}

class MetadataRace extends FileSnapshots {
  override async read(path: string, limit: number, collectText = false) {
    const snapshot = await super.read(path, limit, collectText);
    if (path.endsWith('.mtl')) await writeFile(path + '.meta', '{"uuid":"changed-during-content-hash"}');
    return snapshot;
  }
}

class ModelReviewRace extends FileSnapshots {
  override async read(path: string, limit: number, collectText = false) {
    const snapshot = await super.read(path, limit, collectText);
    if (path.endsWith('.gltf') && collectText) await writeFile(path, '{"buffers":[{"uri":"external.bin"}]}');
    return snapshot;
  }
}

test('resource plans reject metadata changes during hashing and models changed after reference review', async () => {
  const h = new OrganizationHarness(); await h.open();
  try {
    await h.put('A.mtl');
    await assert.rejects(new AssetOrganization(h.port(), undefined, new MetadataRace()).plan({}), { code: 'STALE_REVISION' });
    await h.put('Mesh.gltf');
    await assert.rejects(new AssetOrganization(h.port(), undefined, new ModelReviewRace()).plan({ urls: ['db://assets/Mesh.gltf'] }), { code: 'STALE_REVISION' });
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test('organization recovery reconciles every journal and native failure boundary without replay', async () => {
  for (const scenario of [
    { at: 1, after: false, moved: false }, { at: 1, after: true, moved: false },
    { at: 2, after: false, moved: false }, { at: 2, after: true, moved: false },
    { at: 3, after: false, moved: true }, { at: 3, after: true, moved: true },
    { at: 4, after: false, moved: true }, { at: 4, after: true, moved: true },
    { at: 0, after: false, moved: false, native: 'before-move' },
    { at: 0, after: false, moved: true, native: 'after-move' },
    { at: 0, after: false, moved: true, native: 'verification' },
    { at: 3, after: false, moved: true, continuous: true },
  ]) {
    const h = new OrganizationHarness(); await h.open();
    try {
      await h.put('A.mtl');
      h.failAt = scenario.native === 'before-move' ? 'db://assets/A.mtl' : '';
      h.failAfterMove = scenario.native === 'after-move'; h.failTargetRead = scenario.native === 'verification';
      const writer = new CheckpointFault(scenario.at, scenario.after, scenario.continuous), service = new AssetOrganization(h.port(), writer);
      const plan = await service.plan({}); let thrown: CocosError | undefined;
      try { const result = await service.apply({ planHash: plan.planHash! }); assert.equal(result.status, 'partial'); }
      catch (error) { assert.ok(error instanceof CocosError); thrown = error; assert.equal(Json.object(error.details).journal, writer.path); }
      const movesBeforeRecovery = h.calls.filter(call => call.startsWith('move-asset:')).length;
      if (scenario.at === 1 && !scenario.after) {
        assert.equal(thrown?.code, 'EDITOR_ERROR'); assert.equal(movesBeforeRecovery, 0);
        await assert.rejects(lstat(writer.path), { code: 'ENOENT' });
      } else {
        const recorded = JSON.parse(await readFile(writer.path, 'utf8'));
        const recovered = await service.recovery(recorded.journalId);
        assert.equal((recovered.rows as JsonObject[])[0]!.state, scenario.moved ? 'moved' : 'not-moved', JSON.stringify(scenario));
        assert.equal(h.calls.filter(call => call.startsWith('move-asset:')).length, movesBeforeRecovery);
      }
      if (scenario.at === 4 || scenario.continuous) assert.equal(thrown?.code, 'OUTCOME_UNKNOWN');
      if (scenario.continuous) {
        const detail = Json.object(thrown!.details);
        assert.equal((detail.completed as JsonObject[]).length, 1);
        assert.equal(Json.object(detail.originalError).code, 'OUTCOME_UNKNOWN');
      }
    } finally { await h.close(); }
  }
});

test('plan/apply preserves UUID and records inverse paths; changed sources or target collisions invalidate plan', async () => {
  const h = new OrganizationHarness(); await h.open();
  try {
    await h.put('Water.effect', 'shader'); const service = h.service();
    const first = await service.plan({}); await writeFile(join(h.root, 'assets', 'Water.effect'), 'changed');
    await assert.rejects(service.apply({ planHash: first.planHash! }), /plan changed/); assert.equal(h.calls.length, 0);
    const fresh = await service.plan({}); const result = await service.apply({ planHash: fresh.planHash! });
    assert.equal(result.status, 'completed'); const moved = (result.rows as JsonObject[])[0]!;
    assert.equal(moved.uuid, 'uuid-1'); assert.equal(moved.verified, true); assert.equal((moved.rollback as JsonObject).targetUrl, 'db://assets/Water.effect');
    assert.equal((await service.plan({})).count, 0);
    await h.put('Water.effect', 'collision'); const conflict = await service.plan({}); assert.equal((conflict.skipped as JsonObject[])[0]!.reason, 'target-conflict');
    assert.ok((await readFile(String(result.journal), 'utf8')).includes('completed'));
  } finally { await h.close(); }
});

test('plan keeps business classification and protects loading paths, bundles, relative model dependencies, scripts and symlinks', async () => {
  const h = new OrganizationHarness(); await h.open();
  try {
    await h.put('Game/Materials/A.mtl'); await h.put('resources/B.mtl'); await h.put('Pack/C.mtl');
    await writeFile(join(h.root, 'assets', 'Pack.meta'), '{"uuid":"pack","userData":{"isBundle":true}}');
    await h.put('Code.ts'); await h.put('Mesh.gltf', '{"buffers":[{"uri":"external.bin"}]}');
    const plan = await h.service().plan({ recursive: true }); assert.equal(plan.count, 0);
    assert.deepEqual(new Set((plan.skipped as JsonObject[]).map(row => row.reason)), new Set(['already-organized', 'protected-loading-path', 'requires-reference-review', 'external-model-dependencies']));
    await symlink(join(h.root, 'assets', 'Game'), join(h.root, 'assets', 'Alias'));
    await assert.rejects(h.service().location('db://assets/Alias/Test.mtl'), /symlinks/);
    await assert.rejects(h.service().location('db://assets/../escape.mtl'), /traversal/);
  } finally { await h.close(); }
});

test('partial failures stop immediately and keep successful moves plus pending intent in recovery journal', async () => {
  const h = new OrganizationHarness(); await h.open();
  try {
    await h.put('A.mtl'); await h.put('B.mtl'); h.failAt = 'db://assets/B.mtl';
    const plan = await h.service().plan({}); const result = await h.service().apply({ planHash: plan.planHash! });
    assert.equal(result.status, 'partial'); assert.equal((result.rows as JsonObject[]).length, 1); assert.equal((result.pending as JsonObject).sourceUrl, h.failAt);
    assert.ok((await lstat(join(h.root, 'assets', 'B.mtl'))).isFile());
    assert.equal(JSON.parse(await readFile(String(result.journal), 'utf8')).status, 'partial');
  } finally { await h.close(); }
});

test('metadata symlinks are rejected before moving or reading their content', async () => {
  const h = new OrganizationHarness(); await h.open();
  try {
    await h.put('A.mtl'); await rm(join(h.root, 'assets', 'A.mtl.meta'));
    await writeFile(join(h.root, 'metadata.json'), '{"uuid":"outside-assets"}');
    await symlink(join(h.root, 'metadata.json'), join(h.root, 'assets', 'A.mtl.meta'));
    await assert.rejects(h.service().plan({}), /metadata.*symlink/); assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test('scoped plans avoid unrelated deep metadata and reuse the shallowest type directory', async () => {
  const h = new OrganizationHarness(); await h.open();
  try {
    await h.put('Requested/A.mtl'); await h.put('Other/B.mtl');
    await mkdir(join(h.root, 'assets/Materials'));
    await mkdir(join(h.root, 'assets/Other/Broken'), { recursive: true });
    await writeFile(join(h.root, 'assets/Other/Broken.meta'), 'invalid-unrelated-metadata');
    const plan = await h.service().plan({ scopeUrl: 'db://assets/Requested' });
    assert.equal(plan.count, 1);
    assert.equal((plan.rows as JsonObject[])[0]!.targetUrl, 'db://assets/Materials/A.mtl');
    const explicit = await h.service().plan({ urls: ['db://assets/Requested/A.mtl'] });
    assert.equal(explicit.count, 1);
  } finally { await h.close(); }
});

test('recursive plans report protected directory summaries without traversing their contents', async () => {
  const h = new OrganizationHarness(); await h.open();
  try {
    await h.put('resources/Nested/A.mtl');
    await writeFile(join(h.root, 'assets/resources/Nested.meta'), 'invalid-protected-metadata');
    const plan = await h.service().plan({ recursive: true });
    assert.equal(plan.count, 0);
    assert.ok((plan.skipped as JsonObject[]).some(row => row.url === 'db://assets/resources' && row.descendantsScanned === false));
  } finally { await h.close(); }
});

test('recovery reconciles moved, untouched, conflicting and missing assets without replaying moves', async () => {
  const h = new OrganizationHarness(); await h.open();
  try {
    await h.put('A.mtl'); await h.put('B.mtl'); h.failAt = 'db://assets/B.mtl';
    const service = h.service(), plan = await service.plan({}), applied = await service.apply({ planHash: plan.planHash! });
    const id = String(applied.journalId), moves = h.calls.filter(row => row.startsWith('move-asset:')).length;
    const recovered = await service.recovery(id);
    assert.deepEqual((recovered.rows as JsonObject[]).map(row => row.state), ['moved', 'not-moved']);
    assert.equal(recovered.automaticReplayAllowed, false);
    await writeFile(join(h.root, 'assets/Materials/A.mtl'), 'user-modified');
    await rm(join(h.root, 'assets/B.mtl'));
    const changed = await service.recovery(id);
    assert.deepEqual((changed.rows as JsonObject[]).map(row => row.state), ['conflict', 'unknown']);
    assert.equal(h.calls.filter(row => row.startsWith('move-asset:')).length, moves);
    await assert.rejects(service.recovery('../escape'), /journalId/);
    await writeFile(String(applied.journal), '{');
    await assert.rejects(service.recovery(id), /damaged/);
  } finally { await h.close(); }
});
