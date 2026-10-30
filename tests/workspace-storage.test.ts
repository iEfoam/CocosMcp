import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, writeFile, readFile, rename, symlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceStorage } from '../scripts/workspace-storage.mjs';
import { TestWorkspace } from './workspace.js';

test('owned test cleanup requires success, unchanged ownership and a complete reference check', async () => {
  const root = await new TestWorkspace().create('storage-'); let clear = false;
  const storage = new WorkspaceStorage(root, async () => ({ clear, reason: 'test references' }));
  const receipt = await storage.createTestRun(); await writeFile(join(receipt.directory, 'fixture'), 'data');
  await assert.rejects(new WorkspaceStorage(root).cleanup(receipt), /not created by this runner/);
  await assert.rejects(storage.cleanup({ ...receipt }), /not created by this runner/);
  assert.equal((await storage.cleanup(receipt)).removed, false);
  await storage.finish(receipt, true); assert.equal((await storage.cleanup(receipt)).removed, false);
  clear = true; assert.equal((await storage.cleanup(receipt)).removed, true);
  await assert.rejects(lstat(receipt.directory), { code: 'ENOENT' });
  const failed = await storage.createTestRun(); await storage.finish(failed, false);
  assert.equal((await storage.cleanup(failed)).removed, false); assert.ok(await lstat(failed.directory));
  const changed = await storage.createTestRun(); await storage.finish(changed, true);
  await writeFile(join(changed.directory, '.codex-task.json'), '{}');
  await assert.rejects(storage.cleanup(changed), /marker changed/);
});

test('cleanup rejects directory replacement and rechecks ownership after reference inspection', async () => {
  const root = await new TestWorkspace().create('storage-races-');
  const storage = new WorkspaceStorage(root, async directory => { await writeFile(join(directory, '.codex-task.json'), '{}'); return { clear: true, reason: 'fixture' }; });
  const receipt = await storage.createTestRun(); await storage.finish(receipt, true);
  await assert.rejects(storage.cleanup(receipt), /marker changed/);
  const other = new WorkspaceStorage(root, async () => ({ clear: true, reason: 'fixture' })), replaced = await other.createTestRun();
  await other.finish(replaced, true); await rename(replaced.directory, replaced.directory + '-original'); await mkdir(replaced.directory);
  await assert.rejects(other.cleanup(replaced), /identity changed/);
});

test('inventory reports ownership, protected evidence and incomplete budgets without following links or deleting', async () => {
  const root = await new TestWorkspace().create('storage-inventory-'), outside = await new TestWorkspace().create('storage-external-');
  const storage = new WorkspaceStorage(root); const receipt = await storage.createTestRun(); await storage.finish(receipt, false);
  const backup = await storage.workDirectory('backups/retained'); await writeFile(join(backup, 'evidence'), 'do not delete');
  await writeFile(join(outside, 'external'), 'outside'); await symlink(outside, join(root, '.codex-work/tmp/external-link'));
  const report = await storage.inventory(); assert.ok(report.rows.every(row => row.canDelete === false));
  assert.equal(report.rows.find(row => row.path === receipt.directory)?.owner?.state, 'failed');
  assert.equal(report.rows.find(row => row.path.endsWith('external-link'))?.complete, true);
  assert.ok((await storage.inventory(1)).rows.some(row => !row.complete));
  assert.equal(await readFile(join(backup, 'evidence'), 'utf8'), 'do not delete');
  await assert.rejects(storage.workDirectory('tmp/external-link/nested'), /symbolic-link/);
  await assert.rejects(lstat(join(outside, 'nested')), { code: 'ENOENT' });
});

test('real open-file inspection protects a live file handle', { skip: process.platform !== 'darwin' }, async () => {
  const root = await new TestWorkspace().create('storage-open-'), storage = new WorkspaceStorage(root), receipt = await storage.createTestRun();
  const handle = await open(join(receipt.directory, 'in-use'), 'wx');
  try { await storage.finish(receipt, true); assert.equal((await storage.cleanup(receipt)).removed, false); }
  finally { await handle.close(); }
  const check = await WorkspaceStorage.openReferences(receipt.directory);
  assert.equal(check.clear, true, check.reason); assert.equal((await storage.cleanup(receipt)).removed, true);
});
