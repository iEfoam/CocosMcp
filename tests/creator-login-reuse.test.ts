import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, utimes, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CreatorAccount, type ExistingCreator, type CreatorInstance } from '../scripts/creator-account.mjs';
import { CreatorLauncher } from '../scripts/creator-launcher.mjs';
import { EditorBridge } from '../packages/editor-bridge/src/index.js';
import { TestWorkspace } from './workspace.js';

class AccountFixture extends CreatorAccount {
  current: ExistingCreator | null = null;
  override async existing(): Promise<ExistingCreator | null> { return this.current; }
  override async processState(): Promise<'creator'> { return 'creator'; }
}
class LauncherFixture extends CreatorLauncher {
  spawned = 0; live = false; onSpawn = (): void => {}; lastOptions: SpawnOptions | undefined;
  override alive(): boolean { return this.live; }
  override spawnEditor(_executable: string, _args: string[], options: SpawnOptions): ChildProcess {
    this.spawned++; this.lastOptions = options; this.onSpawn();
    const child = Object.assign(new EventEmitter(), { pid: 999991, unref: () => {} });
    queueMicrotask(() => child.emit('spawn')); return child as unknown as ChildProcess;
  }
}
class LoginFixture {
  root = ''; binary = ''; local = ''; account!: AccountFixture; launcher!: LauncherFixture;
  native: Record<string, unknown> = { session_id: 'fixture-session', session_key: 'fixture-key', cocos_uid: 'fixture-user' };
  relative = 'profiles/v2/editor/user.json';
  async setup(): Promise<void> {
    this.root = await new TestWorkspace().create('login-reuse-'); this.local = join(this.root, 'native-account');
    this.binary = join(this.root, 'CocosCreator'); await writeFile(this.binary, 'test double; never executed');
    await mkdir(join(this.local, 'profiles/v2/editor'), { recursive: true }); await writeFile(join(this.local, this.relative), JSON.stringify(this.native));
    this.account = new AccountFixture(this.local); this.launcher = new LauncherFixture(this.account, { timeoutMs: 5, pollMs: 1 });
  }
  editor(loginState: CreatorInstance['loginState'] = 'logged-in'): CreatorInstance {
    return { status: loginState === 'logged-out' ? 'existing-editor-login-required' : 'existing-editor-reused', instanceId: 'a'.repeat(24), creatorMajor: 3, pid: 999991, loginState };
  }
  async launch(): Promise<Record<string, unknown>> { return this.launcher.launch(this.root, this.binary, 3); }
  async journal(): Promise<Record<string, unknown>> { return JSON.parse(await readFile(join(this.root, '.codex-work/cache/creator-session/launch.json'), 'utf8')); }
}

test('existing Creator windows are reused before credentials are touched, including logged-out and legacy unknown states', async () => {
  const f = new LoginFixture(); await f.setup();
  await writeFile(join(f.local, f.relative), 'malformed-native-profile');
  for (const state of ['logged-in', 'logged-out', 'unknown'] as const) {
    f.account.current = f.editor(state); const result = await f.launch();
    assert.equal(result.loginState, state); assert.equal(f.launcher.spawned, 0);
  }
  await assert.rejects(stat(join(f.root, '.codex-work')), { code: 'ENOENT' });
});

test('an unverified startup is recorded once, blocks the same session and resumes after a newer same-account session', async () => {
  const f = new LoginFixture(); await f.setup();
  assert.equal((await f.launch()).status, 'editor-start-unverified');
  assert.equal((await f.launch()).status, 'session-retry-blocked'); assert.equal(f.launcher.spawned, 1);
  assert.equal((await f.journal()).state, 'unverified');
  const target = join(f.root, '.codex-work/cache/creator-home', f.relative);
  await writeFile(join(f.local, f.relative), JSON.stringify({ ...f.native, session_id: 'renewed-session' }));
  await utimes(target, 100, 100); await utimes(join(f.local, f.relative), 200, 200);
  f.launcher.onSpawn = () => { f.account.current = f.editor(); };
  const result = await f.launch(); assert.equal(result.loginState, 'logged-in'); assert.equal(f.launcher.spawned, 2);
  assert.equal((await f.journal()).state, 'ready'); assert.ok(result.backupPath);
  assert.doesNotMatch(JSON.stringify(result), /fixture-key|renewed-session|credentialFingerprint/);
  assert.equal(f.launcher.lastOptions?.stdio, 'ignore');
});

test('late login reconciles the original launch and permits reopening after its process exits', async () => {
  const f = new LoginFixture(); await f.setup(); await f.launch();
  f.account.current = f.editor(); assert.equal((await f.launch()).loginState, 'logged-in');
  assert.equal((await f.journal()).state, 'ready'); assert.equal(f.launcher.spawned, 1);
  f.account.current = null; f.launcher.onSpawn = () => { f.account.current = f.editor(); };
  await f.launch(); assert.equal(f.launcher.spawned, 2);
});

test('live launches without a bridge and unknown dispatch outcomes never open another window', async () => {
  const f = new LoginFixture(); await f.setup(); await f.launch(); f.launcher.live = true;
  assert.equal((await f.launch()).status, 'existing-launch-present'); assert.equal(f.launcher.spawned, 1);
  f.launcher.live = false;
  const path = join(f.root, '.codex-work/cache/creator-session/launch.json');
  await writeFile(path, JSON.stringify({ ...await f.journal(), state: 'reserved', pid: null }));
  assert.equal((await f.launch()).status, 'launch-outcome-unknown'); assert.equal(f.launcher.spawned, 1);
});

test('native logged-out results preserve the current window and block relaunch after it closes', async () => {
  const f = new LoginFixture(); await f.setup(); f.launcher.onSpawn = () => { f.account.current = f.editor('logged-out'); };
  assert.equal((await f.launch()).status, 'existing-editor-login-required'); assert.equal((await f.journal()).state, 'login-required');
  await f.launch(); assert.equal(f.launcher.spawned, 1);
  f.account.current = null; assert.equal((await f.launch()).status, 'session-retry-blocked'); assert.equal(f.launcher.spawned, 1);
});

test('incomplete or corrupt launch journals fail closed without replacing the evidence or spawning', async () => {
  const f = new LoginFixture(); await f.setup(); await f.launch();
  const path = join(f.root, '.codex-work/cache/creator-session/launch.json'), original = await f.journal();
  for (const bytes of ['{broken', JSON.stringify({ schemaVersion: 1, state: 'starting' }), JSON.stringify({ ...original, pid: -1 }), JSON.stringify({ ...original, credentialFingerprint: '' })]) {
    await writeFile(path, bytes); await assert.rejects(f.launch(), /cannot be read safely|Unknown or incomplete/);
    assert.equal(await readFile(path, 'utf8'), bytes); assert.equal(f.launcher.spawned, 1);
  }
});

test('concurrent launch attempts create at most one process and preserve a conflicting lock', async () => {
  const f = new LoginFixture(); await f.setup();
  const results = await Promise.allSettled([f.launch(), f.launch()]);
  assert.ok(results.some(row => row.status === 'fulfilled')); assert.equal(f.launcher.spawned, 1);
  const lock = join(f.root, '.codex-work/cache/creator-session/launch.lock');
  await writeFile(lock, 'other-owner'); await assert.rejects(f.launch(), /already running or needs recovery/);
  assert.equal(await readFile(lock, 'utf8'), 'other-owner');
});

test('Creator 2 and dry-run never import credentials or launch a login window', async () => {
  const f = new LoginFixture(); await f.setup();
  await f.launcher.plan(f.root, f.binary, 3);
  assert.equal((await f.launcher.launch(f.root, f.binary, 2)).status, 'dashboard-required');
  assert.equal(f.launcher.spawned, 0); await assert.rejects(stat(join(f.root, '.codex-work')), { code: 'ENOENT' });
});

test('refresh preserves newer project credentials and active profiles, and rejects backup path escapes', async () => {
  const f = new LoginFixture(); await f.setup(); const initial = await f.account.prepare(f.root, 3), target = join(initial.home, f.relative);
  await writeFile(join(f.local, f.relative), JSON.stringify({ ...f.native, session_key: 'new-key' }));
  await utimes(target, 300, 300); await utimes(join(f.local, f.relative), 200, 200);
  assert.equal((await f.account.prepare(f.root, 3)).account, 'existing-project-session');
  await utimes(target, 100, 100); f.account.current = f.editor();
  assert.equal((await f.account.prepare(f.root, 3)).refreshDeferred, 'editor-open');
  f.account.current = null;
  const outside = await new TestWorkspace().create('login-outside-');
  await mkdir(join(f.root, '.codex-work/backups'), { recursive: true }); await symlink(outside, join(f.root, '.codex-work/backups/creator-account'));
  await assert.rejects(f.account.prepare(f.root, 3), /escapes project/);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), f.native);
});

test('authenticated bridge reports native login separately from identity and prefers a unique logged-in instance', async () => {
  const root = await new TestWorkspace().create('login-bridge-');
  let state: 'logged-in' | 'logged-out' = 'logged-out', fail = false;
  const bridge = new EditorBridge({ major: 3, loginState: async () => { if (fail) throw new Error('private-native-error'); return state; },
    supportedCapabilities: () => [], dispose: async () => {}, revision: async () => { throw new Error('Scene must not be read'); }, execute: async () => null }, root, '3.8.8');
  const legacy = new EditorBridge({ major: 3, supportedCapabilities: () => [], dispose: async () => {}, revision: async () => '', execute: async () => null }, root, '3.8.8');
  try {
    const descriptor = await bridge.start(); await legacy.start();
    const account = new CreatorAccount(root);
    assert.equal((await account.existing(root))?.status, 'existing-editor-ambiguous');
    assert.equal((await account.existing(root, { instanceId: descriptor.instanceId }))?.loginState, 'logged-out');
    state = 'logged-in'; const selected = await account.existing(root);
    assert.equal(selected?.status, 'existing-editor-reused'); assert.equal(selected?.loginState, 'logged-in');
    assert.equal((await account.existing(root, { major: 2 }))?.status, 'existing-editor-mismatch');
    fail = true; const unknown = await account.existing(root, { instanceId: descriptor.instanceId });
    assert.equal(unknown?.loginState, 'unknown'); assert.doesNotMatch(JSON.stringify(unknown), /private-native-error|token|session_key/);
  } finally { await bridge.stop(); await legacy.stop(); }
});
