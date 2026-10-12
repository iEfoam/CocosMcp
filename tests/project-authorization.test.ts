import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, cp, symlink, rename, chmod, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Json, type EditorAdapter, type JsonValue } from '../packages/contracts/src/index.js';
import { ClientInstallation } from '../packages/native-adapters/src/client-installation.js';
import { ExtensionInstaller } from '../packages/native-adapters/src/installer.js';
import { ProjectAuthorizations } from '../packages/native-adapters/src/project-authorization.js';
import { ProjectPaths } from '../packages/application/src/paths.js';
import { ServiceConnections } from '../packages/application/src/service-connections.js';
import { McpService } from '../extensions/shared/mcp-service.js';
import { EditorBridge } from '../packages/editor-bridge/src/index.js';
import { TestWorkspace } from './workspace.js';

class AuthorizedEditor implements EditorAdapter {
  readonly major = 3;
  supportedCapabilities(): string[] { return ['scene.query']; }
  async revision(): Promise<string> { return '0'; }
  async execute(): Promise<JsonValue> { return { marker: 'authorized-editor' }; }
  async dispose(): Promise<void> {}
}
class AuthorizationFixture {
  root = ''; installation = ''; build = '';
  async setup(): Promise<void> {
    this.root = await new TestWorkspace().create('project-authorization-');
    const workspace = join(this.root, 'client-workspace'); await mkdir(workspace);
    this.installation = String(Json.object(await new ClientInstallation().install(workspace, resolve('.codex-work/build/client'), [])).installedPath);
    const policy = JSON.parse(await readFile(join(this.installation, 'policy.json'), 'utf8'));
    assert.deepEqual(policy.allowedRoots, []);
    await writeFile(join(this.installation, 'policy.json'), JSON.stringify({ ...policy, clientHeartbeatSeconds: 1, clientLeaseTtlSeconds: 3, idleExitSeconds: 1 }));
    this.build = join(this.root, 'bundle');
    for (const major of [2, 3]) {
      const extension = join(this.build, `extensions/creator${major}`);
      await cp(resolve(`.codex-work/build/extensions/creator${major}`), extension, { recursive: true });
      await writeFile(join(extension, 'service-config.json'), JSON.stringify({ nodeExecutable: process.execPath, clientInstallation: this.installation }));
    }
  }
  async game(name: string, major: 2 | 3 = 3): Promise<string> {
    const root = join(this.root, name); await mkdir(join(root, 'assets/subdir'), { recursive: true });
    await writeFile(join(root, major === 2 ? 'project.json' : 'package.json'), JSON.stringify(major === 2 ? { engine: 'cocos-creator-js', version: '2.4.15' } : { creator: { version: '3.8.8' } }));
    return root;
  }
  extension(project: string, major: 2 | 3 = 3): string { return join(project, `${major === 2 ? 'packages' : 'extensions'}/cocos-mcp-creator${major}`); }
  authorizations(): ProjectAuthorizations { return new ProjectAuthorizations(this.installation); }
  async install(project: string, major: 2 | 3 = 3) { return new ExtensionInstaller().install(project, major, this.build); }
  async client(): Promise<Client> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries((await ProjectPaths.open(this.root)).environment())) if (value !== undefined) env[key] = value;
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(this.installation, 'launcher.mjs')], cwd: this.root, env, stderr: 'pipe' });
    transport.stderr?.on('data', () => {}); const client = new Client({ name: 'authorization-tests', version: '1' }); await client.connect(transport, { timeout: 10000 }); return client;
  }
  async stopped(project: string): Promise<void> {
    const connections = new ServiceConnections(await ProjectPaths.open(project));
    for (let attempt = 0; attempt < 70; attempt++) {
      try { if (!await connections.active()) return; }
      catch (error) { if ((error as { code?: string }).code !== 'RESOURCE_BUSY') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Authorization test worker did not stop');
  }
}

test('installing either Creator extension authorizes only its canonical project and preserves an idempotent grant', async () => {
  const f = new AuthorizationFixture(); await f.setup();
  for (const major of [2, 3] as const) {
    const game = await f.game(`game-${major}`, major), first = await f.install(game, major);
    assert.equal(first.authorization.state, 'authorized');
    const before = await f.authorizations().rows(); await f.install(game, major);
    assert.deepEqual(await f.authorizations().rows(), before);
    assert.equal((await f.authorizations().locate(join(game, 'assets/subdir'), [])).root, game);
  }
  assert.equal((await f.authorizations().rows()).length, 2);
  assert.equal((await lstat(join(f.installation, 'authorized-projects.json'))).mode & 0o777, 0o600);
  await assert.rejects(f.authorizations().locate(await f.game('never-installed'), []), { code: 'PATH_OUTSIDE_PROJECT' });
});

test('copied plugins cannot self-authorize; manual control-center authorization and revocation are explicit', async () => {
  const f = new AuthorizationFixture(); await f.setup(); const game = await f.game('manual');
  await cp(join(f.build, 'extensions/creator3'), f.extension(game), { recursive: true });
  const service = new McpService(game, f.extension(game));
  assert.equal((await service.inspect()).unifiedClient?.authorization, 'not-authorized');
  await assert.rejects(f.authorizations().locate(game, []), { code: 'PATH_OUTSIDE_PROJECT' });
  await service.authorizeProject(); assert.equal((await service.inspect()).unifiedClient?.authorization, 'authorized');
  await service.revokeProject(); assert.equal((await service.inspect()).unifiedClient?.authorization, 'revoked');
  await assert.rejects(f.authorizations().locate(game, [f.root]), { code: 'PATH_OUTSIDE_PROJECT' });
  await service.authorizeProject(); assert.equal((await f.authorizations().locate(game, [])).root, game);
});

test('aliases retain project identity while nested projects and symlink escapes need separate grants', async () => {
  const f = new AuthorizationFixture(); await f.setup(); const game = await f.game('outer'); await f.install(game);
  await symlink(game, join(f.root, 'alias'));
  assert.equal((await f.authorizations().locate(join(f.root, 'alias/assets/subdir'), [])).root, game);
  const nested = await f.game('outer/nested');
  await assert.rejects(f.authorizations().locate(nested, [f.root]), { code: 'PATH_OUTSIDE_PROJECT' });
  const outside = await f.game('outside'); await symlink(outside, join(game, 'escape'));
  await assert.rejects(f.authorizations().locate(join(game, 'escape'), []), { code: 'PATH_OUTSIDE_PROJECT' });
  await f.install(nested); assert.equal((await f.authorizations().locate(nested, [])).root, nested);
  const paths = await f.authorizations().locate(game, []);
  await assert.rejects(paths.resolve('escape/asset.json'), { code: 'PATH_OUTSIDE_PROJECT' });
});

test('concurrent registrations never lose projects and malformed registries prevent partial installation', async () => {
  const f = new AuthorizationFixture(); await f.setup(); const games = await Promise.all(['one', 'two'].map(name => f.game(name)));
  await Promise.all(games.map(game => f.install(game)));
  assert.equal((await f.authorizations().rows()).length, 2);
  const target = f.extension(games[0]!), before = await readFile(join(target, 'package.json'));
  await writeFile(join(target, 'local-marker'), 'retain old installation');
  await writeFile(join(f.installation, 'authorized-projects.json'), '{invalid');
  await assert.rejects(f.install(games[0]!), { code: 'VERIFICATION_FAILED' });
  assert.deepEqual(await readFile(join(target, 'package.json')), before);
  assert.equal(await readFile(join(target, 'local-marker'), 'utf8'), 'retain old installation');
  assert.equal(await readFile(join(f.installation, 'authorized-projects.json'), 'utf8'), '{invalid');
});

test('permission, registry symlinks and changed or removed plugin files fail closed', async () => {
  const f = new AuthorizationFixture(); await f.setup(); const game = await f.game('guarded'); await f.install(game);
  const registry = join(f.installation, 'authorized-projects.json');
  await chmod(registry, 0o666); await assert.rejects(f.authorizations().locate(game, []), { code: 'VERIFICATION_FAILED' }); await chmod(registry, 0o600);
  const saved = join(f.installation, 'registry-original.json'); await rename(registry, saved); await symlink(saved, registry);
  await assert.rejects(f.authorizations().locate(game, []), { code: 'VERIFICATION_FAILED' });
  await rename(registry, join(f.installation, 'registry-link')); await rename(saved, registry);
  const plugin = f.extension(game), candidate = join(game, '.codex-work/tmp/plugin'); await rename(plugin, candidate);
  await assert.rejects(f.authorizations().locate(game, []), { code: 'VERIFICATION_FAILED' }); await rename(candidate, plugin);
  const runtime = join(plugin, 'dist/runtime.js'); await writeFile(runtime, 'tampered runtime');
  await assert.rejects(f.authorizations().locate(game, []), { code: 'VERIFICATION_FAILED' });
});

test('a live stdio session discovers a newly installed project and immediately blocks revoked existing calls', async () => {
  const f = new AuthorizationFixture(); await f.setup(); const game = await f.game('live');
  const bridge = new EditorBridge(new AuthorizedEditor(), game, '3.8.8'), instance = await bridge.start(), client = await f.client();
  const query = { projectId: instance.projectId, instanceId: instance.instanceId, params: {} };
  try {
    const denied = await client.callTool({ name: 'cocos_project_connect', arguments: { projectPath: game } });
    assert.equal(Json.object(Json.object(denied.structuredContent).error!).code, 'PATH_OUTSIDE_PROJECT');
    await f.install(game);
    const connected = await client.callTool({ name: 'cocos_project_connect', arguments: { projectPath: game } });
    assert.notEqual(connected.isError, true, JSON.stringify(connected));
    const original = await new ServiceConnections(await ProjectPaths.open(game)).active();
    const read = await client.callTool({ name: 'cocos_scene_query', arguments: query }); assert.notEqual(read.isError, true);
    assert.ok(JSON.stringify(read).includes('authorized-editor'));
    await f.authorizations().revoke(game);
    const revoked = await client.callTool({ name: 'cocos_scene_query', arguments: query });
    assert.equal(Json.object(Json.object(revoked.structuredContent).error!).code, 'PATH_OUTSIDE_PROJECT');
    await f.authorizations().grant(game, 3);
    assert.notEqual((await client.callTool({ name: 'cocos_scene_query', arguments: query })).isError, true);
    assert.equal((await new ServiceConnections(await ProjectPaths.open(game)).active())?.serviceId, original?.serviceId);
  } finally { await client.close(); await f.stopped(game); await bridge.stop(); }
});

test('authorization rejects plain folders, incomplete extensions and mismatched Creator versions', async () => {
  const f = new AuthorizationFixture(); await f.setup(); const game = await f.game('uninstalled');
  await assert.rejects(f.authorizations().grant(game, 3), { code: 'VERIFICATION_FAILED' });
  await assert.rejects(f.authorizations().grant(game, 2), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.authorizations().grant(f.root, 3), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(await f.authorizations().rows(), []);
});


test('automatic workspace resolution reads current grants, preserves nested authorization and rejects stale mapped permissions', async () => {
  const f = new AuthorizationFixture(); await f.setup(); const first = await f.game('workspace/first'), second = await f.game('workspace/first-copy');
  await f.install(first); await f.install(second);
  const parent = join(f.root, 'workspace');
  await assert.rejects(f.authorizations().workspace(parent, []), { code: 'AMBIGUOUS_TARGET' });
  const mapping = [{ workspacePath: parent, projectPath: first }];
  assert.equal((await f.authorizations().workspace(parent, [], mapping)).root, first);
  assert.equal((await f.authorizations().workspace(join(second, 'assets/subdir'), [], mapping)).root, second);
  await symlink(parent, join(f.root, 'parent-alias'));
  assert.equal((await f.authorizations().workspace(join(f.root, 'parent-alias'), [], mapping)).root, first);
  await assert.rejects(f.authorizations().workspace(parent, [], [...mapping, { workspacePath: join(f.root, 'parent-alias'), projectPath: second }]), { code: 'AMBIGUOUS_TARGET' });
  const nested = await f.game('workspace/first/nested');
  await assert.rejects(f.authorizations().workspace(nested, [parent], mapping), { code: 'PATH_OUTSIDE_PROJECT' });
  await f.authorizations().revoke(first);
  await assert.rejects(f.authorizations().workspace(parent, [], mapping), { code: 'PATH_OUTSIDE_PROJECT' });
  await assert.rejects(f.authorizations().workspace(first, [parent], mapping), { code: 'PATH_OUTSIDE_PROJECT' });
  assert.equal((await f.authorizations().workspace(parent, [])).root, second);
});


test('unrelated removed mappings and historical grants do not block current workspaces; broken selected mappings fail explicitly', async () => {
  const f = new AuthorizationFixture(); await f.setup(); const current = await f.game('current-parent/current'), removed = await f.game('current-parent/removed');
  await f.install(current); await f.install(removed);
  const parent = join(f.root, 'current-parent'), gone = join(f.root, 'deleted-parent');
  const mappings = [{ workspacePath: gone, projectPath: gone }, { workspacePath: parent, projectPath: current }];
  await rename(removed, join(f.root, 'moved-project'));
  assert.equal((await f.authorizations().workspace(parent, [], mappings)).root, current);
  assert.equal((await f.authorizations().workspace(parent, [])).root, current);
  assert.equal((await f.authorizations().workspace(join(current, 'assets'), [gone], mappings)).root, current);
  await assert.rejects(f.authorizations().workspace(parent, [], [{ workspacePath: parent, projectPath: removed }]), { code: 'CONTEXT_UNAVAILABLE' });
});
