import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink, cp, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as HttpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as HttpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Json, type EditorAdapter, type JsonObject, type JsonValue } from '../packages/contracts/src/index.js';
import { ClientInstallation, ClientPackage } from '../packages/native-adapters/src/client-installation.js';
import { ProjectRegistry } from '../packages/application/src/registry.js';
import { ProjectPaths } from '../packages/application/src/paths.js';
import { ProjectLocator } from '../packages/application/src/project-locator.js';
import { ServiceConnections } from '../packages/application/src/service-connections.js';
import { ServiceHost } from '../apps/server/src/service-host.js';
import { EditorBridge } from '../packages/editor-bridge/src/index.js';
import { TestWorkspace } from './workspace.js';
import { RouterRuntime } from '../apps/server/src/router-runtime.js';

class TestGate {
  resolve: () => void = () => {};
  readonly promise = new Promise<void>(resolve => { this.resolve = resolve; });
}

class RoutedEditor implements EditorAdapter {
  readonly major = 3;
  saves = 0;
  reads = 0;
  readStarted = new TestGate();
  started = new TestGate();
  finished = new TestGate();
  constructor(private readonly marker: string) {}
  supportedCapabilities(): string[] { return ['scene.query', 'scene.save']; }
  async revision(): Promise<string> { return String(this.saves); }
  async execute(id: string): Promise<JsonValue> {
    if (id === 'scene.query') { this.reads++; this.readStarted.resolve(); await delay(100); }
    if (id === 'scene.save') { this.saves++; this.started.resolve(); await delay(250); this.finished.resolve(); }
    return { marker: this.marker, saves: this.saves, ...(id === 'scene.query' ? { context: 'editor', scene: {}, dirty: false } : {}) };
  }
  async dispose(): Promise<void> {}
}

class UnifiedFixture {
  root = ''; installation = '';
  clients: Client[] = [];
  bridges: EditorBridge[] = [];
  games: string[] = [];
  async setup(): Promise<void> {
    this.root = await new TestWorkspace().create('unified-client-');
    const installed = Json.object(await new ClientInstallation().install(this.root, resolve('.codex-work/build/client'), [this.root]));
    this.installation = String(installed.installedPath);
    await writeFile(join(this.installation, 'policy.json'), JSON.stringify({ schemaVersion: 1, allowedRoots: [this.root], autoStartBackend: true, allowProjectCode: false, clientHeartbeatSeconds: 1, clientLeaseTtlSeconds: 3, idleExitSeconds: 1 }));
  }
  async game(name: string) {
    const root = join(this.root, name); await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name, uuid: 'test-project', creator: { version: '3.8.8' } }));
    const editor = new RoutedEditor(name), bridge = new EditorBridge(editor, root, '3.8.8'), instance = await bridge.start();
    this.bridges.push(bridge); this.games.push(root);
    return { root, editor, instance, connections: new ServiceConnections(await ProjectPaths.open(root)) };
  }
  async client(workspacePath?: string): Promise<Client> {
    const paths = await ProjectPaths.open(this.root), env: Record<string, string> = {};
    for (const [key, value] of Object.entries(paths.environment())) if (value !== undefined) env[key] = value;
    delete env.COCOS_WORKSPACE_PATH;
    if (workspacePath) env.COCOS_WORKSPACE_PATH = workspacePath;
    const client = new Client({ name: 'unified-tests', version: '1' }), transport = new StdioClientTransport({ command: process.execPath, args: [join(this.installation, 'launcher.mjs')], cwd: this.root, env, stderr: 'pipe' });
    transport.stderr?.on('data', () => {}); this.clients.push(client); await client.connect(transport, { timeout: 10000 }); return client;
  }
  async call(client: Client, name: string, args: JsonObject = {}): Promise<JsonObject> {
    const result = await client.callTool({ name, arguments: args }, { timeout: 20000 });
    assert.notEqual(result.isError, true, JSON.stringify(result)); return Json.object(result.structuredContent);
  }
  async router() {
    const { current } = await new ClientPackage().installed(this.installation);
    const connections = await new RouterRuntime().connections(await ProjectPaths.open(this.root), join(this.installation, current.versionPath, 'worker.mjs'));
    const descriptor = await connections.active(); assert.ok(descriptor);
    const token = await connections.token(descriptor.tokenFile, false);
    const status = async () => {
      const response = await fetch(new URL('/router/status', descriptor.endpoint!), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200); return Json.object(Json.value(await response.json()));
    };
    return { descriptor, token, connections, status };
  }
  async error(client: Client, name: string, args: JsonObject, code: string): Promise<void> {
    const result = await client.callTool({ name, arguments: args }, { timeout: 20000 });
    assert.equal(result.isError, true); assert.equal(Json.object(Json.object(result.structuredContent).error!).code, code);
  }
  async stopped(connections: ServiceConnections): Promise<void> {
    for (let i = 0; i < 70; i++) {
      try { if (!await connections.active()) return; }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'RESOURCE_BUSY')) throw error; }
      await delay(100);
    }
    throw new Error('Shared worker did not exit after its last client disconnected');
  }
  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map(client => client.close()));
    if (this.clients.length) {
      const { current } = await new ClientPackage().installed(this.installation, false);
      await this.stopped(await new RouterRuntime().connections(await ProjectPaths.open(this.root), join(this.installation, current.versionPath, 'worker.mjs')));
    }
    try { for (const root of this.games) await this.stopped(new ServiceConnections(await ProjectPaths.open(root))); }
    finally { await Promise.all(this.bridges.map(bridge => bridge.stop())); }
  }
}

test('unified transport exposes request-local resolution, authorization, service and native serialization timings', async () => {
  const f = new UnifiedFixture(); await f.setup();
  try {
    const game = await f.game('timed-game'), client = await f.client();
    const response = await client.callTool({ name: 'cocos_scene_query', arguments: { workspacePath: game.root, params: {} } });
    assert.ok(!response.isError);
    const stages = (response._meta?.['io.cocos-mcp/client-timings'] as JsonObject[]).map(row => row.stage);
    for (const stage of ['workspace-resolution', 'authorization', 'service-connect', 'editor-discovery', 'authorization-recheck', 'service-identity', 'backend-rpc']) assert.ok(stages.includes(stage), stage);
    const native = Json.object(Json.value(response.structuredContent)).nativeTimings as JsonObject[];
    assert.ok(native.some(row => row.stage === 'native-execution'));
    assert.ok(native.some(row => row.stage === 'response-serialization'));
    assert.ok(native.every(row => typeof row.durationMs === 'number' && row.durationMs >= 0));
    assert.equal(game.editor.reads, 1);
  } finally { await f.close(); }
});

test('offline unified stdio initializes without a project and advertises self-contained connection guidance', async () => {
  const f = new UnifiedFixture(); await f.setup();
  try {
    const client = await f.client();
    assert.deepEqual((await f.call(client, 'cocos_projects')).rows, []);
    assert.ok((await client.listTools()).tools.some(row => row.name === 'cocos_project_connect'));
    assert.match(client.getInstructions() ?? '', /cocos_project_connect/);
    assert.ok((client.getInstructions()?.length ?? 9999) <= 512);
    assert.deepEqual((await f.call(client, 'cocos_connection_status')).rows, []);
    const config = await new ClientPackage().configuration(f.installation, process.execPath);
    assert.match(config, /\[mcp_servers\.cocos_unified\]/); assert.match(config, /\[mcp_servers\.cocos_unified\.env\]/);
    assert.doesNotMatch(config, /\[mcp_servers\.cocos(?:\]|\.)/); assert.doesNotMatch(config, /^\s*(?:url|http_headers|bearer_token_env_var)\s*=/m);
    assert.ok(!config.includes('--project')); assert.ok(!config.includes('Bearer'));
  } finally { await f.close(); }
});

test('verified serve entry stays available with no sessions and releases its authenticated identity on shutdown', async () => {
  const f = new UnifiedFixture(); await f.setup();
  const { current } = await new ClientPackage().installed(f.installation), paths = await ProjectPaths.open(f.root);
  const connections = await new RouterRuntime().connections(paths, join(f.installation, current.versionPath, 'worker.mjs'));
  const child = spawn(process.execPath, [join(f.installation, 'launcher.mjs'), '--serve', '--port', '0'], { cwd: f.root, env: paths.environment(), stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = ''; child.stderr?.on('data', chunk => { logs += String(chunk); });
  const exited = new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
  try {
    let descriptor = await connections.active();
    for (let attempt = 0; !descriptor && attempt < 100; attempt++) { await delay(50); descriptor = await connections.active(); }
    assert.ok(descriptor, logs); assert.equal(descriptor.pid, child.pid);
    const router = await f.router(); assert.equal((await router.status()).loaded, false);
    const client = await f.client(); await client.listTools(); assert.equal((await router.status()).connectors, 0); await client.close();
    await delay(2200); assert.equal((await connections.active())?.serviceId, descriptor.serviceId);
  } finally { child.kill('SIGTERM'); await exited; await f.stopped(connections); await f.close(); }
});

test('two independent stdio clients share one project worker and closing its first client preserves the second', async () => {
  const f = new UnifiedFixture(); await f.setup(); const game = await f.game('game-a');
  try {
    const clients = await Promise.all([f.client(), f.client()]);
    const router = await f.router(); assert.equal((await router.status()).sessions, 2);
    const connected = await Promise.all(clients.map(client => f.call(client, 'cocos_project_connect', { projectPath: game.root })));
    assert.equal(Json.object(connected[0]!.connection!).serviceId, Json.object(connected[1]!.connection!).serviceId);
    const descriptor = await game.connections.active(); assert.ok(descriptor); assert.equal(descriptor.mode, 'shared'); assert.notEqual(descriptor.pid, process.pid);
    assert.ok(!JSON.stringify(connected).includes('leaseToken')); assert.ok(!JSON.stringify(connected).includes('Bearer'));
    assert.equal((await game.connections.clientStatus(descriptor)).clients, 2);
    const unleased = await fetch(descriptor.endpoint!, { method: 'POST', headers: { Authorization: `Bearer ${await game.connections.token(descriptor.tokenFile, false)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    assert.equal(unleased.status, 401); await unleased.arrayBuffer();
    await clients[0]!.close();
    const projectId = Json.string(Json.object(connected[1]!.project!).projectId, 'projectId');
    const result = await f.call(clients[1]!, 'cocos_scene_query', { projectId, instanceId: game.instance.instanceId, params: {} });
    assert.equal(Json.object(result.result!).marker, 'game-a'); assert.equal((await game.connections.active())?.serviceId, descriptor.serviceId);
    assert.equal(await game.connections.port(), 0);
    await clients[1]!.close(); await f.stopped(game.connections);
  } finally { await f.close(); }
});

test('shared router keeps live idle sessions, loads connectors on first tool use and restarts after final close', async () => {
  const f = new UnifiedFixture(); await f.setup();
  try {
    const first = await f.client(), router = await f.router();
    await first.listTools(); assert.equal((await router.status()).connectors, 0);
    await delay(2200); assert.equal((await router.connections.active())?.serviceId, router.descriptor.serviceId);
    const second = await f.client(); assert.equal((await router.status()).sessions, 2);
    await f.call(first, 'cocos_projects'); assert.equal((await router.status()).connectors, 1);
    await first.close(); assert.deepEqual((await f.call(second, 'cocos_projects')).rows, []);
    await second.close(); await f.stopped(router.connections);
    const third = await f.client(); assert.notEqual((await f.router()).descriptor.serviceId, router.descriptor.serviceId);
    assert.deepEqual((await f.call(third, 'cocos_projects')).rows, []);
  } finally { await f.close(); }
});

test('native HTTP sessions share the router but isolate projects, request ids and disconnects', async () => {
  const f = new UnifiedFixture(); await f.setup(); const first = await f.game('http-a'), second = await f.game('http-b');
  const clients: HttpClient[] = [], transports: HttpTransport[] = [];
  try {
    const bootstrap = await f.client(), router = await f.router();
    for (let index = 0; index < 2; index++) {
      const transport = new HttpTransport(new URL(router.descriptor.endpoint!), { requestInit: { headers: { Authorization: `Bearer ${router.token}` } } });
      const client = new HttpClient({ name: 'native-http-test', version: '1' }); clients.push(client); transports.push(transport);
      // SDK 1 的 sessionId 声明不兼容 exactOptionalPropertyTypes，运行时仍使用其原生传输。
      await client.connect(transport as Parameters<HttpClient['connect']>[0]);
    }
    assert.notEqual(transports[0]!.sessionId, transports[1]!.sessionId);
    assert.deepEqual((await clients[0]!.listTools()).tools, (await bootstrap.listTools()).tools);
    const connected = await Promise.all(clients.map((client, index) => client.callTool({ name: 'cocos_project_connect', arguments: { projectPath: index ? second.root : first.root } })));
    assert.ok(connected.every(row => !row.isError));
    const listed = await Promise.all(clients.map(client => client.callTool({ name: 'cocos_projects', arguments: {} })));
    assert.deepEqual(listed.map(row => (Json.object(row.structuredContent).rows as JsonObject[]).map(project => project.projectPath)), [[first.root], [second.root]]);
    const denied = await clients[0]!.callTool({ name: 'cocos_scene_query', arguments: { projectId: second.instance.projectId, params: {} } }); assert.equal(denied.isError, true);
    await transports[0]!.terminateSession(); await clients[0]!.close();
    const result = await clients[1]!.callTool({ name: 'cocos_scene_query', arguments: { projectId: second.instance.projectId, params: {} } });
    assert.equal(Json.object(Json.object(result.structuredContent).result!).marker, 'http-b');
    const unauthenticated = await fetch(router.descriptor.endpoint!, { method: 'POST' }); assert.equal(unauthenticated.status, 401); await unauthenticated.arrayBuffer();
    const browser = await fetch(router.descriptor.endpoint!, { method: 'POST', headers: { Authorization: `Bearer ${router.token}`, Origin: 'https://example.com' } }); assert.equal(browser.status, 403); await browser.arrayBuffer();
    await transports[1]!.terminateSession(); await clients[1]!.close(); await bootstrap.close(); await f.stopped(router.connections);
  } finally {
    await Promise.allSettled(transports.map(transport => transport.terminateSession())); await Promise.allSettled(clients.map(client => client.close())); await f.close();
  }
});

test('concurrent native requests with identical ids cancel only their own session', async () => {
  const f = new UnifiedFixture(); await f.setup(); const first = await f.game('cancel-a'), second = await f.game('cancel-b');
  const clients: HttpClient[] = [], transports: HttpTransport[] = [];
  try {
    await f.client(); const router = await f.router();
    for (const game of [first, second]) {
      const transport = new HttpTransport(new URL(router.descriptor.endpoint!), { requestInit: { headers: { Authorization: `Bearer ${router.token}` } } });
      const client = new HttpClient({ name: 'cancel-http', version: '1' }); clients.push(client); transports.push(transport);
      await client.connect(transport as Parameters<HttpClient['connect']>[0]);
      await client.callTool({ name: 'cocos_project_connect', arguments: { projectPath: game.root } });
    }
    const aborted = new AbortController();
    const pending = clients[0]!.callTool({ name: 'cocos_scene_query', arguments: { projectId: first.instance.projectId, params: {} } }, undefined, { signal: aborted.signal }).catch(error => error);
    const preserved = clients[1]!.callTool({ name: 'cocos_scene_query', arguments: { projectId: second.instance.projectId, params: {} } });
    await Promise.all([first.editor.readStarted.promise, second.editor.readStarted.promise]); aborted.abort(); await pending;
    const result = await preserved; assert.notEqual(result.isError, true); assert.equal(Json.object(Json.object(result.structuredContent).result!).marker, 'cancel-b');
    assert.equal(first.editor.reads, 1); assert.equal(second.editor.reads, 1);
  } finally {
    await Promise.allSettled(transports.map(transport => transport.terminateSession())); await Promise.allSettled(clients.map(client => client.close())); await f.close();
  }
});

test('concurrent launcher startup has one authenticated router and rejects forged session generations', async () => {
  const f = new UnifiedFixture(); await f.setup();
  try {
    const clients = await Promise.all(Array.from({ length: 6 }, () => f.client()));
    const router = await f.router(); assert.equal((await router.status()).sessions, 6);
    const results = await Promise.all(clients.map(client => f.call(client, 'cocos_projects'))); assert.ok(results.every(result => Array.isArray(result.rows) && result.rows.length === 0));
    const stale = await fetch(router.descriptor.endpoint!, { method: 'POST', headers: { Authorization: `Bearer ${router.token}`, 'Content-Type': 'application/json', 'mcp-session-id': 'unknown-generation' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    assert.equal(stale.status, 404); await stale.arrayBuffer(); assert.equal((await router.connections.active())?.serviceId, router.descriptor.serviceId);
  } finally { await f.close(); }
});

test('closing the last router session preserves a running build in its independent project worker', { skip: process.platform !== 'darwin' }, async () => {
  const f = new UnifiedFixture(); await f.setup(); const game = await f.game('background-build');
  const creator = join(game.root, 'Creator.app'), executable = join(creator, 'Contents/MacOS/CocosCreator');
  await mkdir(join(creator, 'Contents/Resources/app'), { recursive: true }); await mkdir(join(creator, 'Contents/MacOS'), { recursive: true });
  await writeFile(join(creator, 'Contents/Resources/app/package.json'), JSON.stringify({ version: '3.8.8' }));
  const account = join(game.root, '.codex-work/cache/creator-home/profiles/v2/editor'); await mkdir(account, { recursive: true });
  await writeFile(join(account, 'user.json'), JSON.stringify({ session_id: 'fixture', session_key: 'fixture', cocos_uid: 1 }));
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), config = JSON.parse(fs.readFileSync(args[args.indexOf('--build') + 1].slice(11)));
setTimeout(() => { fs.writeFileSync(path.join(config.buildPath, 'result.json'), '{}'); process.exit(36); }, 3500);
`); await chmod(executable, 0o700);
  try {
    const client = await f.client();
    const job = await f.call(client, 'cocos_build_start', { workspacePath: game.root, creatorPath: creator, platform: 'web-mobile', operationId: 'shared-router-background-build' });
    assert.equal(job.state, 'running'); const router = await f.router(), backend = await game.connections.active(); assert.ok(backend);
    await client.close(); await f.stopped(router.connections);
    assert.equal((await game.connections.active())?.serviceId, backend.serviceId);
    const next = await f.client();
    let status = await f.call(next, 'cocos_build_status', { workspacePath: game.root, jobId: job.jobId! });
    for (let attempt = 0; status.state === 'running' && attempt < 60; attempt++) { await delay(100); status = await f.call(next, 'cocos_build_status', { workspacePath: game.root, jobId: job.jobId! }); }
    assert.equal(status.state, 'succeeded'); assert.equal((await game.connections.active())?.serviceId, backend.serviceId);
  } finally { await f.close(); }
});

test('shared backend restart changes its authenticated generation and never replays a durably recorded scene write', async () => {
  const f = new UnifiedFixture(); await f.setup(); const game = await f.game('restart-game');
  try {
    const client = await f.client(); await f.call(client, 'cocos_project_connect', { projectPath: game.root });
    const args = { projectId: game.instance.projectId, instanceId: game.instance.instanceId, params: {}, operationId: 'restart-save', expectedRevision: '0' };
    await f.call(client, 'cocos_scene_save', args);
    const previous = await game.connections.active(); assert.ok(previous); assert.equal(previous.mode, 'shared'); assert.notEqual(previous.pid, process.pid);
    // 只终止此夹具创建且刚完成身份认证的后端，不能按端口或未核实 PID 清理进程。
    process.kill(previous.pid, 'SIGKILL');
    for (let retry = 0; retry < 100 && game.connections.alive(previous.pid); retry++) await delay(20);
    assert.equal(game.connections.alive(previous.pid), false);
    await f.error(client, 'cocos_scene_query', { projectId: game.instance.projectId, instanceId: game.instance.instanceId, params: {} }, 'CONTEXT_UNAVAILABLE');
    const connected = await f.call(client, 'cocos_project_connect', { projectPath: game.root });
    assert.notEqual(Json.object(connected.connection!).serviceId, previous.serviceId);
    assert.equal((await f.call(client, 'cocos_operation_query', { projectId: game.instance.projectId, operationId: 'restart-save' })).status, 'completed');
    await f.error(client, 'cocos_scene_save', args, 'OUTCOME_UNKNOWN'); assert.equal(game.editor.saves, 1);
  } finally { await f.close(); }
});

test('one client routes two projects and resources explicitly, rejects cross-project instances and unsafe writes', async () => {
  const f = new UnifiedFixture(); await f.setup(); const first = await f.game('game-a'), second = await f.game('game-b');
  try {
    const client = await f.client();
    await Promise.all([f.call(client, 'cocos_project_connect', { projectPath: first.root }), f.call(client, 'cocos_project_connect', { projectPath: second.root })]);
    assert.equal(((await f.call(client, 'cocos_projects')).rows as JsonObject[]).length, 2);
    for (const game of [first, second]) {
      const result = await f.call(client, 'cocos_scene_query', { projectId: game.instance.projectId, instanceId: game.instance.instanceId, params: {} });
      assert.equal(Json.object(result.result!).marker, game === first ? 'game-a' : 'game-b');
      assert.ok((await client.readResource({ uri: `cocos://projects/${game.instance.projectId}/capabilities` })).contents.length);
    }
    await f.error(client, 'cocos_scene_query', { projectId: first.instance.projectId, instanceId: second.instance.instanceId, params: {} }, 'CONTEXT_UNAVAILABLE');
    assert.equal(Json.object((await f.call(client, 'cocos_scene_query', { projectId: first.instance.projectId, params: {} })).result!).marker, 'game-a');
    await f.error(client, 'cocos_scene_save', { projectId: first.instance.projectId, instanceId: first.instance.instanceId, params: {}, expectedRevision: '0' }, 'INVALID_ARGUMENT');
    await f.error(client, 'cocos_scene_save', { projectId: first.instance.projectId, instanceId: first.instance.instanceId, params: {}, operationId: 'save-a' }, 'INVALID_ARGUMENT');
    await f.call(client, 'cocos_project_disconnect', { projectId: first.instance.projectId });
    await f.error(client, 'cocos_scene_query', { projectId: first.instance.projectId, instanceId: first.instance.instanceId, params: {} }, 'NOT_FOUND');
    assert.equal(((await f.call(client, 'cocos_projects')).rows as JsonObject[]).length, 1);
    await f.stopped(first.connections);
  } finally { await f.close(); }
});

test('unknown write outcome is reconciled by original operation and is never replayed by reconnecting clients', async () => {
  const f = new UnifiedFixture(); await f.setup(); const game = await f.game('write-game');
  try {
    const client = await f.client();
    const args = { workspacePath: game.root, params: {}, operationId: 'save-once', expectedRevision: '0' };
    const controller = new AbortController();
    const pending = client.callTool({ name: 'cocos_scene_save', arguments: args }, { signal: controller.signal }).catch(error => error);
    await game.editor.started.promise; controller.abort(); await pending; await game.editor.finished.promise; await delay(100);
    const other = await f.client(); await f.call(other, 'cocos_project_connect', { projectPath: game.root });
    const outcome = await f.call(other, 'cocos_operation_query', { projectId: game.instance.projectId, instanceId: game.instance.instanceId, operationId: 'save-once' });
    assert.equal(game.editor.saves, 1); assert.ok(JSON.stringify(outcome).includes('completed') || Json.object(outcome.result ?? {}).saves === 1);
    await f.call(other, 'cocos_scene_save', args); assert.equal(game.editor.saves, 1);
    await f.error(other, 'cocos_scene_save', { ...args, expectedRevision: '1' }, 'OPERATION_CONFLICT');
  } finally { await f.close(); }
});

test('legacy HTTP services are reused and legacy stdio ownership is never seized', async () => {
  const f = new UnifiedFixture(); await f.setup(); const game = await f.game('legacy-game'), projects = new ProjectRegistry(); await projects.add(game.root);
  const host = new ServiceHost(projects);
  try {
    await host.start({ transport: 'http', owner: 'extension' }); const descriptor = await game.connections.active();
    const client = await f.client(), connected = await f.call(client, 'cocos_project_connect', { projectPath: game.root });
    assert.equal(Json.object(connected.connection!).backendMode, 'external');
    assert.equal(Json.object(connected.connection!).serviceId, descriptor?.serviceId);
    await client.close(); assert.equal((await game.connections.active())?.serviceId, descriptor?.serviceId);
    await host.close();
    const lease = await game.connections.claim('stdio', 'client');
    try { await lease.publish(null); const other = await f.client(); await f.error(other, 'cocos_project_connect', { projectPath: game.root }, 'RESOURCE_BUSY'); assert.equal((await game.connections.active())?.serviceId, lease.snapshot().serviceId); }
    finally { await lease.close(); }
  } finally { await host.close(); await f.close(); }
});

test('project locator recognizes Creator 2/3 roots, subdirectories and aliases while rejecting non-projects and escapes', async () => {
  const root = await new TestWorkspace().create('project-locator-'), outside = await new TestWorkspace().create('project-outside-');
  const modern = join(root, 'modern'), legacy = join(root, 'legacy'), generic = join(root, 'generic');
  for (const game of [modern, legacy, generic, outside]) await mkdir(join(game, 'assets/subdir'), { recursive: true });
  await writeFile(join(modern, 'package.json'), JSON.stringify({ creator: { version: '3.8.8' } }));
  await writeFile(join(legacy, 'project.json'), JSON.stringify({ engine: 'cocos-creator-js', version: '2.4.15' }));
  await writeFile(join(outside, 'package.json'), JSON.stringify({ creator: { version: '3.8.8' } }));
  await symlink(modern, join(root, 'alias')); await symlink(outside, join(root, 'escape'));
  const locator = new ProjectLocator([root]);
  assert.equal((await locator.locate(join(modern, 'assets/subdir'))).root, modern);
  assert.equal((await locator.locate(join(root, 'alias'))).root, modern);
  assert.equal((await locator.locate(legacy)).root, legacy);
  await assert.rejects(locator.locate(generic), /No Creator/);
  await assert.rejects(locator.locate(join(root, 'escape')), { code: 'PATH_OUTSIDE_PROJECT' });
  await assert.rejects(locator.locate('relative/project'), { code: 'INVALID_ARGUMENT' });
  await symlink(outside, join(modern, 'linked')); await assert.rejects(locator.locate(join(modern, 'linked')), { code: 'PATH_OUTSIDE_PROJECT' });
});

test('installed versions validate checksums and preserve policy on repeated installation', async () => {
  const f = new UnifiedFixture(); await f.setup();
  const before = await readFile(join(f.installation, 'policy.json'), 'utf8');
  await new ClientInstallation().install(f.root, resolve('.codex-work/build/client'), [f.root]);
  assert.equal(await readFile(join(f.installation, 'policy.json'), 'utf8'), before);
  const installed = await new ClientPackage().installed(f.installation);
  await writeFile(join(f.installation, installed.current.versionPath, 'worker.mjs'), 'corrupt');
  await assert.rejects(new ClientPackage().configuration(f.installation, process.execPath), /checksum mismatch/);
});

test('client upgrades preserve immutable versions and policy; verified rollback restores the previous pointer', async () => {
  const f = new UnifiedFixture(); await f.setup(); const packages = new ClientPackage(), installer = new ClientInstallation();
  const first = await packages.installed(f.installation), policy = await readFile(join(f.installation, 'policy.json'), 'utf8');
  const candidate = join(f.root, 'candidate'); await cp(resolve('.codex-work/build/client'), candidate, { recursive: true });
  const license = await readFile(join(candidate, 'LICENSE'), 'utf8') + '\nUpgrade fixture\n'; await writeFile(join(candidate, 'LICENSE'), license);
  const manifest = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8'));
  manifest.fileHashes.LICENSE = createHash('sha256').update(license).digest('hex'); manifest.buildId = createHash('sha256').update(license).digest('hex').slice(0, 16); await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
  await installer.install(f.root, candidate, [f.root]); assert.equal((await packages.installed(f.installation)).current.buildId, manifest.buildId);
  assert.equal((await packages.verify(join(f.installation, first.current.versionPath))).buildId, first.manifest.buildId);
  await installer.rollback(f.root); assert.equal((await packages.installed(f.installation)).current.buildId, first.current.buildId);
  assert.equal(await readFile(join(f.installation, 'policy.json'), 'utf8'), policy);
});


test('automatic stdio target resolution isolates canonical workspaces, explicit targets and host-provided defaults', async () => {
  const f = new UnifiedFixture(); await f.setup(); const first = await f.game('overlap'), second = await f.game('overlap-copy');
  try {
    const client = await f.client();
    const tool = (await client.listTools()).tools.find(row => row.name === 'cocos_scene_query')!;
    assert.ok(tool.inputSchema.properties?.workspacePath); assert.ok(tool.inputSchema.properties?.projectPath);
    assert.ok(!tool.inputSchema.required?.includes('projectId'));
    await f.error(client, 'cocos_scene_query', { params: {} }, 'INVALID_ARGUMENT');
    await symlink(first.root, join(f.root, 'alias'));
    const requests = [first.root, second.root, join(f.root, 'alias/assets')];
    const values = await Promise.all(requests.map(workspacePath => f.call(client, 'cocos_scene_query', { workspacePath, params: {} })));
    assert.deepEqual(values.map(value => Json.object(value.result!).marker), ['overlap', 'overlap-copy', 'overlap']);
    assert.equal(((await f.call(client, 'cocos_projects')).rows as JsonObject[]).length, 2);
    const explicit = await f.call(client, 'cocos_scene_query', { projectPath: second.root, workspacePath: first.root, params: {} });
    assert.equal(Json.object(explicit.result!).marker, 'overlap-copy');
    const explicitId = await f.call(client, 'cocos_scene_query', { projectId: first.instance.projectId, projectPath: second.root, workspacePath: '/not/a/workspace', params: {} });
    assert.equal(Json.object(explicitId.result!).marker, 'overlap');
    const separate = await f.client(second.root);
    assert.equal(Json.object((await f.call(separate, 'cocos_scene_query', { params: {} })).result!).marker, 'overlap-copy');
    assert.equal(((await f.call(separate, 'cocos_projects')).rows as JsonObject[]).length, 1);
  } finally { await f.close(); }
});

test('parent workspaces reject multiple known projects, support exact mappings and preserve editor instance ambiguity', async () => {
  const f = new UnifiedFixture(); await f.setup(); const first = await f.game('parent-a'), second = await f.game('parent-b');
  try {
    const policy = JSON.parse(await readFile(join(f.installation, 'policy.json'), 'utf8'));
    await writeFile(join(f.installation, 'policy.json'), JSON.stringify({ ...policy, allowedRoots: [first.root, second.root] }));
    const client = await f.client();
    const ambiguous = await client.callTool({ name: 'cocos_scene_query', arguments: { workspacePath: f.root, params: {} } });
    assert.equal(Json.object(Json.object(ambiguous.structuredContent).error!).code, 'AMBIGUOUS_TARGET');
    assert.ok(JSON.stringify(ambiguous).includes(first.root)); assert.ok(JSON.stringify(ambiguous).includes(second.root));
    assert.deepEqual((await f.call(client, 'cocos_projects')).rows, []);
    await writeFile(join(f.installation, 'policy.json'), JSON.stringify({ ...policy, allowedRoots: [first.root, second.root], workspaceMappings: [{ workspacePath: f.root, projectPath: first.root }] }));
    const mapped = await f.client();
    assert.equal(Json.object((await f.call(mapped, 'cocos_scene_query', { workspacePath: f.root, params: {} })).result!).marker, 'parent-a');
    assert.equal(Json.object((await f.call(mapped, 'cocos_scene_query', { workspacePath: second.root, params: {} })).result!).marker, 'parent-b');
    const duplicate = new EditorBridge(new RoutedEditor('another-instance'), first.root, '3.8.8'); await duplicate.start(); f.bridges.push(duplicate);
    const error = await mapped.callTool({ name: 'cocos_scene_query', arguments: { workspacePath: f.root, params: {} } });
    assert.equal(Json.object(Json.object(error.structuredContent).error!).code, 'AMBIGUOUS_TARGET');
    assert.ok(!JSON.stringify(error).includes('"token"'));
    assert.equal(Json.object((await f.call(mapped, 'cocos_scene_query', { workspacePath: f.root, instanceId: first.instance.instanceId, params: {} })).result!).marker, 'parent-a');
    await f.error(mapped, 'cocos_scene_query', { workspacePath: f.root, instanceId: second.instance.instanceId, params: {} }, 'CONTEXT_UNAVAILABLE');
  } finally { await f.close(); }
});
