import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ClientInstallation } from '../packages/native-adapters/src/client-installation.js';
import { McpService } from '../extensions/shared/mcp-service.js';
import type { PanelState } from '../packages/editor-bridge/src/panel-state.js';
import type { createPanelDefinition } from '../extensions/shared/panel.js';
import { Json } from '../packages/contracts/src/index.js';
import { TestWorkspace } from './workspace.js';

test('extension main process copies verified unified Codex configuration without a game path or credentials', async () => {
  const root = await new TestWorkspace().create('unified-panel-'), installed = Json.object(await new ClientInstallation().install(root, resolve('.codex-work/build/client'), [root]));
  const extension = join(root, 'extension'); await mkdir(extension); await writeFile(join(extension, 'service-config.json'), JSON.stringify({ nodeExecutable: process.execPath, clientInstallation: installed.installedPath }));
  const service = new McpService(root, extension), state = await service.inspect(); assert.equal(state.unifiedClient?.installed, true);
  const configuration = await service.configuration('unified'); assert.match(configuration, /\[mcp_servers\.cocos_unified\]/);
  assert.doesNotMatch(configuration, /\[mcp_servers\.cocos(?:\]|\.)/); assert.doesNotMatch(configuration, /^\s*(?:url|http_headers|bearer_token_env_var)\s*=/m);
  assert.ok(!configuration.includes('--project')); assert.ok(!configuration.includes('Bearer'));
});
for (const major of [2, 3] as const) test(`Creator ${major} panel selects installed unified client and blocks raw shared HTTP configuration`, async () => {
  const window = parseHTML('<html><body><div id="root"></div></body></html>').window, root = window.document.querySelector('#root') as unknown as HTMLElement;
  root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
  const snapshot: PanelState = { projectPath: '/example/game', editorVersion: `${major}.0.0`, creatorMajor: major, instance: null, supportedCapabilities: [], logs: [], runtimeConfigured: false,
    service: { status: 'running', endpoint: 'http://127.0.0.1:54321/mcp', error: null, managed: false, shared: true, clientCount: 2, unifiedClient: { installed: true, version: '0.1.0', buildId: 'test' } } };
  const calls: unknown[][] = [], reply = async (message: string, value?: unknown) => message === 'panel-state' ? snapshot : calls.push([message, value]);
  const module = { exports: {} };
  const entry = resolve(`.codex-work/build/extensions/creator${major}/dist/panel.${major === 2 ? 'js' : 'cjs'}`);
  runInNewContext(await readFile(entry, 'utf8'), { module, exports: module.exports, require: () => { throw new Error('Renderer dependencies are forbidden'); }, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    Editor: { Panel: { extend: (definition: unknown) => definition, define: (definition: unknown) => definition }, Message: { request: (_name: string, message: string, value?: unknown) => reply(message, value) },
      Ipc: { sendToMain: (name: string, ...args: unknown[]) => { const callback = args.pop() as (error: unknown, value: unknown) => void; void reply(name.split(':')[1]!, args[0]).then(value => callback(null, value)); } } } });
  const panel = module.exports as ReturnType<typeof createPanelDefinition>;
  try {
    await panel.ready.call(major === 2 ? { $root: root } : { $: { root } });
    assert.match(root.innerHTML, /统一 stdio（多工程）/); assert.match(root.innerHTML, /已连接会话：2/); assert.ok(!root.innerHTML.includes('54321'));
    root.querySelector<HTMLButtonElement>('[data-action="copy-connection"]')!.click(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, [['copy-connection', 'unified']]);
    const trigger = root.querySelector<HTMLButtonElement>('[data-dropdown-trigger="connection-mode"]')!; trigger.getBoundingClientRect = () => ({ left: 10, top: 20, right: 260, bottom: 56, width: 250, height: 36 }) as DOMRect;
    trigger.click(); root.querySelector<HTMLButtonElement>('[data-dropdown-value="http"]')!.click();
    assert.equal(root.querySelector<HTMLButtonElement>('[data-action="copy-connection"]')!.disabled, true);
    snapshot.locale = 'en'; root.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.click(); await new Promise(resolve => setImmediate(resolve));
    // 语言名称保留其母语，便于使用者切回中文；业务内容不能残留中文。
    const translated = root.cloneNode(true) as HTMLElement; translated.querySelector('[data-locale="zh"]')?.remove();
    assert.ok(!/[\u4e00-\u9fff]/.test(translated.innerHTML), JSON.stringify(translated.innerHTML.match(/.{0,25}[\u4e00-\u9fff].{0,25}/g)));
  } finally { panel.close(); }
});
