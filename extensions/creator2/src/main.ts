import { PanelPreferences, type PanelMenuHost } from '../../shared/panel-preferences.js';
import { ExtensionUpdate } from '../../shared/extension-update.js';
import { McpService } from '../../shared/mcp-service.js';
import { dirname } from 'path';
import { Creator2Adapter, type Creator2Port } from '../../../packages/creator2-adapter/src/index.js';
import { EditorBridge } from '../../../packages/editor-bridge/src/index.js';
import { CocosError } from '../../../packages/contracts/src/index.js';
import type { PanelState } from '../../../packages/editor-bridge/src/panel-state.js';

interface ReplyEvent { reply?(error: { message: string } | null, result?: unknown): void }

interface CreatorEditor extends PanelMenuHost {
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
  get version(): string { return Editor.versions?.creator ?? Editor.App?.version ?? '2.unknown'; }
  get projectPath(): string { return Editor.Project.path; }
  scene(method: string, ...args: unknown[]): Promise<unknown> {
    return new Promise((accept, reject) => Editor.Scene.callSceneScript('cocos-mcp-creator2', 'dispatch', { method, args }, (error, result) => error ? reject(error) : accept(result)));
  }
  async asset(method: string, ...args: unknown[]): Promise<unknown> {
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
  async panelState(): Promise<PanelState> { const state = await this.getBridge().panelStateWithRuntime(); state.service = this.getService().snapshot(); this.getUpdater().check(); state.extension = this.getUpdater().snapshot(); state.locale = preferences.read(); preferences.applyMenu(); return state; }
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
    'panel-state'(event?: ReplyEvent): void { lifecycle.reply(event, () => lifecycle.panelState()); },
    open(): void { Editor.Panel.open('cocos-mcp-creator2'); },
  },
};
