import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createServer } from 'node:http';
import { CreatorAccount } from '../scripts/creator-account.mjs';
import { CocosApplication, ProjectRegistry, ProjectPaths } from '../packages/application/src/index.js';
import { BridgeClient } from '../packages/application/src/bridge-client.js';
import { EvidenceStore } from '../packages/application/src/evidence-store.js';
import { OperationAudit } from '../packages/application/src/operation-audit.js';
import { RuntimeViewSession } from '../packages/runtime3-bridge/src/view-session.js';
import { RuntimeUiSelector } from '../packages/runtime3-bridge/src/ui-selector.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import { CocosError, Json, type BridgeDescriptor, type BridgeRequest, type JsonObject, type JsonValue } from '../packages/contracts/src/index.js';

test('local native credentials are reused once without overwriting project authentication or following a symlink', async () => {
  const project = await mkdtemp(join(process.cwd(), '.codex-work/tmp/account-project-')), local = await mkdtemp(join(process.cwd(), '.codex-work/tmp/account-local-'));
  const profile = 'profiles/v2/editor/user.json', source = { session_id: 'fake-id', session_key: 'fake-key', cocos_uid: 'fake-user' };
  await mkdir(join(local, 'profiles/v2/editor'), { recursive: true }); await writeFile(join(local, profile), JSON.stringify(source));
  const account = new CreatorAccount(local), first = await account.prepare(project, 3), target = join(first.home, profile);
  assert.equal(first.account, 'reused-local-native-profile'); assert.equal((await stat(target)).mode & 0o777, 0o600);
  await writeFile(join(local, profile), JSON.stringify({ ...source, session_id: 'other-account' }));
  assert.equal((await account.prepare(project, 3)).account, 'existing-project-session'); assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), source);
  assert.equal((await account.prepare(project, 2)).account, 'unavailable');
  const escaped = await mkdtemp(join(process.cwd(), '.codex-work/tmp/account-escape-')); await mkdir(join(escaped, '.codex-work/cache'), { recursive: true });
  await symlink(local, join(escaped, '.codex-work/cache/creator-home')); await assert.rejects(account.prepare(escaped, 3), /escapes project/);
  await writeFile(target, '{}'); const invalid = await account.prepare(project, 3);
  assert.equal(invalid.account, 'unavailable'); assert.equal(invalid.nextAction, 'inspect-preserved-project-profile'); assert.equal(await readFile(target, 'utf8'), '{}');
  await writeFile(join(local, profile), '[]'); assert.equal((await account.local(3)).account, 'unavailable');
});

test('launcher reuses only the authenticated project identity and returns no account or bridge secrets', async () => {
  const root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/account-identity-')), instanceId = 'f'.repeat(24), token = 'a'.repeat(64);
  let pid = process.pid;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ result: { instanceId, projectPath: root, pid } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const directory = join(root, '.codex-work/cache/cocos-mcp/instances'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${instanceId}.json`), JSON.stringify({ instanceId, projectPath: root, pid: process.pid, creatorMajor: 3, endpoint: `http://127.0.0.1:${address.port}/rpc`, token }));
    await writeFile(join(directory, `${'0'.repeat(24)}.json`), JSON.stringify({ instanceId: '0'.repeat(24), projectPath: root, pid: process.pid, creatorMajor: 3, endpoint: `http://127.0.0.1:${address.port}/rpc`, token }));
    const account = new CreatorAccount(root), reused = await account.existing(root);
    assert.equal(reused?.status, 'existing-editor-reused'); assert.doesNotMatch(JSON.stringify(reused), new RegExp(token));
    pid++; assert.equal((await account.existing(root))?.status, 'existing-editor-present-unverified');
    const outside = await mkdtemp(join(process.cwd(), '.codex-work/tmp/account-descriptor-outside-'));
    await writeFile(join(outside, 'descriptor.json'), JSON.stringify({instanceId, projectPath: root, pid: process.pid, creatorMajor: 3, endpoint: `http://127.0.0.1:${address.port}/rpc`, token}));
    const escaped = await mkdtemp(join(process.cwd(), '.codex-work/tmp/account-descriptor-escape-'));
    await mkdir(join(escaped, '.codex-work/cache/cocos-mcp/instances'), {recursive: true});
    await symlink(join(outside, 'descriptor.json'), join(escaped, `.codex-work/cache/cocos-mcp/instances/${instanceId}.json`));
    assert.equal(await account.existing(escaped), null);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

class ViewFixture {
  size = { width: 1280, height: 720 }; content = {}; container = {}; policy = { getContentStrategy: () => this.content, getContainerStrategy: () => this.container };
  session = new RuntimeViewSession({ game: {}, ResolutionPolicy: { SHOW_ALL: 2 }, view: {
    getDesignResolutionSize: () => this.size, getFrameSize: () => ({ width: 1280, height: 720 }), getResolutionPolicy: () => this.policy,
    setDesignResolutionSize: (width: number, height: number, policy: typeof this.policy) => { this.size = { width, height }; this.policy = policy; },
  } });
}
test('view restoration preserves concurrent changes and expires scene-owned handles', async () => {
  const f = new ViewFixture(), before = await f.session.inspect();
  await assert.rejects(f.session.configure({ width: 844, height: 390, expectedHash: 'old' }), { code: 'STALE_REVISION' });
  const changed = await f.session.configure({ width: 844, height: 390, expectedHash: before.viewHash! });
  f.size = { width: 1920, height: 1080 };
  await assert.rejects(f.session.restore({ restoreId: changed.restoreId! }), { code: 'STALE_REVISION' }); assert.equal(f.size.width, 1920);
  f.session.dispose(); await assert.rejects(f.session.restore({ restoreId: changed.restoreId! }), { code: 'STALE_HANDLE' });
  const restored = await f.session.configure({ width: 568, height: 320, expectedHash: (await f.session.inspect()).viewHash! });
  assert.equal((await f.session.restore({ restoreId: restored.restoreId! })).restored, true); assert.equal(f.size.width, 1920);
});

test('view restoration detects public policy mutations and removes only its own setter observers', async () => {
  const f = new ViewFixture(), policy = f.policy as typeof f.policy & { setContentStrategy(value: object): void; setContainerStrategy(value: object): void };
  policy.setContentStrategy = value => { f.content = value; }; policy.setContainerStrategy = value => { f.container = value; };
  const original = policy.setContentStrategy;
  const configured = await f.session.configure({ width: 568, height: 320, expectedHash: (await f.session.inspect()).viewHash! });
  policy.setContentStrategy({ user: 'changed' }); await assert.rejects(f.session.restore({ restoreId: configured.restoreId! }), { code: 'STALE_REVISION' });
  assert.equal(f.size.width, 568); f.session.dispose(); assert.equal(policy.setContentStrategy, original);
});

test('view configuration rechecks geometry synchronously after the final asynchronous digest', async () => {
  const f = new ViewFixture(), view = (f.session as unknown as { cc: { view: Record<string, unknown> } }).cc.view;
  const before = await f.session.inspect(); let reads = 0, writes = 0;
  view.getFrameSize = () => { if (++reads === 2) f.size = { width: 1920, height: 1080 }; return { width: 1280, height: 720 }; };
  view.setDesignResolutionSize = () => { writes++; };
  await assert.rejects(f.session.configure({ width: 568, height: 320, expectedHash: before.viewHash! }), { code: 'STALE_REVISION' });
  assert.equal(writes, 0); assert.equal(f.size.width, 1920);
});

test('evidence exports a real PNG reference, retains identity and redacts secrets before persistence', async () => {
  const root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/evidence-')), paths = await ProjectPaths.open(root);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const saved = await new EvidenceStore().save(paths, 'run-1', { previewSessionId: 'preview-id', token: 'do-not-save', passed: true, checks: [{ passed: false }, { passed: 'do-not-save' }], password: false, session_id: 'do-not-save', dataUrl: `data:image/png;base64,${png.toString('base64')}`, image: { width: 10, height: 20 } });
  const image = Json.object(Json.object(saved.result).image); assert.equal(image.width, 10); assert.equal(image.path, saved.evidenceRefs[0]!.path);
  assert.deepEqual(await readFile(String(image.path)), png); assert.equal(Json.object(saved.result).previewSessionId, 'preview-id');
  assert.equal(Json.object(saved.result).passed, true); assert.deepEqual(Json.object(saved.result).checks, [{ passed: false }, { passed: '[REDACTED]' }]);
  assert.equal(Json.object(saved.result).password, '[REDACTED]'); assert.equal(Json.object(saved.result).session_id, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(saved), /do-not-save|base64/); await assert.rejects(new EvidenceStore().save(paths, '../escape', {}));
});

class SelectorFixture {
  node(uuid: string, name: string, x: number, parent?: Record<string, unknown>, components: Record<string, unknown>[] = []): Record<string, unknown> {
    return { uuid, name, children: [], parent, activeInHierarchy: true, width: 20, height: 20, anchorX: 0.5, anchorY: 0.5,
      convertToWorldSpaceAR: (point: { x: number; y: number }) => ({ x: point.x + x, y: point.y + 50 }), getComponents: () => components };
  }
  setup(): { selector: RuntimeUiSelector; canvas: Record<string, unknown>; action: Record<string, unknown> } {
    const root = this.node('scene', 'Scene', 0), canvas = this.node('canvas', 'Canvas', 0, root), other = this.node('other', 'Other', 0, root);
    const button = () => ({ uuid: 'button', type: 'cc.Button', enabledInHierarchy: true, interactable: true });
    const action = this.node('action', 'Action', 50, canvas, [button(), { type: 'cc.Label', string: 'Before' }]), duplicate = this.node('duplicate', 'Action', 90, other, [button()]);
    canvas.children = [action]; other.children = [duplicate]; root.children = [canvas, other];
    const cc = { director: { getScene: () => root }, game: { canvas: { width: 100, height: 100, getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100, right: 100, bottom: 100 }) } },
      Component: class {}, Vec2: class { constructor(public x: number, public y: number) {} }, js: { getClassName: (value: { type: string }) => value.type },
      Camera: { findCamera: () => ({ uuid: 'camera', getWorldToScreenPoint: (point: unknown) => point }) }, view: { getViewportRect: () => ({ x: 0, y: 0 }), getScaleX: () => 1, getScaleY: () => 1 } };
    return { selector: new RuntimeUiSelector(new SceneInspector({ cc, major: 2 })), canvas, action };
  }
}
test('semantic selectors require a unique AND match and report occlusion and unverified Creator 2 masks conservatively', () => {
  const f = new SelectorFixture(), { selector, canvas, action } = f.setup();
  assert.throws(() => selector.select({ selector: { name: 'Action' } }), { code: 'AMBIGUOUS_TARGET' });
  assert.throws(() => selector.select({ selector: { nodeId: 'action', name: 'wrong' } }), { code: 'NOT_FOUND' });
  const selected = selector.select({ selector: { name: 'Action', path: 'Canvas/Action' } }); assert.equal(selected.uniqueInputCandidate, true); assert.equal(selected.actualReceiverVerified, false);
  assert.equal(selector.check({ rows: [{ selector: { name: 'Absent' }, exists: false }, { selector: { nodeId: 'action' }, text: 'Before', visible: true, clipped: false }] }).passed, true);
  (canvas.children as unknown[]).push(f.node('overlay', 'Overlay', 50, canvas, [{ type: 'cc.BlockInputEvents' }]));
  assert.equal(selector.select({ selector: { nodeId: 'action' } }).uniqueInputCandidate, false);
  canvas.getComponents = () => [{ type: 'cc.Mask', enabledInHierarchy: true }];
  assert.equal(Json.object(selector.select({ selector: { nodeId: 'action' } }).target).maskVisibilityVerified, false);
  action.activeInHierarchy = false; assert.equal(selector.check({ rows: [{ selector: { nodeId: 'action' }, active: false, visible: false }] }).passed, true);
});

class RecipeBridge extends BridgeClient {
  frameIndex = 10;
  snapshot: JsonObject = { sceneId: 'scene', version: 1 }; running = false; inputs = 0; cleanupConflict = false; snapshotFailure = false; cleanupUnknown = false;
  override async identity(): Promise<boolean> { return true; }
  override async call(_descriptor: BridgeDescriptor, request: BridgeRequest): Promise<{ result: JsonValue; revision: string }> {
    let result: JsonValue = {};
    switch (request.capabilityId) {
      case 'editor.status': result = { creatorVersion: '3.8.8', installedBuildId: 'fake-build' }; break;
      case 'ui.plan': result = { planHash: 'a'.repeat(64), rows: [] }; break;
      case 'ui.build': result = { rootId: 'owned', rows: [] }; break;
      case 'ui.owned_snapshot': if (this.snapshotFailure) throw new CocosError('EDITOR_ERROR', 'Snapshot lost'); result = { snapshot: this.snapshot }; break;
      case 'ui.owned_remove': if (this.cleanupConflict) throw new CocosError('STALE_REVISION', 'User changed fixture'); if (this.cleanupUnknown) throw new CocosError('OUTCOME_UNKNOWN', 'Native remove result lost'); result = { verifiedAbsent: true }; break;
      case 'preview.start': this.running = true; result = { previewSessionId: 'preview', gameReady: true }; break;
      case 'preview.stop': this.running = false; result = { stopped: true }; break;
      case 'preview.status': result = { running: this.running, previewSessionId: 'preview', runtimeInstanceId: 'runtime', currentSceneId: 'scene', sceneGeneration: 1, gameReady: true, frameIndex: this.frameIndex++ }; break;
      case 'preview.input': this.inputs++; result = { inputSent: true }; break;
    }
    return { result, revision: 'native-revision' };
  }
}
test('regression binds lifecycle checks to the owned preview while an old runtime awaits expiry', async () => {
  const h = new RecipeHarness(); await h.setup(); h.bridge.running = true;
  const selected: string[] = [], runtime = {
    select(_projectId: string, id?: string): string { if (!id) throw new CocosError('AMBIGUOUS_TARGET', 'Old and new runtime are present'); return id; },
    async execute(_projectId: string, id: string | undefined): Promise<JsonValue> {
      assert.equal(id, 'runtime'); selected.push(id); return { handles: 0, subscriptions: 0, runningTasks: 0, pendingFrameWaits: 0, ownedAssetRefs: 0, pendingAssetLoads: 0, assetCount: 1 };
    },
  };
  h.app = new CocosApplication(h.registry, undefined, h.bridge, false, runtime);
  assert.equal((await h.call('preview.regression', { cycles: 2, rows: [{ capabilityId: 'preview.resize', params: { preset: 'landscape-844' } }] })).passed, true);
  assert.equal(selected.length, 3);
  await assert.rejects(h.app.execute({ projectId: h.projectId, capabilityId: 'preview.regression', runtimeInstanceId: 'old', params: { cycles: 1, rows: [{ capabilityId: 'preview.resize', params: { preset: 'landscape-844' } }] } }), { code: 'STALE_HANDLE' });
});
class RecipeHarness {
  bridge = new RecipeBridge(); registry = new ProjectRegistry(this.bridge); app = new CocosApplication(this.registry, undefined, this.bridge); projectId = '';
  async setup(): Promise<void> {
    const root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/recipe-')); this.projectId = (await this.registry.add(root)).projectId;
    const directory = await this.registry.paths(this.projectId).work('cache', 'cocos-mcp/instances');
    const descriptor: BridgeDescriptor = { protocolVersion: 1, projectId: this.projectId, projectPath: root, instanceId: 'a'.repeat(24), creatorMajor: 3, editorVersion: '3.8.8', endpoint: 'http://127.0.0.1:6001/rpc', token: 'a'.repeat(64), pid: process.pid, startedAt: new Date().toISOString() };
    await writeFile(join(directory, `${descriptor.instanceId}.json`), JSON.stringify(descriptor));
  }
  async call(capabilityId: string, params: JsonObject = {}): Promise<JsonObject> { return Json.object((await this.app.execute({ projectId: this.projectId, capabilityId, params })).result); }
  async fixture(): Promise<string> {
    const params = { label: 'synthetic', parentId: 'parent', document: { version: 1, root: { key: 'root', name: 'Owned UI' } } };
    const plan = await this.call('fixture.plan', params);
    return String((await this.call('fixture.create', { ...params, planHash: plan.planHash! })).fixtureId);
  }
}
test('fixture ownership conflicts preserve the tree and acceptance completes through the existing workflow and cleans only its preview', async () => {
  const h = new RecipeHarness(); await h.setup(); const fixtureId = await h.fixture();
  h.bridge.cleanupConflict = true; await assert.rejects(h.call('fixture.cleanup', { fixtureId }), { code: 'STALE_REVISION' });
  assert.equal((await h.call('fixture.status', { fixtureId })).status, 'active'); h.bridge.cleanupConflict = false;
  const params = { mode: 'fixture', fixtureId, steps: [{ capabilityId: 'preview.start', params: { fixtureId } }, { capabilityId: 'preview.wait', params: {} }] };
  const plan = await h.call('acceptance.plan', params), run = await h.call('acceptance.run', { ...params, planHash: plan.planHash! });
  let status: JsonObject = {};
  for (let i = 0; i < 100; i++) { status = await h.call('acceptance.status', { runId: run.runId! }); if (status.status !== 'running') break; await setTimeout(5); }
  assert.equal(status.status, 'succeeded'); assert.equal(status.mode, 'fixture'); assert.equal(status.realBusinessOutcomeVerified, false);
  assert.equal(h.bridge.running, false); assert.equal((await h.call('fixture.status', { fixtureId })).status, 'cleaned');
  await assert.rejects(h.call('acceptance.plan', { mode: 'live', steps: [{ capabilityId: 'runtime.ui.click', params: { selector: { name: 'Pay' } } }] }), { code: 'UNAUTHORIZED' });
  await assert.rejects(h.call('acceptance.plan', { mode: 'live', steps: [{ capabilityId: 'runtime.invoke', params: { method: 'anything' } }] }), { code: 'INVALID_ARGUMENT' });
});

test('fixture creation checkpoints its root and cleanup unknown state cannot be replayed after restart', async () => {
  const h = new RecipeHarness(); await h.setup(); h.bridge.snapshotFailure = true;
  await assert.rejects(h.fixture(), { code: 'EDITOR_ERROR' });
  const paths = h.registry.paths(h.projectId), { readdir } = await import('node:fs/promises');
  const directory = await paths.resolve('.codex-work/cache/cocos-mcp/fixtures'), name = (await readdir(directory))[0]!;
  const state = JSON.parse(await readFile(join(directory, name), 'utf8')); assert.equal(state.rootId, 'owned'); assert.equal(state.status, 'unknown');
  state.status = 'creating'; await writeFile(join(directory, name), JSON.stringify(state));
  assert.equal((await h.call('fixture.status', { fixtureId: state.fixtureId })).status, 'unknown');
  h.bridge.snapshotFailure = false; const fixtureId = await h.fixture(); h.bridge.cleanupUnknown = true;
  await assert.rejects(h.call('fixture.cleanup', { fixtureId }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal((await h.call('fixture.status', { fixtureId })).status, 'cleanup-unknown');
  h.bridge.cleanupUnknown = false; await assert.rejects(h.call('fixture.cleanup', { fixtureId }), { code: 'OUTCOME_UNKNOWN' });
});

test('acceptance restart exposes unknown status and never replays recorded inputs', async () => {
  const h = new RecipeHarness(); await h.setup();
  const path = await h.registry.paths(h.projectId).resolve('.codex-work/artifacts/cocos-mcp/acceptance'); await mkdir(path, { recursive: true });
  await writeFile(join(path, 'interrupted.json'), JSON.stringify({ runId: 'interrupted', status: 'running', mode: 'live', projectId: h.projectId, rows: [{ capabilityId: 'runtime.ui.click', inputSent: true }] }));
  const status = await h.call('acceptance.status', { runId: 'interrupted' }); assert.equal(status.status, 'unknown'); assert.equal(h.bridge.inputs, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.app.execute({ projectId: h.projectId, capabilityId: 'preview.wait', params: { timeoutMs: 100 } }, controller.signal), { code: 'CANCELLED' });
});

test('audit uses a UTC half-open interval, finite pagination and rejects impossible dates', async () => {
  const root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/audit-range-')), paths = await ProjectPaths.open(root), audit = new OperationAudit();
  for (const day of ['07', '08', '09']) await audit.record(paths, { operationId: `day-${day}`, startedAt: `2026-10-${day}T00:00:00.000Z` });
  const p = { from: '2026-10-08T00:00:00Z', to: '2026-10-10T00:00:00Z', limit: 1 };
  const first = await audit.rows(paths, p); assert.equal((first.rows as JsonObject[])[0]!.operationId, 'day-08');
  const next = await audit.rows(paths, { ...p, cursor: first.nextCursor! }); assert.equal((next.rows as JsonObject[])[0]!.operationId, 'day-09'); assert.equal(next.nextCursor, null);
  await assert.rejects(audit.rows(paths, { from: '2026-02-30T00:00:00Z' })); await assert.rejects(audit.rows(paths, { from: '2026-10-08T00:00:00+08:00' }));
});
