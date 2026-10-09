import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, symlink, mkdir, unlink, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ProjectPaths } from '../packages/application/src/paths.js';
import { ProjectRegistry } from '../packages/application/src/registry.js';
import { ServiceConnections } from '../packages/application/src/service-connections.js';
import { ServiceHost } from '../apps/server/src/service-host.js';
import { McpService } from '../extensions/shared/mcp-service.js';
import { ExtensionInstaller } from '../packages/native-adapters/src/installer.js';

class ConnectionFixture {
  async project() {
    const root = await mkdtemp(resolve('.codex-work/tmp/mcp-connection-test-'));
    const paths = await ProjectPaths.open(root), registry = new ProjectRegistry(); await registry.add(root);
    return { root, paths, registry, connections: new ServiceConnections(paths), extension: resolve('.codex-work/build/extensions/creator3') };
  }
  async bind(server: Server, port = 0): Promise<number> {
    server.listen(port, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
  }
  async close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); }
  async status(url: string, headers: Record<string, string>): Promise<number> {
    return new Promise((accept, reject) => {
      const call = httpRequest(url, { method: 'POST', headers }, response => { response.resume(); response.once('end', () => accept(response.statusCode!)); });
      call.on('error', reject); call.end('{}');
    });
  }
  async projects(client: Client, root: string): Promise<void> {
    assert.ok((await client.listTools()).tools.some(row => row.name === 'cocos_projects'));
    const result = await client.callTool({ name: 'cocos_projects', arguments: {} });
    assert.notEqual(result.isError, true);
    assert.ok(JSON.stringify(result).includes(root));
  }
  process(root: string, extension: string): { child: ChildProcess; ready: Promise<string> } {
    const child = spawn(process.execPath, [join(extension, 'dist/service.mjs'), '--project', root], {
      cwd: root, env: { ...process.env, TMPDIR: join(root, '.codex-work/tmp'), TMP: join(root, '.codex-work/tmp'), TEMP: join(root, '.codex-work/tmp'), XDG_CACHE_HOME: join(root, '.codex-work/cache') },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const ready = new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Service did not become ready')); }, 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Service exited: ${code}`)); });
      child.on('message', message => { const row = message as { type?: string; endpoint?: string }; if (row.type === 'ready' && row.endpoint) { clearTimeout(timer); accept(row.endpoint); } });
    });
    child.stderr?.resume(); return { child, ready };
  }
  async stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit'); child.kill(signal); await exit;
  }
  async within<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([operation, new Promise<never>((_accept, reject) => { timer = setTimeout(() => reject(new Error('Process did not finish in time')), 10000); })]); }
    finally { clearTimeout(timer); }
  }
}

test('HTTP URL and token survive restarts and an SDK client reconnects to the same project', async () => {
  const fixture = new ConnectionFixture(), { root, registry, connections } = await fixture.project();
  let endpoint: string | null = null, token = '';
  for (let iteration = 0; iteration < 3; iteration++) {
    const host = new ServiceHost(registry);
    const client = new Client({ name: 'restart-test', version: '1' });
    try {
      const current = await host.start({ transport: 'http', owner: 'client' });
      assert.ok(current);
      if (iteration) { assert.equal(current, endpoint); assert.equal(await connections.token(), token); }
      endpoint = current; token = await connections.token();
      await client.connect(new StreamableHTTPClientTransport(new URL(current), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      await fixture.projects(client, root);
      const state = await connections.active(); assert.equal(state?.owner, 'client'); assert.equal(state?.endpoint, current);
      assert.ok(!JSON.stringify(state).includes(token));
    } finally { await client.close(); await host.close(); }
    assert.equal(await connections.active(), null);
    assert.ok(await connections.port() > 0);
  }
});

test('occupied saved port fails without fallback, releases the lease, and can recover', async () => {
  const fixture = new ConnectionFixture(), { registry, connections } = await fixture.project();
  const blocker = createServer(), port = await fixture.bind(blocker);
  await connections.savePort(port);
  try {
    const host = new ServiceHost(registry);
    await assert.rejects(host.start({ transport: 'http', owner: 'extension' }), /已被占用/);
    await host.close(); assert.equal(await connections.port(), port); assert.equal(await connections.active(), null);
  } finally { await fixture.close(blocker); }
  const recovered = new ServiceHost(registry);
  try { assert.equal(await recovered.start({ transport: 'http', owner: 'extension' }), `http://127.0.0.1:${port}/mcp`); }
  finally { await recovered.close(); }
});

test('simultaneous independent processes create only one service; forced exit permits authenticated recovery', async () => {
  const fixture = new ConnectionFixture(), { root, extension, connections } = await fixture.project();
  const starts = [fixture.process(root, extension), fixture.process(root, extension)];
  try {
    const outcomes = await Promise.allSettled(starts.map(row => row.ready));
    assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
    const winner = starts[outcomes.findIndex(row => row.status === 'fulfilled')]!;
    const endpoint = (outcomes.find(row => row.status === 'fulfilled') as PromiseFulfilledResult<string>).value;
    assert.equal((await connections.active())?.pid, winner.child.pid);
    await fixture.stop(winner.child, 'SIGKILL');
    assert.equal(await connections.active(), null);
    const recovered = fixture.process(root, extension);
    try { assert.equal(await recovered.ready, endpoint); assert.equal((await connections.active())?.pid, recovered.child.pid); }
    finally { await fixture.stop(recovered.child); }
  } finally { await Promise.all(starts.map(row => fixture.stop(row.child))); }
});

for (const major of [2, 3] as const) {
  test(`Creator ${major} offline stdio bundle works outside source checkout and the panel preserves client ownership`, async () => {
    const fixture = new ConnectionFixture(), { root, connections } = await fixture.project();
    const installed = await new ExtensionInstaller().install(root, major, resolve('.codex-work/build'));
    const panel = new McpService(root, installed.installedPath);
    const config = JSON.parse(await panel.configuration('stdio')).mcpServers.cocos as { command: string; args: string[]; env: Record<string, string> };
    assert.equal(config.command, process.execPath); assert.ok(config.args[0]!.startsWith(installed.installedPath));
    assert.ok(config.env.TMPDIR!.startsWith(root + '/.codex-work/tmp/')); assert.equal(config.env.TZ, 'UTC');
    assert.deepEqual(Object.keys(config.env).sort(), ['NODE_COMPILE_CACHE', 'TEMP', 'TMP', 'TMPDIR', 'TZ', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].sort());
    const client = new Client({ name: 'offline-test', version: '1' });
    const transport = new StdioClientTransport({ ...config, cwd: root, stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport); await fixture.projects(client, root);
      const state = await panel.inspect(); assert.equal(state.status, 'running'); assert.equal(state.owner, 'client'); assert.equal(state.managed, false); assert.equal(state.endpoint, null);
      await assert.rejects(panel.start(), /AI 客户端管理/);
      await panel.stop(); assert.equal((await connections.active())?.transport, 'stdio');
      await assert.rejects(panel.configurePort('12345'), /AI 客户端管理/);
      await assert.rejects(panel.configuration('http'), /HTTP MCP/);
    } finally { await client.close(); }
    assert.equal(await connections.active(), null);
    await assert.rejects(access(join(root, '.codex-work/cache/cocos-mcp/service.lock')), { code: 'ENOENT' });
  });
}

test('service identity rejects foreign project, forged generation, missing credentials, Origin and Host', async () => {
  const { connections } = await new ConnectionFixture().project();
  const lease = await connections.claim('stdio', 'client');
  try {
    await lease.publish(null);
    const descriptor = lease.snapshot(), token = lease.token();
    const request = (headers: Record<string, string>) => fetch(descriptor.identityEndpoint, { method: 'POST', headers, body: '{}' });
    assert.equal((await request({})).status, 401);
    assert.equal((await request({ Authorization: `Bearer ${token}`, Origin: 'https://example.com' })).status, 403);
    assert.equal(await new ConnectionFixture().status(descriptor.identityEndpoint, { Authorization: `Bearer ${token}`, Host: 'example.com' }), 403);
    await connections.atomic('service.json', { ...descriptor, serviceId: '00000000-0000-0000-0000-000000000000' });
    await assert.rejects(connections.active(), /authenticated identity/);
    await connections.atomic('service.json', { ...descriptor, projectId: 'foreign' });
    await assert.rejects(connections.active(), /does not match/);
    await connections.atomic('service.json', { ...descriptor, startedAt: '2026-10-09T08:00:00' });
    await assert.rejects(connections.active(), /does not match/);
    await connections.atomic('service.json', descriptor);
    await unlink(await connections.paths.resolve(descriptor.tokenFile));
    await assert.rejects(connections.active(), /authenticated identity/);
    await assert.rejects(access(await connections.paths.resolve(descriptor.tokenFile)), { code: 'ENOENT' });
  } finally { await lease.close(); }
});

test('port configuration guards invalid values and live ownership; symlinks cannot overwrite connection state', async () => {
  const { connections, paths } = await new ConnectionFixture().project();
  await assert.rejects(connections.configurePort(-1), /integer/);
  await connections.configurePort(23456); assert.equal(await connections.port(), 23456);
  const lease = await connections.claim('stdio', 'client');
  try { await lease.publish(null); await assert.rejects(connections.configurePort(0), { code: 'RESOURCE_BUSY' }); assert.equal(await connections.port(), 23456); }
  finally { await lease.close(); }
  await connections.configurePort(0); assert.equal(await connections.port(), 0);
  const outside = await mkdtemp(resolve('.codex-work/tmp/connection-outside-')), destination = join(outside, 'config.json');
  await writeFile(destination, '{"preserved":true}');
  const config = await paths.resolve('.codex-work/cache/cocos-mcp/connection.json'); await unlink(config); await symlink(destination, config);
  await assert.rejects(connections.savePort(12345), { code: 'PATH_OUTSIDE_PROJECT' }); assert.equal(await readFile(destination, 'utf8'), '{"preserved":true}');
  await unlink(config);
  const internal = await paths.resolve('config.json'); await writeFile(internal, '{}'); await symlink(internal, config);
  await assert.rejects(connections.savePort(12345), /regular file/); assert.equal(await readFile(internal, 'utf8'), '{}');
});

test('two projects have distinct ports and state; changing configuration retains authentication token', async () => {
  const fixture = new ConnectionFixture(), first = await fixture.project(), second = await fixture.project();
  const hosts = [new ServiceHost(first.registry), new ServiceHost(second.registry)];
  try {
    const endpoints = await Promise.all(hosts.map(host => host.start({ transport: 'http', owner: 'client' })));
    assert.notEqual(endpoints[0], endpoints[1]);
    assert.equal((await first.connections.active())?.projectPath, first.root);
    assert.equal((await second.connections.active())?.projectPath, second.root);
  } finally { await Promise.all(hosts.map(host => host.close())); }
  const token = await first.connections.token(); await first.connections.configurePort(0); assert.equal(await first.connections.token(), token);
});

test('closing during startup releases all service listeners and descriptors', async () => {
  const { registry, connections } = await new ConnectionFixture().project(), host = new ServiceHost(registry);
  const starting = host.start({ transport: 'http', owner: 'extension' });
  await host.close(); await starting;
  assert.equal(await connections.active(), null);
  await assert.rejects(access(await connections.paths.resolve('.codex-work/cache/cocos-mcp/service.lock')), { code: 'ENOENT' });
});

test('an incomplete startup lock is reported and never removed by a competing process', async () => {
  const { connections, paths } = await new ConnectionFixture().project();
  await paths.work('cache', 'cocos-mcp'); await mkdir(await paths.resolve('.codex-work/cache/cocos-mcp/service.lock'));
  await assert.rejects(connections.claim('http', 'client'), /not ready/);
  await access(await paths.resolve('.codex-work/cache/cocos-mcp/service.lock'));
});

test('bundled stdio emits only JSON-RPC and exits cleanly when the client closes stdin', async () => {
  const fixture = new ConnectionFixture(), { root, extension, paths, connections } = await fixture.project();
  const child = spawn(process.execPath, [join(extension, 'dist/stdio.mjs'), '--project', root], { cwd: root, env: paths.environment(), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  try {
    const received = once(child.stdout, 'data');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'eof-test', version: '1' } } }) + '\n');
    const [data] = await fixture.within(received);
    for (const line of String(data).trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
    assert.equal((await connections.active())?.transport, 'stdio');
    const exit = once(child, 'exit'); child.stdin.end();
    const [code] = await fixture.within(exit); assert.equal(code, 0);
    assert.equal(await connections.active(), null);
  } finally { await fixture.stop(child); }
});
