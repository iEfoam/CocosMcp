import { PanelPreferences, type PanelMenuHost } from '../../shared/panel-preferences.js';
import { ExtensionUpdate } from '../../shared/extension-update.js';
import { McpService } from '../../shared/mcp-service.js';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import { readFileSync, readdirSync, realpathSync } from 'fs';
import { ManagedPreview, type PreviewWindow } from '../../creator3/src/preview.js';
import { Creator2Adapter, type Creator2Port } from '../../../packages/creator2-adapter/src/index.js';
import { EditorBridge } from '../../../packages/editor-bridge/src/index.js';
import { CocosError, Json, type JsonValue, type JsonObject } from '../../../packages/contracts/src/index.js';
import type { PanelState } from '../../../packages/editor-bridge/src/panel-state.js';

interface ReplyEvent { reply?(error: { message: string } | null, result?: unknown): void }

interface CreatorEditor extends PanelMenuHost {
  PreviewServer?: { _previewPort?: number; _validateStashedScene?(callback: () => void): void };
  stashedScene?: unknown;
  currentSceneUuid?: string;
  Profile: { load(url: string): { get(key: string): unknown; set(key: string, value: unknown): void; save(): void } };
  versions?: { creator?: string };
  App?: { version?: string };
  Project: { path: string };
  Scene: { callSceneScript(extension: string, method: string, params: unknown, callback: (error: unknown, result: unknown) => void): void };
  assetdb: Record<string, unknown>;
  Selection: { curSelection(type: string): string[]; clear(type: string): void; select(type: string, ids: string[]): void };
  Ipc: { sendToPanel(panel: string, message: string, ...args: unknown[]): void; sendToMain?(message: string, ...args: unknown[]): void };
  Panel: { open(name: string): void };
}
declare const Editor: CreatorEditor;

class CreatorHost implements Creator2Port {
  environment(): JsonObject { return { main: Object.keys(Editor).sort(), previewServer: Object.keys(Editor.PreviewServer ?? {}).sort() }; }
  async setting(method: string, params: JsonObject): Promise<JsonValue> {
    const name = Json.string(params.name, 'name');
    if (!['project', 'builder'].includes(name)) throw new CocosError('UNAUTHORIZED', 'Only project and builder profiles are exposed');
    const profile = Editor.Profile.load(`project://${name}.json`);
    if (!params.key) { try { return { settings: JSON.parse(readFileSync(join(Editor.Project.path, 'settings', `${name}.json`), 'utf8')), scope: 'stored-project-overrides' }; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { settings: {}, scope: 'stored-project-overrides' }; throw error; } }
    const key = Json.string(params.key, 'key'); Json.safePath(key);
    if (method === 'set') { profile.set(key, params.value); profile.save(); }
    return { name, key, value: Json.value(profile.get(key) ?? null), runtimeApplied: false };
  }
  async previewUrl(): Promise<string> {
    if (this.version !== '2.4.15') throw new CocosError('UNSUPPORTED_VERSION', 'Preview server adapter requires Creator 2.4.15');
    const configured = Editor.Profile.load('project://project.json').get('start-scene');
    if (configured && configured !== 'current' && configured !== Editor.currentSceneUuid) throw new CocosError('RESOURCE_BUSY', 'Preview start scene differs from current scene; select current scene in Creator project settings');
    const port = Editor.PreviewServer?._previewPort;
    if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new CocosError('CONTEXT_UNAVAILABLE', 'Creator preview server is unavailable');
    if (!Editor.PreviewServer?._validateStashedScene) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Native preview scene stashing unavailable');
    // 2.x 会复用上一次预览快照，同一场景 UUID 也可能包含旧节点；启动自有窗口前强制刷新快照。
    Editor.stashedScene = null;
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(new CocosError('TIMEOUT', 'Creator did not refresh preview scene snapshot')), 10000);
      Editor.PreviewServer!._validateStashedScene!(() => { clearTimeout(timer); accept(); });
    });
    return `http://127.0.0.1:${port}/`;
  }
  get version(): string { return Editor.versions?.creator ?? Editor.App?.version ?? '2.unknown'; }
  private managedPreview: ManagedPreview | undefined;
  preview(method: string, params: import('../../../packages/contracts/src/index.js').JsonObject): Promise<JsonValue> {
    this.managedPreview ??= new ManagedPreview({ activate: () => {
      // macOS 前台焦点切换是异步的；仅在用户请求自有预览输入时激活应用。
      (require('electron') as { app: { focus(options: { steal: boolean }): void } }).app.focus({ steal: true });
    }, create: options => {
      const electron = require('electron') as { BrowserWindow: new (options: unknown) => PreviewWindow };
      return new electron.BrowserWindow(options);
    } }, Editor.Project.path, 2);
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
  get projectPath(): string { return Editor.Project.path; }
  scene(method: string, ...args: unknown[]): Promise<unknown> {
    return new Promise((accept, reject) => Editor.Scene.callSceneScript('cocos-mcp-creator2', 'dispatch', { method, args }, (error, result) => error ? reject(error) : accept(result)));
  }
  sceneScript(extension: string, method: string, params: JsonObject): Promise<unknown> {
    return new Promise((accept, reject) => Editor.Scene.callSceneScript(extension, method, params, (error, result) => error ? reject(error) : accept(result)));
  }
  async asset(method: string, ...args: unknown[]): Promise<unknown> {
    // loadMeta 返回带 AssetDB 循环引用的 Meta 实例；协议只传导入器持久化的 JSON。
    if (method === 'loadMeta') {
      const info = Reflect.apply(Editor.assetdb.assetInfo as Function, Editor.assetdb, [args[0]]) as { path?: string } | null;
      if (!info) throw new CocosError('NOT_FOUND', 'Asset metadata is unavailable');
      const path = Reflect.apply(Editor.assetdb.urlToFspath as Function, Editor.assetdb, [args[0]]) as string;
      return JSON.parse(readFileSync(`${path}.meta`, 'utf8'));
    }
    const fn = Editor.assetdb[method];
    if (typeof fn !== 'function') throw new CocosError('UNSUPPORTED_CAPABILITY', `AssetDB.${method} is unavailable`);
    const sync = new Set(['assetInfo', 'assetInfoByUuid', 'loadMeta', 'urlToUuid', 'uuidToUrl', 'uuidToFspath']);
    if (sync.has(method)) return Reflect.apply(fn, Editor.assetdb, args);
    return new Promise((accept, reject) => Reflect.apply(fn, Editor.assetdb, [...args, (error: unknown, result: unknown) => error ? reject(error) : accept(result)]));
  }
  selection(type: string, ids?: string[]): string[] { if (ids) { Editor.Selection.clear(type); Editor.Selection.select(type, ids); } return Editor.Selection.curSelection(type); }
  async ipc(panel: string, message: string, ...args: unknown[]): Promise<unknown> { Editor.Ipc.sendToPanel(panel, message, ...args); return null; }
}

class ExtensionLifecycle {
  private navigation: NonNullable<PanelState['navigation']> = { page: 'overview', revision: 0 };
  openPage(page: 'overview' | 'about' | 'updates'): void {
    this.navigation = { page, revision: this.navigation.revision + 1 };
    if (page === 'updates') this.checkExtension();
    void Editor.Panel.open('cocos-mcp-creator2');
  }
  checkExtension(): void { this.getUpdater().check(true); }
  private updater: ExtensionUpdate | undefined;
  private getUpdater(): ExtensionUpdate { return this.updater ??= new ExtensionUpdate(Editor.Project.path, dirname(__dirname), 2); }
  async updateExtension(): Promise<void> { await this.getUpdater().update(); }
  private service: McpService | undefined;
  private getService(): McpService { return this.service ??= new McpService(Editor.Project.path, dirname(__dirname)); }
  async startService(): Promise<void> { await this.start(); await this.getService().start(); }
  async stopService(): Promise<void> { await this.service?.stop(); }
  async unload(): Promise<void> { try { await this.stopService(); await this.stop(); } finally { preferences.restoreMenu(); } }
  private bridge: EditorBridge | undefined;
  private starting: Promise<void> | undefined;
  private getBridge(): EditorBridge {
    if (!this.bridge) { const host = new CreatorHost(); this.bridge = new EditorBridge(new Creator2Adapter(host), host.projectPath, host.version); }
    return this.bridge;
  }
  async panelState(cursor?: string): Promise<PanelState> { const state = await this.getBridge().panelStateWithRuntime(cursor); state.service = this.getService().snapshot(); state.navigation = this.navigation; state.extension = this.getUpdater().snapshot(); state.locale = preferences.read(); preferences.applyMenu(); return state; }
  async start(): Promise<void> {
    this.getUpdater();
    // 菜单与面板可同时请求启动，必须复用同一次初始化以免留下重复监听器。
    if (!this.starting) this.starting = this.initialize().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async initialize(): Promise<void> {
    const descriptor = await this.getBridge().start(); console.info('[CocosMCP] Bridge ready', descriptor.instanceId);
  }
  async stop(): Promise<void> { await this.starting; await this.bridge?.stop(); this.bridge = undefined; }
  reply(event: ReplyEvent | undefined, operation: () => unknown | Promise<unknown>): void {
    void Promise.resolve().then(operation).then(result => event?.reply?.(null, result)).catch(error => {
      console.error('[CocosMCP]', error);
      event?.reply?.({ message: CocosError.from(error).message });
    });
  }
}
const preferences = new PanelPreferences(() => Editor.Project.path, 2, Editor);
const lifecycle = new ExtensionLifecycle();
export = {
  load(): void { void lifecycle.start().then(() => preferences.applyMenu()).catch(error => console.error('[CocosMCP]', error)); },
  unload(): void { void lifecycle.unload().catch(error => console.error('[CocosMCP]', error)); },
  messages: {
    'set-language'(event: ReplyEvent, locale: unknown): void { lifecycle.reply(event, () => preferences.set(locale)); },
    'copy-log'(event: ReplyEvent, text: unknown): void { lifecycle.reply(event, () => preferences.copy(text)); },
    'extension-update'(event?: ReplyEvent): void { lifecycle.reply(event, () => lifecycle.updateExtension()); },
    'service-start'(event?: ReplyEvent): void { lifecycle.reply(event, () => lifecycle.startService()); },
    'service-stop'(event?: ReplyEvent): void { lifecycle.reply(event, () => lifecycle.stopService()); },
    start(event?: ReplyEvent): void { lifecycle.reply(event, () => lifecycle.start()); },
    stop(event?: ReplyEvent): void { lifecycle.reply(event, () => lifecycle.stop()); },
    'panel-state'(event?: ReplyEvent, cursor?: string): void { lifecycle.reply(event, () => lifecycle.panelState(cursor)); },
    open(): void { lifecycle.openPage('overview'); },
    about(): void { lifecycle.openPage('about'); },
    'check-updates'(): void { lifecycle.openPage('updates'); },
    'extension-check'(event?: ReplyEvent): void { lifecycle.reply(event, () => lifecycle.checkExtension()); },
  },
};
