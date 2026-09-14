import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { EditorBridge } from '../packages/editor-bridge/src/index.js';
import type { EditorAdapter } from '../packages/contracts/src/index.js';
import type { PanelState } from '../packages/editor-bridge/src/panel-state.js';
import type { createPanelDefinition } from '../extensions/shared/panel.js';
import { ExtensionInstaller } from '../packages/native-adapters/src/installer.js';

type Definition = ReturnType<typeof createPanelDefinition>;
const buildRoot = resolve('.codex-work/build');
const snapshot: PanelState = {
  projectPath: '/example/project', editorVersion: '3.8.8', creatorMajor: 3,
  instance: null, supportedCapabilities: ['scene.query'], logs: [], runtimeConfigured: false,
};

class PanelHarness {
  html = '';
  registrations = 0;
  polls = new Set<() => void>();
  actions = new Map<string, { disabled: boolean; click: (() => void) | undefined }>();
  command: (message: string) => Promise<unknown> = async () => {};

  root = {
    get innerHTML(): string { return ''; },
    set innerHTML(value: string) { void value; },
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector !== '[data-action]') return [];
      this.actions.clear();
      return [...this.html.matchAll(/data-action="([^"]+)"/g)].map(match => {
        const action = { disabled: false, click: undefined as (() => void) | undefined };
        this.actions.set(match[1]!, action);
        return { dataset: { action: match[1] }, get disabled() { return action.disabled; }, set disabled(value: boolean) { action.disabled = value; }, addEventListener: (_event: string, callback: () => void) => { action.click = callback; } };
      });
    },
    getRootNode: () => ({ activeElement: null }),
  };
  constructor() {
    Object.defineProperty(this.root, 'innerHTML', { get: () => this.html, set: (value: string) => { this.html = value; } });
  }
  async load(major: 2 | 3, respond: () => Promise<PanelState>, legacy3 = false): Promise<Definition> {
    const path = join(buildRoot, `extensions/creator${major}/dist/panel.${major === 2 ? 'js' : 'cjs'}`);
    const module = { exports: {} };
    const register = (definition: Definition): Definition => { this.registrations++; return definition; };
    runInNewContext(await readFile(path, 'utf8'), {
      module, exports: module.exports,
      // 打包后的渲染入口必须自包含，不允许重新引入 fs、HTTP 客户端或读取桥接凭证。
      require: (name: string) => { throw new Error(`Unexpected renderer dependency: ${name}`); },
      Editor: {
        Panel: major === 2 ? { extend: register } : legacy3 ? {} : { define: register },
        Message: { request: (name: string, message: string) => {
          assert.equal(major, 3); assert.equal(name, 'cocos-mcp-creator3'); assert.ok(['panel-state', 'start', 'stop', 'service-start', 'service-stop'].includes(message));
          return message === 'panel-state' ? respond() : this.command(message);
        } },
        Ipc: { sendToMain: (message: string, reply: (error: unknown, result?: unknown) => void) => {
          assert.equal(major, 2); assert.ok(message.startsWith('cocos-mcp-creator2:'));
          const action = message.replace('cocos-mcp-creator2:', '');
          void (action === 'panel-state' ? respond() : this.command(action)).then(result => reply(null, result), reply);
        } },
      },
      setTimeout, clearTimeout,
      setInterval: (callback: () => void) => { this.polls.add(callback); return callback; },
      clearInterval: (callback: () => void) => { this.polls.delete(callback); },
    }, { filename: path });
    return module.exports as Definition;
  }
  async ready(definition: Definition): Promise<void> {
    await definition.ready.call({ $: { root: this.root as unknown as HTMLElement } });
  }
}

for (const major of [2, 3] as const) {
  test(`Creator ${major}: installed manifest and menu resolve the bundled default panel`, async () => {
    const project = await mkdtemp(resolve('.codex-work/tmp/panel-install-'));
    const installer = new ExtensionInstaller();
    const first = await installer.install(project, major, buildRoot);
    const installed = await installer.install(project, major, buildRoot);
    assert.equal(installed.installedPath, first.installedPath);
    assert.ok(installed.backupPath);
    const manifest = JSON.parse(await readFile(join(installed.installedPath, 'package.json'), 'utf8'));
    const panel = major === 2 ? manifest.panel : manifest.panels.default;
    const require = createRequire(join(installed.installedPath, 'package.json'));
    assert.equal(require.resolve(join(installed.installedPath, panel.main)), join(installed.installedPath, `dist/panel.${major === 2 ? 'js' : 'cjs'}`));
    const opened: string[] = [];
    const module = { exports: {} };
    runInNewContext(await readFile(join(installed.installedPath, manifest.main), 'utf8'), {
      module, exports: module.exports, require,
      Editor: { Panel: { open: (name: string) => { opened.push(name); return Promise.resolve(); } } },
    });
    const exported = module.exports as { methods: { open(): Promise<unknown> }; messages: { open(): void } };
    if (major === 3) await exported.methods.open(); else exported.messages.open();
    assert.deepEqual(opened, [manifest.name]);
  });

  test(`Creator ${major}: bundled panel loads and displays state without a scene or browser HTTP`, async () => {
    const harness = new PanelHarness();
    const definition = await harness.load(major, async () => ({ ...snapshot, creatorMajor: major }));
    assert.equal(harness.registrations, 1);
    assert.equal(typeof definition.template, 'string');
    await harness.ready(definition);
    assert.match(harness.html, /控制中心/);
    assert.match(harness.html, /\/example\/project/);
    assert.match(harness.html, /已停止/);
    assert.equal(harness.polls.size, 1);
    definition.close();
    assert.equal(harness.polls.size, 0);
  });

  test(`Creator ${major}: closing while state is pending does not leak polling or render after disposal`, async () => {
    let complete!: (state: PanelState) => void;
    const harness = new PanelHarness();
    const definition = await harness.load(major, () => new Promise(accept => { complete = accept; }));
    const ready = harness.ready(definition);
    assert.match(harness.html, /正在连接/);
    definition.close();
    const before = harness.html;
    complete(snapshot); await ready;
    assert.equal(harness.html, before);
    assert.equal(harness.polls.size, 0);
  });
}

test('Creator 3.0–3.2 exports the panel definition when Panel.define is unavailable', async () => {
  const harness = new PanelHarness();
  const definition = await harness.load(3, async () => snapshot, true);
  await harness.ready(definition);
  assert.match(harness.html, /控制中心/);
  definition.close();
});

test('panel recovers from IPC failure on its next refresh', async () => {
  const harness = new PanelHarness();
  let fails = true;
  const definition = await harness.load(3, async () => {
    if (fails) throw new Error('extension is reloading');
    return snapshot;
  });
  await harness.ready(definition);
  assert.match(harness.html, /extension is reloading/);
  fails = false;
  for (const poll of harness.polls) poll();
  await new Promise(accept => setImmediate(accept));
  assert.doesNotMatch(harness.html, /extension is reloading/);
  assert.match(harness.html, /\/example\/project/);
  definition.close();
});

test('panel snapshot omits credentials, ignores stale files, and never requires a scene revision', async () => {
  const project = await mkdtemp(resolve('.codex-work/tmp/panel-state-'));
  const adapter: EditorAdapter = {
    major: 3, supportedCapabilities: () => ['scene.query'], dispose: async () => {},
    revision: async () => { throw new Error('No scene open'); },
    execute: async () => { throw new Error('No scene open'); },
  };
  const bridge = new EditorBridge(adapter, project, '3.8.8');
  assert.equal(bridge.panelState().instance, null);
  try {
    const descriptor = await bridge.start();
    await writeFile(join(project, '.codex-work/cache/cocos-mcp/instances/stale.json'), JSON.stringify({ ...descriptor, instanceId: 'stale-instance', pid: 0 }));
    const state = bridge.panelState();
    assert.equal(state.instance?.instanceId, descriptor.instanceId);
    assert.equal('token' in state.instance!, false);
    assert.equal(JSON.stringify(state).includes(descriptor.token), false);
    assert.deepEqual(state.supportedCapabilities, ['scene.query']);
    assert.equal(state.logs.length, 1);
    state.logs[0]!.message = 'modified by client';
    assert.notEqual(bridge.panelState().logs[0]!.message, 'modified by client');
    await assert.rejects(access(join(project, '.codex-work/cache/cocos-mcp/operations')));
  } finally { await bridge.stop(); }
  assert.equal(bridge.panelState().instance, null);
});

test('panel reads authenticated runtime sessions without exposing tokens and reports gateway failure', async () => {
  const { ProjectRegistry } = await import('../packages/application/src/registry.js');
  const { RuntimeGateway } = await import('../packages/application/src/runtime-gateway.js');
  const project = await mkdtemp(resolve('.codex-work/tmp/panel-runtime-'));
  const registry = new ProjectRegistry();
  const { projectId } = await registry.add(project);
  const gateway = new RuntimeGateway(registry);
  const bridge = new EditorBridge({ major: 3, supportedCapabilities: () => [], dispose: async () => {}, revision: async () => '', execute: async () => null }, project, '3.8.8');
  await gateway.start();
  const path = join(project, `.codex-work/cache/cocos-mcp/runtime-${process.pid}.json`);
  const configText = await readFile(path, 'utf8');
  const config = JSON.parse(configText);
  try {
    const forbidden = await fetch(`${config.url}/runtime/sessions`, { method: 'POST', body: JSON.stringify({ projectId }) });
    assert.equal(forbidden.status, 403);
    assert.deepEqual((await bridge.panelStateWithRuntime()).runtimeStatus, { connected: 0, error: null });
    const response = await fetch(`${config.url}/runtime/register`, { method: 'POST', headers: { authorization: `Bearer ${config.token}` }, body: JSON.stringify({ projectId, version: '3.8.8', platform: 'web' }) });
    const session = await response.json() as { runtimeInstanceId: string };
    const state = await bridge.panelStateWithRuntime();
    assert.equal(state.runtimeStatus?.connected, 1);
    assert.equal(JSON.stringify(state).includes(config.token), false);
    await fetch(`${config.url}/runtime/disconnect`, { method: 'POST', headers: { authorization: `Bearer ${config.token}` }, body: JSON.stringify({ projectId, ...session }) });
    assert.equal((await bridge.panelStateWithRuntime()).runtimeStatus?.connected, 0);
  } finally { await gateway.close(); }
  await writeFile(path, configText);
  assert.match((await bridge.panelStateWithRuntime()).runtimeStatus?.error ?? '', /查询失败/);
});

test('managed MCP service starts once, serves HTTP, detects external gateway and cleans up on stop', async () => {
  const { McpService } = await import('../extensions/shared/mcp-service.js');
  const project = await mkdtemp(resolve('.codex-work/tmp/managed-service-'));
  const extension = resolve('.codex-work/build/extensions/creator3');
  const service = new McpService(project, extension);
  const other = new McpService(project, extension);
  try {
    const first = service.start();
    assert.equal(service.start(), first);
    await first;
    assert.equal(service.snapshot().status, 'running');
    const endpoint = service.snapshot().endpoint!;
    const denied = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401);
    const token = (await readFile(join(project, '.codex-work/cache/cocos-mcp/mcp-http-token'), 'utf8')).trim();
    const initialized = await fetch(endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'panel-test', version: '1.0.0' } } }),
    });
    assert.equal(initialized.status, 200);
    assert.match(await initialized.text(), /serverInfo/);

    await assert.rejects(other.start(), /已有运行时网关/);
    await service.stop();
    assert.equal(service.snapshot().status, 'stopped');
    const files = await (await import('node:fs/promises')).readdir(join(project, '.codex-work/cache/cocos-mcp'));
    assert.equal(files.some(name => /^runtime-\d+\.json$/.test(name)), false);
    await service.start();
    assert.equal(service.snapshot().status, 'running');
  } finally { await service.stop(); }
});

for (const major of [2, 3] as const) {
  test(`Creator ${major}: running controls restart in order and stopped controls start`, async () => {
    const harness = new PanelHarness();
    const current: PanelState = { ...snapshot, service: { status: 'running', endpoint: 'http://127.0.0.1:1234/mcp', error: null }, instance: {
      protocolVersion: 1, projectId: 'project', projectPath: '/example/project', instanceId: 'test-instance', editorVersion: '3.8.8', creatorMajor: major, endpoint: 'http://127.0.0.1:1235/rpc', pid: 1, startedAt: '2026-09-14T00:00:00Z',
    } };
    const calls: string[] = [];
    harness.command = async message => { calls.push(message); };
    const definition = await harness.load(major, async () => current);
    await harness.ready(definition);
    try {
      assert.match(harness.html, /重启 MCP 服务/);
      assert.match(harness.html, /重启桥接/);
      assert.equal(harness.actions.get('service-restart')?.disabled, false);
      harness.actions.get('service-restart')!.click!();
      assert.equal(harness.actions.get('service-restart')?.disabled, true);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(calls, ['service-stop', 'service-start']);
      calls.length = 0;
      harness.actions.get('restart')!.click!();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(calls, ['stop', 'start']);
      calls.length = 0;
      harness.command = async message => { calls.push(message); throw new Error('stop failed'); };
      harness.actions.get('service-restart')!.click!();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(calls, ['service-stop']);
      assert.match(harness.html, /stop failed/);
      current.instance = null;
      current.service = { status: 'stopped', endpoint: null, error: null };
      for (const poll of harness.polls) poll();
      await new Promise(resolve => setImmediate(resolve));
      assert.match(harness.html, /启动 MCP 服务/);
      assert.match(harness.html, /启动桥接/);
      assert.equal(harness.actions.get('stop')?.disabled, true);
      assert.equal(harness.actions.get('service-stop')?.disabled, true);
    } finally { definition.close(); }
  });
}
