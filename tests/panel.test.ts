import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, writeFile, unlink } from 'node:fs/promises';
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
  major: 2 | 3 = 3;
  html = '';
  registrations = 0;
  polls = new Set<() => void>();
  actions = new Map<string, { disabled: boolean; click: (() => void) | undefined }>();
  tabs = new Map<string, () => void>();
  copies = new Map<string, { disabled: boolean; click?: () => void }>();
  languages = new Map<string, () => void>();
  pages = new Map<string, () => void>();
  selects = new Map<string, { value: string; change?: () => void; focus?: () => void; blur?: () => void }>();
  command: (message: string, value?: unknown) => Promise<unknown> = async () => {};

  root = {
    get innerHTML(): string { return ''; },
    set innerHTML(value: string) { void value; },
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector === '[data-locale]') {
        this.languages.clear();
        return ['zh', 'en'].map(locale => ({ dataset: { locale }, disabled: false, addEventListener: (_event: string, callback: () => void) => { this.languages.set(locale, callback); } }));
      }
      if (selector === '[data-copy-log]') {
        this.copies.clear();
        return [...this.html.matchAll(/data-copy-log="([^"]+)"/g)].map(match => {
          const copy = { disabled: false } as { disabled: boolean; click?: () => void };
          this.copies.set(match[1]!, copy);
          return { dataset: { copyLog: match[1] }, get disabled() { return copy.disabled; }, set disabled(value: boolean) { copy.disabled = value; }, addEventListener: (_event: string, callback: () => void) => { copy.click = callback; } };
        });
      }
      if (selector === '[data-tab]' || selector === '[data-log-page]') {
        const field = selector === '[data-tab]' ? 'tab' : 'logPage';
        const attribute = field === 'tab' ? 'data-tab' : 'data-log-page';
        const registrations = field === 'tab' ? this.tabs : this.pages;
        registrations.clear();
        return [...this.html.matchAll(new RegExp(`<button[^>]*${attribute}="([^"]+)"[^>]*>`, 'g'))].map(match => ({
          dataset: { [field]: match[1] }, disabled: match[0].includes(' disabled'),
          getAttribute: (name: string) => name === 'aria-label' ? /aria-label="([^"]+)"/.exec(match[0])?.[1] ?? null : null,
          addEventListener: (_event: string, callback: () => void) => { registrations.set(match[1]!, callback); },
        }));
      }
      if (selector === '[data-log-select]') {
        this.selects.clear();
        return [...this.html.matchAll(/<select data-log-select="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)].map(match => {
          const control = { value: /<option value="([^"]+)" selected/.exec(match[2]!)?.[1] ?? '' } as { value: string; change?: () => void; focus?: () => void; blur?: () => void };
          this.selects.set(match[1]!, control);
          return { dataset: { logSelect: match[1] }, get value() { return control.value; }, addEventListener: (event: 'change' | 'focus' | 'blur', callback: () => void) => { control[event] = callback; } };
        });
      }
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
    this.major = major;
    const path = join(buildRoot, `extensions/creator${major}/dist/panel.${major === 2 ? 'js' : 'cjs'}`);
    const module = { exports: {} };
    const register = (definition: Definition): Definition => { this.registrations++; return definition; };
    runInNewContext(await readFile(path, 'utf8'), {
      module, exports: module.exports,
      // 打包后的渲染入口必须自包含，不允许重新引入 fs、HTTP 客户端或读取桥接凭证。
      require: (name: string) => { throw new Error(`Unexpected renderer dependency: ${name}`); },
      Editor: {
        Panel: major === 2 ? { extend: register } : legacy3 ? {} : { define: register },
        Message: { request: (name: string, message: string, value?: unknown) => {
          assert.equal(major, 3); assert.equal(name, 'cocos-mcp-creator3'); assert.ok(['panel-state', 'extension-check', 'extension-update', 'start', 'stop', 'service-start', 'service-stop', 'set-language', 'copy-log'].includes(message));
          return message === 'panel-state' ? respond() : this.command(message, value);
        } },
        Ipc: { sendToMain: (message: string, ...args: unknown[]) => {
          const reply = args.pop() as (error: unknown, result?: unknown) => void;
          assert.equal(typeof reply, 'function');
          const value = args[0];
          assert.equal(major, 2); assert.ok(message.startsWith('cocos-mcp-creator2:'));
          const action = message.replace('cocos-mcp-creator2:', '');
          void (action === 'panel-state' ? respond() : this.command(action, value)).then(result => reply(null, result), reply);
        } },
      },
      setTimeout, clearTimeout,
      setInterval: (callback: () => void) => { this.polls.add(callback); return callback; },
      clearInterval: (callback: () => void) => { this.polls.delete(callback); },
    }, { filename: path });
    return module.exports as Definition;
  }
  async ready(definition: Definition): Promise<void> {
    // 模拟各版本真实的选择器绑定，不能让 Creator 2 测试误用 Creator 3 的宿主。
    const root = this.root as unknown as HTMLElement;
    await definition.ready.call(this.major === 2 ? { $root: root } : { $: { root } });
  }
}

test('Creator 2: native selector binding renders and close permits window disposal', async () => {
  const harness = new PanelHarness();
  const definition = await harness.load(2, async () => ({ ...snapshot, creatorMajor: 2, editorVersion: '2.4.15' }));
  await harness.ready(definition);
  assert.match(harness.html, /2\.4\.15/);
  assert.equal(harness.polls.size, 1);
  assert.equal(definition.close(), true);
  assert.equal(harness.polls.size, 0);
});

for (const major of [2, 3] as const) {
  test(`Creator ${major}: log controls filter, page, refresh and preserve an active native select`, async () => {
    const harness = new PanelHarness();
    const current = { ...snapshot, logs: Array.from({ length: 135 }, (_, index) => ({ sequence: index + 1, level: index % 2 ? 'info' : 'error', message: `event-${index + 1}` })) };
    const definition = await harness.load(major, async () => current);
    await harness.ready(definition);
    try {
      harness.tabs.get('logs')!();
      assert.match(harness.html, /1–20 \/ 共 135 条/);
      harness.pages.get('2')!();
      assert.match(harness.html, /21–40 \/ 共 135 条/);
      assert.match(harness.html, /历史快照/);
      const filter = harness.selects.get('level')!;
      filter.focus!();
      const before = harness.html;
      current.logs.push({ sequence: 136, level: 'warn', message: 'new warning' });
      for (const poll of harness.polls) poll();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(harness.html, before);
      filter.value = 'error'; filter.change!();
      assert.match(harness.html, /1–20 \/ 共 68 条/);
      assert.doesNotMatch(harness.html, /class="log-level info"/);
      const size = harness.selects.get('size')!;
      size.value = '50'; size.change!();
      assert.match(harness.html, /1–50 \/ 共 68 条/);
      harness.pages.get('2')!();
      assert.match(harness.html, /51–68 \/ 共 68 条/);
      const empty = harness.selects.get('level')!;
      empty.value = 'warn'; empty.change!();
      assert.match(harness.html, /共 1 条/);
      const info = harness.selects.get('level')!;
      info.value = 'all'; info.change!();
      harness.pages.get('2')!();
      harness.actions.get('refresh')!.click!();
      await new Promise(resolve => setImmediate(resolve));
      assert.match(harness.html, /1–50 \/ 共 136 条/);
      assert.doesNotMatch(harness.html, /历史快照/);
    } finally { definition.close(); }
  });

  test(`Creator ${major}: installed manifest and menu resolve the bundled default panel`, async () => {
    const project = await mkdtemp(resolve('.codex-work/tmp/panel-install-'));
    const installer = new ExtensionInstaller();
    const first = await installer.install(project, major, buildRoot);
    const installed = await installer.install(project, major, buildRoot);
    assert.equal(installed.installedPath, first.installedPath);
    assert.ok(installed.backupPath);
    const manifest = JSON.parse(await readFile(join(installed.installedPath, 'package.json'), 'utf8'));
    assert.deepEqual(major === 2 ? Object.keys(manifest['main-menu']).map(key => key.split('/')[1]) : manifest.contributions.menu.map((row: { label: string }) => row.label), ['关于 CocosMCP', '打开控制中心', '检查更新']);
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

  test(`Creator ${major}: menu navigation opens about and updates without installing`, async () => {
    const harness = new PanelHarness();
    const current: PanelState = { ...snapshot, creatorMajor: major, navigation: { page: 'about', revision: 1 }, extension: { version: '0.1.0', buildId: 'local-build', installedVersion: '0.1.0', installedBuildId: 'local-build', reloadRequired: false, updating: false, checking: false, message: null } };
    const definition = await harness.load(major, async () => current);
    const calls: string[] = []; harness.command = async message => { calls.push(message); };
    try {
      await harness.ready(definition);
      assert.match(harness.html, /<h2>关于 CocosMCP<\/h2>/); assert.match(harness.html, /MIT/);
      harness.tabs.get('logs')!();
      for (const poll of harness.polls) poll(); await new Promise(resolve => setImmediate(resolve));
      assert.doesNotMatch(harness.html, /<h2>关于 CocosMCP<\/h2>/);
      current.navigation = { page: 'updates', revision: 2 };
      for (const poll of harness.polls) poll(); await new Promise(resolve => setImmediate(resolve));
      assert.match(harness.html, /<h2>检查更新<\/h2>/);
      harness.actions.get('extension-check')!.click!(); await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(calls, ['extension-check']);
      current.extension!.checking = true;
      for (const poll of harness.polls) poll(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(harness.actions.get('extension-check')!.disabled, true);
    } finally { definition.close(); }
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

test('panel reads authenticated runtime sessions without exposing tokens and reports gateway failure', async (t) => {
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
  const stalePath = join(project, '.codex-work/cache/cocos-mcp/runtime-2147483647.json');
  const originalKill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    if (pid === 2147483647) throw Object.assign(new Error('Exited gateway'), { code: 'ESRCH' });
    return originalKill(pid, signal);
  });
  // 即使旧配置损坏，也应在读取或联网前跳过；不能污染健康网关的状态。
  await writeFile(stalePath, '{stale');

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
  await unlink(path);
  const staleOnly = await bridge.panelStateWithRuntime();
  assert.equal(staleOnly.runtimeConfigured, false);
  assert.deepEqual(staleOnly.runtimeStatus, { connected: 0, error: null });
  assert.equal(await readFile(stalePath, 'utf8'), '{stale');

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

for (const major of [2, 3] as const) {
  test(`Creator ${major}: copy errors and switch panel language through IPC`, async () => {
    const harness = new PanelHarness();
    const current: PanelState = { ...snapshot, logs: Array.from({ length: 45 }, (_, index) => ({ sequence: index + 1, level: index % 2 ? 'info' : 'error', occurredAt: '2026-09-15T00:00:00Z', message: `原始错误 <tag> ${index}`, details: { stack: 'first\nsecond' } })) };
    const copied: string[] = [];
    harness.command = async (message, value) => {
      if (message === 'copy-log') copied.push(String(value));
      if (message === 'set-language') current.locale = value as 'zh' | 'en';
    };
    const definition = await harness.load(major, async () => current);
    await harness.ready(definition);
    try {
      harness.tabs.get('logs')!();
      assert.ok(harness.copies.has('45'));
      assert.match(harness.html, /class="page-heading log-header"/);
      assert.ok(!harness.html.includes('class="log-toolbar"'));
      assert.match(harness.html, /aria-label="复制错误日志"[^>]*><svg/);
      assert.ok(!harness.copies.has('44'));
      harness.copies.get('45')!.click!();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(JSON.parse(copied[0]!).message, '原始错误 <tag> 44');
      assert.equal(JSON.parse(copied[0]!).details.stack, 'first\nsecond');
      harness.copies.get('all')!.click!();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((copied[1]!.match(/"level": "error"/g) ?? []).length, 23);
      assert.ok(!copied[1]!.includes('"level": "info"'));
      harness.languages.get('en')!();
      await new Promise(resolve => setImmediate(resolve));
      assert.match(harness.html, /Bridge logs/);
      assert.match(harness.html, /Copy all errors/);
      assert.match(harness.html, /原始错误 &lt;tag&gt;/);
      for (const tab of ['overview', 'capabilities', 'runtime']) {
        harness.tabs.get(tab)!();
        const withoutLanguageChoice = harness.html.replace(/简体中文|中文/g, '');
        assert.deepEqual(withoutLanguageChoice.match(/[\u3400-\u9fff]+/g), null);
      }
      harness.languages.get('zh')!();
      await new Promise(resolve => setImmediate(resolve));
      assert.match(harness.html, /控制中心/);
    } finally { definition.close(); }
  });
}
