import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeAcceptanceGuard } from '../scripts/native-acceptance-guard.js';
import { TestWorkspace } from './workspace.js';

test('native acceptance only admits the exact canonical isolated project', async () => {
  const root = await new TestWorkspace().create('native-guard-'), repo = join(root, 'CocosMcp'), target = join(root, 'CocosMcp-UI-Test-3.8.8');
  const other = join(root, 'CocosMcp-UI-Test-3.8.8-production');
  await Promise.all([mkdir(repo), mkdir(target), mkdir(other)]);
  const alias = join(root, 'alias'); await symlink(target, alias);
  const guard = new NativeAcceptanceGuard(repo);
  assert.equal(await guard.project(alias, 3), target);
  await assert.rejects(guard.project(other, 3), { code: 'UNAUTHORIZED' });
});

test('native acceptance distinguishes bridge identity from login and does not claim historical previews', () => {
  const guard = new NativeAcceptanceGuard(process.cwd());
  const editor = { status: 'existing-editor-reused' as const, creatorMajor: 3, instanceId: 'test', pid: 1, loginState: 'logged-in' as const };
  assert.equal(guard.editor(editor, 3), editor);
  for (const loginState of ['logged-out', 'unknown'] as const) assert.throws(() => guard.editor({ ...editor, loginState }, 3), { code: 'UNAUTHORIZED' });
  assert.throws(() => guard.editor(editor, 2), { code: 'UNAUTHORIZED' });
  assert.throws(() => guard.editor(null, 3), { code: 'UNAUTHORIZED' });
  guard.preview({ running: false });
  for (const preview of [{}, { running: true, previewSessionId: '8aa7eaf98ab8b1db9521e4c957f5b913' }]) assert.throws(() => guard.preview(preview), { code: 'RESOURCE_BUSY' });
});
