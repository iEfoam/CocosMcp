import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AnimationEditService } from '../packages/creator3-adapter/src/animation-edit.js';
import { Json } from '../packages/contracts/src/index.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';
class EditHarness {
  root = ''; writes = 0; failReadback = false;
  async setup(): Promise<AnimationEditService> {
    this.root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/animation-edit-')); await mkdir(join(this.root, 'assets')); await writeFile(join(this.root, 'assets/move.anim'), '{"original":true}');
    return new AnimationEditService({ projectPath: this.root, version: '3.8.8', request: async (_channel: string, method: string, ...args: unknown[]) => {
      if (method === 'query-asset-info') return { uuid: 'clip' };
      if (method === 'save-asset') { this.writes++; await writeFile(join(this.root, 'assets/move.anim'), String(args[1])); return { uuid: 'clip' }; }
      throw new Error(method);
    }, scene: async (method: string) => {
      if (method === 'animation.clip.patchSource') return { nativeSerialized: true };
      if (this.failReadback) throw new Error('import pending'); return { uuid: 'clip' };
    } } as EditorPort);
  }
}
test('animation patch and restore use AssetDB, preserve UUID and refuse stale or cross-asset backups', async () => {
  const h = new EditHarness(), service = await h.setup(), url = 'db://assets/move.anim';
  const before = Json.object(await service.execute('animation.clip.read', { url }));
  const patch = Json.object(await service.execute('animation.clip.patch', { url, expectedHash: before.sourceHash!, patches: [{ trackIndex: 0, keys: [{ time: 0, value: { x: 0, y: 0, z: 0 } }] }] }));
  assert.equal(patch.uuid, 'clip'); assert.equal(h.writes, 1);
  await assert.rejects(() => service.execute('animation.clip.patch', { url, expectedHash: before.sourceHash!, patches: [{ trackIndex: 0, keys: [{ time: 0, value: { x: 0, y: 0, z: 0 } }] }] }), /changed/); assert.equal(h.writes, 1);
  const restored = Json.object(await service.execute('animation.clip.restore', { url, expectedHash: patch.sourceHash!, backupId: patch.backupId! }));
  assert.equal(restored.sourceHash, before.sourceHash); assert.equal(await readFile(join(h.root, 'assets/move.anim'), 'utf8'), '{"original":true}');
  await assert.rejects(() => service.execute('animation.clip.restore', { url, expectedHash: before.sourceHash!, backupId: '../escape' }), /backup ID/);
});
test('animation import readback failure reports backup and actual resource identity without blind rollback', async () => {
  const h = new EditHarness(), service = await h.setup(), url = 'db://assets/move.anim';
  const before = Json.object(await service.execute('animation.clip.read', { url })); h.failReadback = true;
  await assert.rejects(() => service.execute('animation.clip.patch', { url, expectedHash: before.sourceHash!, patches: [{ trackIndex: 0, keys: [{ time: 0, value: { x: 0, y: 0, z: 0 } }] }] }), error => {
    const details = Json.object(Json.object(error).details); assert.equal(details.uuid, 'clip'); assert.ok(details.backupId); return true;
  }); assert.equal(h.writes, 1);
});
