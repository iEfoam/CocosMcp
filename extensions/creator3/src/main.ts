import { PanelPreferences, type PanelMenuHost } from '../../shared/panel-preferences.js';
import { ExtensionUpdate } from '../../shared/extension-update.js';
import { McpService } from '../../shared/mcp-service.js';
import { CreatorShaderHost } from './shader-host.js';
import { createHash } from 'crypto';
import { CocosError, Json } from '../../../packages/contracts/src/index.js';
import { ManagedPreview, type PreviewWindow } from './preview.js';
import { CreatorConsole, type CreatorLogger } from './console.js';
import { CreatorSelection } from './selection.js';
import { dirname } from 'path';
import { readFileSync, readdirSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { Creator3Adapter, type EditorPort } from '../../../packages/creator3-adapter/src/index.js';
import { EditorBridge } from '../../../packages/editor-bridge/src/index.js';
import type { JsonValue } from '../../../packages/contracts/src/index.js';
import type { PanelState } from '../../../packages/editor-bridge/src/panel-state.js';

interface CreatorEditor extends PanelMenuHost {
  App: { path: string; version: string };
  Project: { path: string };
  Message: { request(channel: string, message: string, ...args: unknown[]): Promise<unknown> };
  Selection: { getSelected(type: string): string[]; clear(type: string): void; select(type: string, ids: string[]): void };
  Profile: { getProject(name: string, key?: string): Promise<unknown>; setProject(name: string, key: string, value: JsonValue): Promise<void> };
  Panel: { open(name: string): Promise<unknown> };
  Logger?: CreatorLogger;
}
declare const Editor: CreatorEditor;

class CreatorHost implements EditorPort {
  private consoleReader: CreatorConsole | undefined;
  get consoleAvailable(): boolean { return Editor.App.version === '3.8.8' && typeof Editor.Logger?.query === 'function'; }
  consoleQuery(params: import('../../../packages/contracts/src/index.js').JsonObject): Promise<JsonValue> {
    if (!this.consoleAvailable) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Creator console reading requires the verified 3.8.8 Logger API');
    this.consoleReader ??= new CreatorConsole(Editor.Logger!);
    return this.consoleReader.query(params);
  }
  private managedPreview: ManagedPreview | undefined;
  preview(method: string, params: import('../../../packages/contracts/src/index.js').JsonObject): Promise<JsonValue> {
    this.managedPreview ??= new ManagedPreview({ activate: () => {
      // macOS 前台焦点切换是异步的；仅在用户请求自有预览输入时激活应用。
      (require('electron') as { app: { focus(options: { steal: boolean }): void } }).app.focus({ steal: true });
    }, create: options => {
      const electron = require('electron') as { BrowserWindow: new (options: unknown) => PreviewWindow };
      return new electron.BrowserWindow(options);
    } }, Editor.Project.path);
    if (method === 'connect-runtime') {
      const root = join(Editor.Project.path, '.codex-work/cache/cocos-mcp');
      const projectId = createHash('sha256').update(realpathSync(Editor.Project.path)).digest('hex').slice(0, 24);
      const gateways = readdirSync(root).filter(name => /^runtime-\d+\.json$/.test(name)).flatMap(name => {
        try {
          process.kill(Number(name.slice(8, -5)), 0);
          const config = Json.object(JSON.parse(readFileSync(join(root, name), 'utf8')));
          if (config.projectId !== projectId || !/^http:\/\/127\.0\.0\.1:\d+$/.test(String(config.url)) || typeof config.token !== 'string') return [];
          if (params.gatewayPort && new URL(String(config.url)).port !== String(params.gatewayPort)) return [];
          return [config];
        } catch { return []; }
      });
      if (gateways.length !== 1) throw new CocosError('CONTEXT_UNAVAILABLE', 'Start one project runtime gateway, or select gatewayPort explicitly');
      return this.managedPreview.execute(method, { config: gateways[0]!, source: readFileSync(join(__dirname, 'runtime.js'), 'utf8') });
    }
    return this.managedPreview.execute(method, params);
  }
  disposePreview(): void { this.managedPreview?.dispose(); }
  private shaderHost: CreatorShaderHost | undefined;
  shader(method: string, params: import('../../../packages/contracts/src/index.js').JsonObject): Promise<JsonValue> {
    if (method === 'compile') return this.scene('shader.compileNative', { ...params, projectPath: Editor.Project.path, editorVersion: Editor.App.version }) as Promise<JsonValue>;
    this.shaderHost ??= new CreatorShaderHost(Editor.App.path, Editor.Project.path, Editor.App.version);
    return this.shaderHost.execute(method, params);
  }
  readonly extensionName = 'cocos-mcp-creator3';
  get version(): string { return Editor.App.version; }
  get projectPath(): string { return Editor.Project.path; }
  request(channel: string, message: string, ...args: unknown[]): Promise<unknown> { return Editor.Message.request(channel, message, ...args); }
  scene(method: string, ...args: unknown[]): Promise<unknown> { return this.request('scene', 'execute-scene-script', { name: this.extensionName, method: 'dispatch', args: [method, args] }); }
  selection(type: string, ids?: string[]): string[] { return new CreatorSelection(Editor.Selection).update(type, ids); }
  getSetting(name: string, key?: string): Promise<unknown> { return Editor.Profile.getProject(name, key); }
  setSetting(name: string, key: string, value: JsonValue): Promise<void> { return Editor.Profile.setProject(name, key, value); }
  messages(packageName?: string): Array<{ package: string; message: string; public: boolean }> {
    const rows: Array<{ package: string; message: string; public: boolean }> = [];
    for (const root of [join(Editor.App.path, 'builtin'), join(Editor.Project.path, 'extensions')]) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root)) {
        const path = join(root, entry, 'package.json');
        if (!existsSync(path)) continue;
        try {
          const manifest = JSON.parse(readFileSync(path, 'utf8')) as { name?: string; contributions?: { messages?: Record<string, { public?: boolean }> } };
          if (!manifest.name || (packageName && packageName !== manifest.name)) continue;
          for (const [message, config] of Object.entries(manifest.contributions?.messages ?? {})) rows.push({ package: manifest.name, message, public: config.public === true });
        } catch (error) { console.warn('[CocosMCP] Cannot inspect extension manifest', path, error); }
      }
    }
    return rows;
  }
}

class ExtensionLifecycle {
  private navigation: NonNullable<PanelState['navigation']> = { page: 'overview', revision: 0 };
  openPage(page: 'overview' | 'about' | 'updates'): void {
    this.navigation = { page, revision: this.navigation.revision + 1 };
    if (page === 'updates') this.checkExtension();
    void Editor.Panel.open('cocos-mcp-creator3');
  }
  checkExtension(): void { this.getUpdater().check(true); }
  private updater: ExtensionUpdate | undefined;
  private getUpdater(): ExtensionUpdate { return this.updater ??= new ExtensionUpdate(Editor.Project.path, dirname(__dirname), 3); }
  async updateExtension(): Promise<void> { await this.getUpdater().update(); }
  private service: McpService | undefined;
  private getService(): McpService { return this.service ??= new McpService(Editor.Project.path, dirname(__dirname)); }
  async startService(): Promise<void> { await this.start(); await this.getService().start(); }
  async stopService(): Promise<void> { await this.service?.stop(); }
  async unload(): Promise<void> { try { await this.stopService(); await this.stop(); } finally { preferences.restoreMenu(); } }
  private bridge: EditorBridge | undefined;
  private starting: Promise<void> | undefined;
  private getBridge(): EditorBridge {
    if (!this.bridge) { const host = new CreatorHost(); this.bridge = new EditorBridge(new Creator3Adapter(host), host.projectPath, host.version); }
    return this.bridge;
  }
  async panelState(): Promise<PanelState> { const state = await this.getBridge().panelStateWithRuntime(); state.service = this.getService().snapshot(); state.navigation = this.navigation; state.extension = this.getUpdater().snapshot(); state.locale = preferences.read(); preferences.applyMenu(); return state; }
  async start(): Promise<void> {
    this.getUpdater();
    if (this.starting) return this.starting;
    this.starting = this.initialize().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async initialize(): Promise<void> {
    const descriptor = await this.getBridge().start();
    console.info(`[CocosMCP] Bridge ready: ${descriptor.instanceId}; project ${descriptor.projectId}`);
  }
  async stop(): Promise<void> { await this.starting; await this.bridge?.stop(); this.bridge = undefined; }
  async status(): Promise<void> { await this.start(); console.info('[CocosMCP] Connect the MCP server with --project', Editor.Project.path); }
}

const preferences = new PanelPreferences(() => Editor.Project.path, 3, Editor);
const lifecycle = new ExtensionLifecycle();
export const methods = {
  setLanguage: (locale: unknown): string => preferences.set(locale),
  copyLog: (text: unknown): void => preferences.copy(text),
  updateExtension: (): Promise<void> => lifecycle.updateExtension(),
  startService: (): Promise<void> => lifecycle.startService(),
  stopService: (): Promise<void> => lifecycle.stopService(),
  start: (): Promise<void> => lifecycle.start(),
  stop: (): Promise<void> => lifecycle.stop(),
  status: (): Promise<void> => lifecycle.status(),
  panelState: (): Promise<PanelState> => lifecycle.panelState(),
  // default 面板的 ID 为扩展包名，与模板中的 HTML 根元素 ID 无关。
  open: (): void => lifecycle.openPage('overview'),
  about: (): void => lifecycle.openPage('about'),
  checkUpdates: (): void => lifecycle.openPage('updates'),
  checkExtension: (): void => lifecycle.checkExtension(),
};
export const load = async (): Promise<void> => { await lifecycle.start(); preferences.applyMenu(); };
export const unload = (): Promise<void> => lifecycle.unload();
