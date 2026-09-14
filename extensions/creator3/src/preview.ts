import { CocosError, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { randomBytes } from 'crypto';

export interface PreviewWindow {
  loadURL(url: string): Promise<unknown>;
  isDestroyed(): boolean;
  destroy(): void;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  webContents: {
    isDestroyed(): boolean;
    executeJavaScript(source: string): Promise<unknown>;
    capturePage(): Promise<{ isEmpty(): boolean; toDataURL(): string; getSize(): { width: number; height: number } }>;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    setWindowOpenHandler(handler: () => { action: 'deny' }): void;
    session: { setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void): void };
  };
}

export interface PreviewWindowFactory { create(options: JsonObject): PreviewWindow }

/** 窗口仅承载本工程的本地预览；关闭、重载扩展时不触碰用户浏览器或其他会话。 */
export class ManagedPreview {
  private window: PreviewWindow | undefined;
  private sceneId: string | undefined;
  private ready = false;
  private runtimeRegistered = false;
  private readonly diagnostics: JsonObject[] = [];
  constructor(private readonly factory: PreviewWindowFactory) {}

  private async bounded<T>(task: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([task, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new CocosError('TIMEOUT', 'Preview operation timed out')), milliseconds); })]); }
    finally { if (timer) clearTimeout(timer); }
  }

  private previewUrl(raw: string, sceneId: string): string {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new CocosError('UNAUTHORIZED', 'Preview must use an unauthenticated loopback HTTP URL');
    }
    // 显式传递目标场景，截图时再次核对实际场景；不修改全工程启动场景配置。
    url.searchParams.set('scene', sceneId);
    return url.href;
  }

  private status(): JsonObject {
    return { running: Boolean(this.window && !this.window.isDestroyed()), pageReady: this.ready, sceneId: this.sceneId ?? null,
      source: 'managed-preview-window', runtimeBridgeRegistration: this.runtimeRegistered ? 'succeeded' : 'not-requested', rows: this.diagnostics.slice(-50) };
  }

  async execute(method: string, params: JsonObject): Promise<JsonValue> {
    if (method === 'status') return this.status();
    if (method === 'connect-runtime') {
      const window = this.window;
      if (!window || window.isDestroyed() || !this.ready) throw new CocosError('CONTEXT_UNAVAILABLE', 'Start an MCP preview before connecting its runtime');
      await this.bounded(window.webContents.executeJavaScript(String(params.source)), 5000);
      // 凭证来自本工程受控配置，只进入同源开发预览；返回值和错误信息不包含凭证。
      const result = await this.bounded(window.webContents.executeJavaScript(`(async () => {
        const cc = await System.import('cc');
        // 页面 load 完成时引擎仍可能在加载场景；不能把注册网关当作场景可操作。
        for (let attempt=0; !cc.director.getScene() && attempt<60; attempt++) await new Promise(resolve => setTimeout(resolve,100));
        if (!cc.director.getScene() || cc.director.getScene().uuid !== ${JSON.stringify(this.sceneId)}) throw new Error('Target preview scene has not launched');
        if (globalThis.__cocosMcpDevelopmentConnection) await globalThis.__cocosMcpDevelopmentConnection.stop().catch(() => {});
        globalThis.__cocosMcpDevelopmentConnection = await CocosMCPRuntime.CocosMCP.connect({
          ...${JSON.stringify(params.config)}, cc, major: 3, development: true
        });
        return {connected:true, sceneId:cc.director.getScene()?.uuid ?? null};
      })()`), 10000);
      this.runtimeRegistered = Boolean(result && typeof result === 'object' && (result as { connected?: boolean }).connected === true);
      return result as JsonValue;
    }
    if (method === 'stop') { this.dispose(); return { stopped: true, scope: 'mcp-owned-preview-window' }; }
    if (method === 'start') {
      const sceneId = String(params.sceneId ?? '');
      if (!sceneId) throw new CocosError('INVALID_ARGUMENT', 'Preview requires a saved scene UUID');
      if (this.window && !this.window.isDestroyed()) {
        if (this.sceneId !== sceneId) throw new CocosError('RESOURCE_BUSY', 'Stop the existing MCP preview before changing its scene');
        return this.status();
      }
      const width = Number(params.width ?? 1280), height = Number(params.height ?? 800);
      if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048)) throw new CocosError('INVALID_ARGUMENT', 'Preview dimensions must be 256..2048');
      const url = this.previewUrl(String(params.url), sceneId), origin = new URL(url).origin;
      const window = this.factory.create({ width, height, useContentSize: true, show: params.visible !== false, title: 'CocosMCP Preview',
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
          partition: `cocos-mcp-preview-${randomBytes(8).toString('hex')}` } });
      this.window = window; this.sceneId = sceneId; this.ready = false; this.diagnostics.length = 0;
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      const navigation = (...args: unknown[]): void => {
        const event = args[0] as { preventDefault(): void }, target = String(args[1]);
        try { if (new URL(target).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); }
      };
      window.webContents.on('will-navigate', navigation);
      window.webContents.on('will-redirect', navigation);
      window.webContents.on('console-message', (...args: unknown[]) => {
        const level = Number(args[1]), message = String(args[2]);
        if (level < 2) return;
        this.diagnostics.push({ level: level >= 3 ? 'error' : 'warning', message: String(message).slice(0, 2000) });
        if (this.diagnostics.length > 50) this.diagnostics.shift();
      });
      window.once('closed', () => { if (this.window === window) { this.window = undefined; this.ready = false; this.sceneId = undefined; this.runtimeRegistered = false; } });
      try { await this.bounded(window.loadURL(url), 15000); if (window.isDestroyed()) throw new Error('Preview closed while loading'); this.ready = true; }
      catch (error) { this.dispose(); throw new CocosError('EDITOR_ERROR', 'Preview page failed to load', { cause: String(error) }); }
      return this.status();
    }
    if (method === 'capture') {
      const window = this.window;
      if (!window || window.isDestroyed() || !this.ready) throw new CocosError('CONTEXT_UNAVAILABLE', 'Start an MCP preview before capturing it');
      // 等待引擎实际完成一帧，而不是把页面加载或 Canvas 存在误当作场景已经渲染。
      const frame = await this.bounded(window.webContents.executeJavaScript(`(async () => {
        if (!globalThis.System) return {ready:false, reason:'engine-loader-unavailable'};
        const cc = await System.import('cc');
        if (!cc.director.getScene()) return {ready:false, reason:'scene-not-launched'};
        return new Promise(resolve => {
          const timer=setTimeout(() => {cc.director.off(cc.Director.EVENT_AFTER_DRAW, done);resolve({ready:false, reason:'frame-timeout'});},5000);
          function done(){clearTimeout(timer);resolve({ready:true, sceneId:cc.director.getScene().uuid});}
          cc.director.once(cc.Director.EVENT_AFTER_DRAW,done);
        });
      })()`), 8000);
      if (!frame || typeof frame !== 'object' || (frame as { ready?: boolean }).ready !== true) throw new CocosError('CONTEXT_UNAVAILABLE', 'Preview has not rendered a game frame', frame as JsonValue);
      if ((frame as { sceneId?: string }).sceneId !== this.sceneId) throw new CocosError('VERIFICATION_FAILED', 'Preview launched a different scene', frame as JsonValue);
      const image = await window.webContents.capturePage();
      if (image.isEmpty()) throw new CocosError('VERIFICATION_FAILED', 'Preview capture returned an empty image');
      return { dataUrl: image.toDataURL(), ...image.getSize(), sceneId: this.sceneId!, source: 'managed-preview-window',
        verification: 'rendered-frame-captured', rows: this.diagnostics.slice(-50) };
    }
    throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown managed preview operation: ${method}`);
  }

  dispose(): void {
    const window = this.window; this.window = undefined; this.sceneId = undefined; this.ready = false; this.runtimeRegistered = false;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
