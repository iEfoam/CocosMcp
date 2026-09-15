import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { TextureService } from '../packages/creator3-adapter/src/texture.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';

class TextureHarness {
  root = ''; writes = 0; failImport = false;
  meta: JsonObject = { uuid: 'image', importer: 'image', userData: { type: 'sprite-frame' }, subMetas: { t: { uuid: 'texture', importer: 'texture', userData: { minfilter: 'nearest', magfilter: 'nearest', mipfilter: 'none', other: 'preserve' } }, s: { uuid: 'sprite', importer: 'sprite-frame', userData: {} } } };
  async setup(): Promise<TextureService> {
    this.root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/texture-')); await mkdir(join(this.root, 'assets')); await writeFile(join(this.root, 'assets/pic.png'), 'source-image');
    return new TextureService({ version: '3.8.8', projectPath: this.root, request: async (_channel: string, method: string, ...args: unknown[]) => {
      if (method === 'query-asset-info') return { uuid: 'image', url: 'db://assets/pic.png' };
      if (method === 'query-asset-meta') return Json.value(this.meta);
      if (method === 'query-asset-users') return ['consumer'];
      if (method === 'save-asset-meta') { this.writes++; this.meta = JSON.parse(String(args[1])); return true; }
      if (method === 'reimport-asset') { if (this.failImport) throw new Error('import failed'); return true; }
      throw new Error(method);
    } } as EditorPort);
  }
  params(): JsonObject { return { url: 'db://assets/pic.png', settings: { minfilter: 'linear', mipfilter: 'linear' } }; }
}

test('texture planning and guarded import preserve unrelated metadata and restore exact source settings', async () => {
  const h = new TextureHarness(), service = await h.setup(), original = Json.value(h.meta), p = h.params();
  const plan = Json.object(await service.execute('texture.plan_import', p)); assert.equal(h.writes, 0);
  const applied = Json.object(await service.execute('texture.apply_import', { ...p, planHash: plan.planHash! }));
  assert.equal(Json.object(Json.object(Json.object(h.meta.subMetas).t).userData).other, 'preserve');
  assert.equal(Json.object(Json.object(h.meta.subMetas).s).uuid, 'sprite');
  const restored = Json.object(await service.execute('texture.restore_import', { url: p.url!, backupId: applied.backupId!, expectedHash: applied.expectedHash! }));
  assert.equal(restored.restored, true); assert.deepEqual(h.meta, original);
  assert.deepEqual(Json.object(await service.execute('texture.inspect', { url: p.url! })).users, ['consumer']);
});

test('texture source changes, invalid settings, path traversal and escaping symlinks reject before writes', async () => {
  const h = new TextureHarness(), service = await h.setup(), p = h.params(), plan = Json.object(await service.execute('texture.plan_import', p));
  await writeFile(join(h.root, 'assets/pic.png'), 'new-source');
  await assert.rejects(() => service.execute('texture.apply_import', { ...p, planHash: plan.planHash! }), /plan changed/);
  await assert.rejects(() => service.execute('texture.plan_import', { ...p, settings: { anisotropy: 99 } }), /Invalid texture/);
  await assert.rejects(() => service.execute('texture.inspect', { url: 'db://assets/../outside.png' }), /traversal/);
  await symlink(process.cwd(), join(h.root, 'assets/escape'));
  await assert.rejects(() => service.execute('texture.inspect', { url: 'db://assets/escape/package.json' }), /escapes/);
  assert.equal(h.writes, 0);
});

test('failed imports retain backup identity and guarded restore rejects later edits', async () => {
  const h = new TextureHarness(), service = await h.setup(), p = h.params(), plan = Json.object(await service.execute('texture.plan_import', p));
  h.failImport = true;
  let backupId = '';
  await assert.rejects(() => service.execute('texture.apply_import', { ...p, planHash: plan.planHash! }), error => {
    backupId = String(Json.object(Json.object(error).details).backupId); assert.ok(backupId); return true;
  });
  h.failImport = false;
  await assert.rejects(() => service.execute('texture.restore_import', { url: p.url!, backupId, expectedHash: plan.expectedHash! }), /changed/);
  const current = Json.object(await service.execute('texture.inspect', { url: p.url! }));
  assert.equal(Json.object(await service.execute('texture.restore_import', { url: p.url!, backupId, expectedHash: current.expectedHash! })).restored, true);
});
