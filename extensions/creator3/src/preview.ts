import { PreviewDiagnostics, type PreviewDebugger } from './preview-diagnostics.js';
import { CocosError, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { randomBytes } from 'crypto';

export interface PreviewWindow {
  getContentSize?(): number[];
  setContentSize?(width: number, height: number): void;
  show?(): void;
  focus?(): void;
  isFocused?(): boolean;
  loadURL(url: string): Promise<unknown>;
  isDestroyed(): boolean;
  destroy(): void;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  webContents: {
    debugger?: PreviewDebugger;
    sendInputEvent?(event: JsonObject): void;
    isDestroyed(): boolean;
    executeJavaScript(source: string): Promise<unknown>;
    capturePage(): Promise<{ isEmpty(): boolean; toDataURL(): string; getSize(): { width: number; height: number } }>;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    setWindowOpenHandler(handler: () => { action: 'deny' }): void;
    session: { setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void): void };
  };
}

export interface PreviewWindowFactory { create(options: JsonObject): PreviewWindow; activate?(): void }

/** 窗口仅承载本工程的本地预览；关闭、重载扩展时不触碰用户浏览器或其他会话。 */
export class ManagedPreview {
  private window: PreviewWindow | undefined;
  private sceneId: string | undefined;
  private ready = false;
  private runtimeRegistered = false;
  private readonly diagnostics: JsonObject[] = [];
  private diagnosticLog: PreviewDiagnostics;
  constructor(private readonly factory: PreviewWindowFactory, private readonly projectPath?: string) { this.diagnosticLog = new PreviewDiagnostics(projectPath); }

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
    return { diagnosticSessionId: this.diagnosticLog.sessionId, running: Boolean(this.window && !this.window.isDestroyed()), pageReady: this.ready, sceneId: this.sceneId ?? null,
      viewport: this.window?.getContentSize ? this.window.getContentSize() : null, source: 'managed-preview-window', runtimeBridgeRegistration: this.runtimeRegistered ? 'succeeded' : 'not-requested', rows: this.diagnostics.slice(-50) };
  }

  async execute(method: string, params: JsonObject): Promise<JsonValue> {
    if (method === 'logs') return this.diagnosticLog.query(params);
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
      this.diagnosticLog.dispose(); this.diagnosticLog = new PreviewDiagnostics(this.projectPath);
      const diagnosticLog = this.diagnosticLog;
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
        diagnosticLog.record({ kind: 'console', level: level >= 3 ? 'error' : 'warning', message, line: Number(args[3]) || null, url: String(args[4] ?? '') });
        this.diagnostics.push({ level: level >= 3 ? 'error' : 'warning', message: String(message).slice(0, 2000) });
        if (this.diagnostics.length > 50) this.diagnostics.shift();
      });
      window.webContents.on('did-fail-load', (...args: unknown[]) => diagnosticLog.record({ kind: 'navigation-failure', message: String(args[2] ?? ''), url: String(args[3] ?? '') }));
      window.webContents.on('render-process-gone', () => diagnosticLog.record({ kind: 'renderer-crash', message: 'Preview renderer exited' }));
      // Electron 在首次导航前可能挂起 CDP 命令；先建立空白目标，再为下一次工程导航安装监听。
      try { await this.bounded(window.loadURL('about:blank'), 5000); }
      catch (error) { this.dispose(); throw new CocosError('EDITOR_ERROR', 'Preview page failed to load', { cause: String(error) }); }
      try { await this.bounded(diagnosticLog.attach(window.webContents.debugger), 8000); }
      catch (error) { diagnosticLog.record({ kind: 'capture-gap', message: CocosError.from(error).message }); diagnosticLog.dispose(); }
      window.once('closed', () => { if (this.window === window) { this.window = undefined; this.ready = false; this.sceneId = undefined; this.runtimeRegistered = false; } });
      try { await this.bounded(window.loadURL(url), 15000); if (window.isDestroyed()) throw new Error('Preview closed while loading'); this.ready = true; }
      catch (error) { this.dispose(); throw new CocosError('EDITOR_ERROR', 'Preview page failed to load', { cause: String(error) }); }
      return this.status();
    }
    if (method === 'resize' || method === 'input') {
      const window = this.window;
      if (!window || window.isDestroyed() || !this.ready || !window.getContentSize) throw new CocosError('CONTEXT_UNAVAILABLE', 'Managed preview window is unavailable');
      if (method === 'resize') {
        const width = Number(params.width), height = Number(params.height);
        if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048)) throw new CocosError('INVALID_ARGUMENT', 'Preview dimensions must be 256..2048');
        if (!window.setContentSize) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Preview resize API unavailable');
        const previousSize = window.getContentSize(); window.setContentSize(width, height);
        try {
          const frame = await this.execute('capture', {}), actual = window.getContentSize();
          if (actual[0] !== width || actual[1] !== height) throw new CocosError('VERIFICATION_FAILED', 'Window manager did not apply requested viewport');
          return { ...frame as JsonObject, viewport: { width: actual[0]!, height: actual[1]! }, previousSize, layoutVerified: false };
        } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Preview resize or capture incomplete; query current viewport before retrying', { previousSize, actualSize: window.getContentSize(), cause: CocosError.from(error).message }); }
      }
      const size = window.getContentSize(), x = Number(params.x), y = Number(params.y);
      if (![x, y].every(n => Number.isInteger(n) && n >= 0) || x >= size[0]! || y >= size[1]!) throw new CocosError('INVALID_ARGUMENT', 'Input coordinates must be inside the preview content area');
      if (!['click', 'wheel', 'drag', 'long_press', 'key', 'touch_drag', 'touch_cancel'].includes(String(params.action))) throw new CocosError('INVALID_ARGUMENT', 'Unsupported preview input action');
      const duration = Number(params.durationMs ?? 300), steps = Number(params.steps ?? 10), endX = Number(params.endX ?? x), endY = Number(params.endY ?? y);
      if (!Number.isInteger(duration) || duration < 0 || duration > 2000 || !Number.isInteger(steps) || steps < 1 || steps > 60 || ![endX, endY].every(n => Number.isInteger(n) && n >= 0) || endX >= size[0]! || endY >= size[1]!) throw new CocosError('INVALID_ARGUMENT', 'Invalid bounded gesture');
      if (params.action === 'key' && !/^(?:[A-Za-z0-9]|Space|Enter|Escape|Tab|Backspace|Left|Right|Up|Down)$/.test(String(params.key ?? ''))) throw new CocosError('INVALID_ARGUMENT', 'Unsupported key');
      if (String(params.action).startsWith('touch_') && !window.webContents.debugger?.isAttached()) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Touch input requires the managed preview debugger');
      if (params.action === 'wheel' && ![Number(params.deltaX ?? 0), Number(params.deltaY ?? 0)].every(n => Number.isInteger(n) && Math.abs(n) <= 2000)) throw new CocosError('INVALID_ARGUMENT', 'Wheel delta exceeds bounds');
      if (!window.webContents.sendInputEvent || !window.focus || !window.show || !window.isFocused) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Preview input APIs unavailable');
      // 先核对实际目标场景，再按 Electron 要求聚焦工具拥有的窗口；不向操作系统或其他窗口发输入。
      await this.execute('capture', {}); window.show(); window.focus();
      if (!window.isFocused()) { this.factory.activate?.(); window.focus(); }
      for (let attempt = 0; attempt < 10 && !window.isFocused(); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      if (!window.isFocused()) throw new CocosError('CONTEXT_UNAVAILABLE', 'Preview window did not acquire input focus');
      const sent: JsonObject[] = [];
      const send = (event: JsonObject): void => { window.webContents.sendInputEvent!(event); sent.push(event); };
      const wait = async (milliseconds: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, milliseconds)); if (this.window !== window || window.isDestroyed()) throw new CocosError('STALE_HANDLE', 'Preview changed during input'); };
      try {
        send({ type: 'mouseMove', x, y });
        if (String(params.action).startsWith('touch_')) {
          const touch = async (type: string, points: JsonObject[]): Promise<void> => { const event = { type, touchPoints: points }; sent.push(event); await window.webContents.debugger!.sendCommand('Input.dispatchTouchEvent', event); };
          try {
            await touch('touchStart', [{ x, y, id: 0 }]);
            for (let i = 1; i <= steps; i++) { await wait(duration / steps); await touch('touchMove', [{ x: x + (endX - x) * i / steps, y: y + (endY - y) * i / steps, id: 0 }]); }
          } finally { await touch(params.action === 'touch_cancel' ? 'touchCancel' : 'touchEnd', []); }
        } else if (params.action === 'key') {
          try { send({ type: 'keyDown', keyCode: params.key! }); await wait(duration); }
          finally { send({ type: 'keyUp', keyCode: params.key! }); }
        } else if (params.action === 'drag' || params.action === 'long_press') {
          try {
            send({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
            if (params.action === 'long_press') await wait(duration);
            else for (let i = 1; i <= steps; i++) { await wait(duration / steps); send({ type: 'mouseMove', x: Math.round(x + (endX - x) * i / steps), y: Math.round(y + (endY - y) * i / steps), button: 'left' }); }
          } finally { send({ type: 'mouseUp', x: params.action === 'drag' ? endX : x, y: params.action === 'drag' ? endY : y, button: 'left', clickCount: 1 }); }
        } else if (params.action === 'click') {
          try { send({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); }
          finally { send({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); }
        } else send({ type: 'mouseWheel', x, y, deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? 0, canScroll: true });
        return { ...await this.execute('capture', {}) as JsonObject, sent, businessOutcomeVerified: false, coordinateSpace: 'preview-content-dip-top-left' };
      } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Preview input may have executed; inspect game state before retrying', { sent, cause: CocosError.from(error).message }); }
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
    this.diagnosticLog.dispose();
    const window = this.window; this.window = undefined; this.sceneId = undefined; this.ready = false; this.runtimeRegistered = false;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
