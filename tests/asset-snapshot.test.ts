import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, rename, appendFile, symlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { FileSnapshots } from '../packages/native-adapters/src/file-snapshot.js';
import { TestWorkspace } from './workspace.js';

class ChangingSnapshot extends FileSnapshots {
  constructor(private readonly change: (path: string) => Promise<void>) { super(); }
  protected override async *chunks(path: string, file: FileHandle, limit: number): AsyncIterable<Buffer> {
    let changed = false;
    for await (const chunk of super.chunks(path, file, limit)) {
      if (!changed) { changed = true; await this.change(path); }
      yield chunk;
    }
  }
}

test('asset snapshots enforce exact budgets, produce matching hashes and reject symlinks', async () => {
  const root = await new TestWorkspace().create('asset-snapshot-'), path = join(root, 'source'), bytes = Buffer.from('原始内容');
  await writeFile(path, bytes); const reader = new FileSnapshots();
  const snapshot = await reader.read(path, bytes.length, true);
  assert.equal(snapshot.text, bytes.toString()); assert.equal(snapshot.bytes, bytes.length);
  assert.equal(snapshot.sha256, createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(reader.read(path, bytes.length - 1), { code: 'RESOURCE_BUSY' });
  await symlink(path, join(root, 'alias'));
  await assert.rejects(reader.read(join(root, 'alias'), 1024), { code: 'INVALID_ARGUMENT' });
  await writeFile(path, ''); assert.equal((await reader.read(path, 0)).bytes, 0);
});

test('asset snapshot refuses growth, in-place edits and path replacement during streaming', async () => {
  const root = await new TestWorkspace().create('asset-races-'), path = join(root, 'source');
  for (const mode of ['grow', 'edit', 'replace']) {
    await writeFile(path, Buffer.alloc(256 * 1024, 1));
    const reader = new ChangingSnapshot(async target => {
      if (mode === 'grow') await appendFile(target, Buffer.alloc(100));
      else if (mode === 'edit') await writeFile(target, Buffer.alloc(100, 2));
      else { await rename(target, target + '.old'); await writeFile(target, Buffer.alloc(256 * 1024, 1)); }
    });
    await assert.rejects(reader.read(path, 256 * 1024), error => {
      assert.ok(error instanceof Error && 'code' in error);
      assert.ok(['RESOURCE_BUSY', 'STALE_REVISION'].includes(String(error.code)), `${mode}: ${error.message}`); return true;
    });
  }
});
