import { ExternalPreview, ProjectBrowserConnector, type ExternalBrowserPort } from '../../shared/external-preview.js';
import { PreviewRefresh, type PreviewRefreshHost } from '../../shared/preview-refresh.js';
import { PreviewRedaction } from '../../shared/preview-redaction.js';
import { PreviewDiagnosis } from '../../shared/preview-diagnose.js';
import { PreviewDiagnostics, type PreviewDebugger } from './preview-diagnostics.js';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { randomBytes } from 'crypto';
import { PreviewObserver } from './preview-observer.js';
import { CaptureEvidence, type PreviewImage } from './capture-evidence.js';
import { PreviewCoordinates } from './preview-coordinates.js';
import { readFile } from 'node:fs/promises';
import { ProjectPaths } from '../../../packages/application/src/paths.js';

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
    capturePage(): Promise<PreviewImage>;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    setWindowOpenHandler?(handler: () => { action: 'deny' }): void;
    session: { setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void): void;
      webRequest?: { onBeforeRequest(filter: { urls: string[] }, handler: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void): void } };
  };
}

export interface PreviewWindowFactory { create(options: JsonObject): PreviewWindow; activate?(): void }

/** 窗口仅承载本工程的本地预览；关闭、重载扩展时不触碰用户浏览器或其他会话。 */
export class ManagedPreview {
  private window: PreviewWindow | undefined;
  private sceneId: string | undefined;
  private currentSceneId: string | null = null;
  private sceneGeneration = 0;
  private observedGeneration: number | null = null;
  private observation: JsonObject = {};
  private lastCapture: JsonObject | undefined;
  private ready = false;
  private gameReady = false;
  private runtimeRegistered = false;
  private readonly diagnostics: JsonObject[] = [];
  private diagnosticLog: PreviewDiagnostics;
  private target: 'embedded' | 'external-browser' = 'embedded';
  private previewAddress: string | null = null;
  private fixtureNetwork: { fixtureId: string; expiresAt: number; origins: Set<string> } | undefined;
  private readonly external: ExternalPreview;
  private readonly refresh: PreviewRefresh | undefined;
  private readonly redact = new PreviewRedaction();
  constructor(private readonly factory: PreviewWindowFactory, private readonly projectPath?: string, private readonly major: 2 | 3 = 3, refreshHost?: PreviewRefreshHost, externalBrowser?: ExternalBrowserPort, private readonly sceneSnapshot?: () => Promise<{ sceneId: string; data: string }>) {
    this.diagnosticLog = new PreviewDiagnostics(projectPath);
    this.external = new ExternalPreview(externalBrowser ?? (projectPath ? new ProjectBrowserConnector(projectPath) : undefined), major);
    this.refresh = refreshHost ? new PreviewRefresh({ ...refreshHost, reload: manifest => this.reload(manifest) }) : undefined;
  }

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
    // 3.8.8 原生预览支持此开关；工具刷新必须绑定一次导航，不能被保存时的热重载打断。
    if (this.major === 3) url.searchParams.set('autoReload', 'false');
    return url.href;
  }

  private status(): JsonObject {
    const running = Boolean(this.window && !this.window.isDestroyed() && !this.window.webContents.isDestroyed());
    return { target: 'embedded', url: this.previewAddress, previewSessionId: this.diagnosticLog.sessionId,
      gameReady: running && this.gameReady, status: running && this.gameReady ? 'game-ready' : running && this.ready ? 'page-opened' : 'stopped', diagnosticSessionId: this.diagnosticLog.sessionId, running, pageReady: running && this.ready,
      sceneId: this.currentSceneId, launchSceneId: this.sceneId ?? null, currentSceneId: this.currentSceneId, sceneGeneration: this.sceneGeneration,
      viewport: this.window?.getContentSize ? this.window.getContentSize() : null, source: 'managed-preview-window', runtimeBridgeRegistration: this.runtimeRegistered ? 'succeeded' : 'not-requested',
      readiness: { page: running && this.ready ? 'passed' : 'unknown', engine: running && this.ready && this.observation.ready === true ? 'passed' : 'unknown',
        launchScene: running && this.ready && this.currentSceneId === this.sceneId ? 'passed' : 'unknown', frame: running && this.ready && Number(this.observation.sceneFrameIndex) > 0 ? 'passed' : 'unknown', runtime: running && this.runtimeRegistered ? 'passed' : 'unknown', business: 'unknown' },
      runtimeInstanceId: this.observation.runtimeInstanceId ?? null, frameIndex: this.observation.frameIndex ?? null,
      fixture: this.fixtureNetwork ? { fixtureId: this.fixtureNetwork.fixtureId, defaultNetwork: 'deny', allowedOrigins: [...this.fixtureNetwork.origins], expiresAt: new Date(this.fixtureNetwork.expiresAt).toISOString(), enforced: true } : null,
      observation: this.observation, rows: this.diagnostics.slice(-50) };
  }

  private invalidateObservation(): void {
    this.currentSceneId = null; this.observedGeneration = null; this.observation = {}; this.lastCapture = undefined;
    this.gameReady = false; this.runtimeRegistered = false;
  }

  private observe(frame: JsonObject, params: JsonObject = {}): JsonObject {
    const id = typeof frame.sceneId === 'string' ? frame.sceneId : null;
    const generation = typeof frame.sceneGeneration === 'number' ? frame.sceneGeneration : null;
    if (id !== this.currentSceneId || generation !== this.observedGeneration) this.sceneGeneration++;
    this.currentSceneId = id; this.observedGeneration = generation; this.observation = frame;
    if (params.expectedRuntimeInstanceId !== undefined && params.expectedRuntimeInstanceId !== frame.runtimeInstanceId) throw new CocosError('STALE_HANDLE', 'Preview runtime identity differs from selected runtime', { inputSent: false, actualRuntimeInstanceId: frame.runtimeInstanceId ?? null });
    if (params.expectedSceneId !== undefined && params.expectedSceneId !== id) throw new CocosError('VERIFICATION_FAILED', 'Preview current scene differs from expected scene', { expectedSceneId: params.expectedSceneId, actualSceneId: id });
    if (params.expectedGeneration !== undefined && params.expectedGeneration !== this.sceneGeneration) throw new CocosError('STALE_HANDLE', 'Preview scene generation changed', { actualGeneration: this.sceneGeneration });
    return { ...frame, sceneGeneration: this.sceneGeneration, launchSceneId: this.sceneId ?? null, currentSceneId: id, previewSessionId: this.diagnosticLog.sessionId };
  }

  private async inspect(window: PreviewWindow, params: JsonObject = {}): Promise<JsonObject> {
    const observed = await this.bounded(window.webContents.executeJavaScript(`(async()=>{${this.engineReadySource()}${new PreviewObserver().source()}return read();})()`), 12000);
    if (this.window !== window || window.isDestroyed()) throw new CocosError('STALE_HANDLE', 'Managed preview session changed');
    return this.observe(Json.object(observed), params);
  }

  private async reload(manifest: JsonObject): Promise<JsonObject> {
    const binding = Json.object(manifest.binding);
    const current = Json.object(await this.execute('status', { target: binding.target! }));
    if ((current.previewSessionId ?? current.sessionId) !== binding.previewSessionId || current.url !== binding.url || this.target !== binding.target) throw new CocosError('STALE_HANDLE', 'Refresh preview target or session changed');
    if (binding.target === 'external-browser') return Json.object(await this.external.execute('reload', manifest));
    const window = this.window;
    if (!window || window.isDestroyed() || !this.previewAddress) throw new CocosError('CONTEXT_UNAVAILABLE', 'Embedded preview unavailable');
    const revision = await this.bounded(this.diagnosticLog.beginRevision(manifest.artifacts as JsonObject[], new URL(this.previewAddress).origin), 5000);
    try {
      await this.prepareScene();
      this.ready = false; this.invalidateObservation();
      await this.bounded(window.loadURL(this.previewAddress), 15000); this.ready = true;
      await this.execute('capture', {});
      return { ...await this.diagnosticLog.revision(revision), url: this.previewAddress, gameReady: this.gameReady };
    } finally { this.diagnosticLog.endRevision(); }
  }
  private async prepareScene(): Promise<void> {
    if (!this.sceneSnapshot) return;
    const snapshot = await this.bounded(this.sceneSnapshot(), 15000);
    if (snapshot.sceneId !== this.sceneId) throw new CocosError('STALE_HANDLE', 'Editor scene changed before preview snapshot delivery');
    await this.bounded(this.diagnosticLog.prepareScene(snapshot, new URL(this.previewAddress!).origin), 5000);
  }

  private engineReadySource(): string {
    // 页面 load 早于引擎就绪，且 Creator 的 System.resolve 是异步接口。
    // 只读取已完成注册的模块，等待预览自身加载引擎，不主动启动第二条模块加载链。
    return `let cc;
      for(let attempt=0;attempt<100;attempt++) {
        try { cc=${this.major === 2 ? 'globalThis.cc' : "globalThis.System?.get(await globalThis.System.resolve('cc'))"}; } catch {}
        if(cc?.director?.getScene()) break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(!cc?.director?.getScene()) throw new Error('Target preview engine or scene has not launched');`;
  }

  async execute(method: string, params: JsonObject): Promise<JsonValue> {
    if (method.startsWith('refresh')) {
      if (!this.refresh) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Resource refresh host unavailable');
      if (method === 'refresh') {
        const target = params.target ?? this.target;
        const status = Json.object(await this.execute('status', { target }));
        params = { ...params, binding: { target, previewSessionId: status.previewSessionId ?? status.sessionId ?? null, url: status.url ?? null } };
      }
      return this.refresh.execute(method, params);
    }
    const requestedTarget = params.target ?? this.target;
    if (!['embedded', 'external-browser'].includes(String(requestedTarget))) throw new CocosError('INVALID_ARGUMENT', 'Unknown preview target');
    if (requestedTarget === 'external-browser') {
      if (params.fixtureId !== undefined) throw new CocosError('UNSUPPORTED_CAPABILITY', 'External connector has not supplied enforceable fixture network isolation');
      const result = await this.external.execute(method, params);
      if (method === 'start') this.target = 'external-browser';
      return result;
    }
    if (method === 'start') this.target = 'embedded';
    if (method === 'logs') return this.diagnosticLog.query(params);
    if (method === 'network' || method === 'websocket') return this.diagnosticLog.query({ ...params, category: method });
    if (method === 'diagnose') return new PreviewDiagnosis().summarize(await this.diagnosticLog.query(params), params.connectionRoles as JsonObject[] ?? []);
    if (method === 'status') {
      const window = this.window; this.gameReady = false;
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed() && this.ready) {
        try {
          const observed = await this.inspect(window);
          this.gameReady = observed.ready === true && Number(observed.sceneFrameIndex) > 0;
        } catch { this.observation = {}; }
      }
      return this.status();
    }
    if (method === 'wait') {
      const deadline = Date.now() + Number(params.timeoutMs ?? 10000);
      if (!Number.isInteger(Number(params.timeoutMs ?? 10000)) || Number(params.timeoutMs ?? 10000) < 100 || Number(params.timeoutMs ?? 10000) > 30000) throw new CocosError('INVALID_ARGUMENT', 'Wait timeout must be 100..30000 ms');
      const window = this.window;
      if (!window || window.isDestroyed() || !this.ready) throw new CocosError('CONTEXT_UNAVAILABLE', 'Managed preview unavailable');
      const initial = this.diagnosticLog.sessionId;
      let observed: JsonObject = {};
      while (Date.now() < deadline) {
        observed = await this.bounded(this.inspect(window, params), Math.max(1, deadline - Date.now()));
        if (initial !== this.diagnosticLog.sessionId) throw new CocosError('STALE_HANDLE', 'Preview changed during wait');
        if (observed.ready && (params.sceneId === undefined || observed.sceneId === params.sceneId) && (params.afterFrameIndex === undefined || Number(observed.frameIndex) > Number(params.afterFrameIndex))) return { status: 'completed', ...observed, businessOutcomeVerified: false };
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
      }
      throw new CocosError('TIMEOUT', 'Preview readiness condition was not observed', observed);
    }
    if (method === 'connect-runtime') {
      if (this.fixtureNetwork) {
        const url = new URL(String(Json.object(params.config).url));
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new CocosError('UNAUTHORIZED', 'Fixture gateway must be local');
        this.fixtureNetwork.origins.add(url.origin);
      }
      const window = this.window;
      if (!window || window.isDestroyed() || !this.ready) throw new CocosError('CONTEXT_UNAVAILABLE', 'Start an MCP preview before connecting its runtime');
      await this.inspect(window, params);
      await this.bounded(window.webContents.executeJavaScript(String(params.source)), 5000);
      // 凭证来自本工程受控配置，只进入同源开发预览；返回值和错误信息不包含凭证。
      const result = await this.bounded(window.webContents.executeJavaScript(`(async () => {
        ${this.engineReadySource()}
        if (globalThis.__cocosMcpDevelopmentConnection) await Promise.race([
          globalThis.__cocosMcpDevelopmentConnection.stop().catch(() => {}), new Promise(resolve=>setTimeout(resolve,1000))
        ]);
        globalThis.__cocosMcpDevelopmentConnection = await CocosMCPRuntime.CocosMCP.connect({
          ...${JSON.stringify(params.config)}, cc, major: ${this.major}, development: true
        });
        return {connected:true, runtimeInstanceId:globalThis.__cocosMcpDevelopmentConnection.instanceId, sceneId:cc.director.getScene()?.uuid ?? null, runtimeSourceFingerprint:globalThis.__cocosMcpDevelopmentConnection.sourceFingerprint};
      })()`), 28000);
      this.runtimeRegistered = Boolean(result && typeof result === 'object' && (result as { connected?: boolean }).connected === true);
      const handshake = Json.object(result);
      return { ...handshake, ...await this.inspect(window, params), connected: this.runtimeRegistered,
        runtimeSourceConsistency: typeof params.expectedSourceFingerprint === 'string' && typeof handshake.runtimeSourceFingerprint === 'string' ? handshake.runtimeSourceFingerprint === params.expectedSourceFingerprint ? 'matched' : 'mismatched' : 'unknown' };
    }
    if (method === 'stop') {
      if (this.window && !this.window.isDestroyed()) await this.bounded(this.window.webContents.executeJavaScript('globalThis.__cocosMcpDevelopmentConnection?.stop()'), 1000).catch(() => {});
      this.dispose(); return { stopped: true, scope: 'mcp-owned-preview-window' };
    }
    if (method === 'start') {
      const sceneId = String(params.sceneId ?? '');
      if (!sceneId) throw new CocosError('INVALID_ARGUMENT', 'Preview requires a saved scene UUID');
      if (this.window && !this.window.isDestroyed()) {
        if (this.sceneId !== sceneId) throw new CocosError('RESOURCE_BUSY', 'Stop the existing MCP preview before changing its scene');
        return this.status();
      }
      const width = Number(params.width ?? 1280), height = Number(params.height ?? 800);
      if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048)) throw new CocosError('INVALID_ARGUMENT', 'Preview dimensions must be 256..2048');
      new PreviewCoordinates().orientation(width, height, params.orientation);
      const url = this.previewUrl(String(params.url), sceneId), origin = new URL(url).origin;
      let fixture: { fixtureId: string; expiresAt: number; origins: Set<string> } | undefined;
      if (params.fixtureId !== undefined) {
        const fixtureId = Json.string(params.fixtureId, 'fixtureId');
        if (!this.projectPath || !/^[a-zA-Z0-9_-]{1,128}$/.test(fixtureId)) throw new CocosError('INVALID_ARGUMENT', 'Invalid fixture identity');
        const paths = await ProjectPaths.open(this.projectPath), state = Json.object(JSON.parse(await readFile(await paths.resolve(`.codex-work/cache/cocos-mcp/fixtures/${fixtureId}.json`), 'utf8')));
        if (state.status !== 'active' || Date.parse(String(state.expiresAt)) <= Date.now() || Json.object(state.snapshot).sceneId !== sceneId) throw new CocosError('STALE_HANDLE', 'Fixture is expired, inactive or belongs to another scene');
        const nativeSocket = new URL(origin); nativeSocket.protocol = nativeSocket.protocol === 'https:' ? 'wss:' : 'ws:';
        // Creator 3 的预览启动依赖同端口 Socket.IO；仅放行这个已核验的原生预览来源。
        fixture = { fixtureId, expiresAt: Date.parse(String(state.expiresAt)), origins: new Set([origin, nativeSocket.origin, ...Json.object(state.network).allowedOrigins as string[]]) };
      }
      this.previewAddress = url;
      const window = this.factory.create({ width, height, useContentSize: true, enableLargerThanScreen: true, show: params.visible !== false, title: 'CocosMCP Preview',
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
          partition: `cocos-mcp-preview-${randomBytes(8).toString('hex')}` } });
      this.diagnosticLog.dispose(); this.diagnosticLog = new PreviewDiagnostics(this.projectPath);
      const diagnosticLog = this.diagnosticLog;
      this.window = window; this.sceneId = sceneId; this.sceneGeneration = 0; this.invalidateObservation(); this.ready = false; this.diagnostics.length = 0;
      this.fixtureNetwork = fixture;
      if (fixture) {
        if (!window.webContents.session.webRequest?.onBeforeRequest) { this.dispose(); throw new CocosError('UNSUPPORTED_CAPABILITY', 'Native fixture request blocking is unavailable'); }
        window.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
          let allowed = false;
          try { const address = new URL(details.url); allowed = Date.now() < fixture.expiresAt && (['data:', 'about:'].includes(address.protocol) || fixture.origins.has(address.origin)); } catch { /* 无法识别的目的地按默认拒绝策略处理。 */ }
          if (!allowed) diagnosticLog.record({ kind: 'network-blocked', url: details.url, message: 'Fixture origin or expiry policy blocked this request' });
          callback({ cancel: !allowed });
        });
      }
      // 只有主页面实际提交才使旧观察失效；被 will-navigate 拒绝的原生自动刷新不能把仍运行的页面标成停止。
      window.webContents.on('did-navigate', () => { if (this.window === window) { this.ready = false; this.invalidateObservation(); } });
      window.webContents.on('did-finish-load', () => { if (this.window === window) this.ready = true; });
      if (window.webContents.setWindowOpenHandler) window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      else window.webContents.on('new-window', event => (event as { preventDefault(): void }).preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      const navigation = (...args: unknown[]): void => {
        const event = args[0] as { preventDefault(): void }, target = String(args[1]);
        try { if (new URL(target).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); }
      };
      window.webContents.on('will-navigate', (...args: unknown[]) => {
        navigation(...args);
        if (this.major === 2) {
          // 2.4.15 没有 autoReload 开关。只锁住工具自有窗口的页面导航，显式 loadURL 刷新不受影响。
          (args[0] as { preventDefault(): void }).preventDefault();
          diagnosticLog.record({ kind: 'navigation-blocked', message: 'Use preview.refresh for this owned Creator 2 window' });
        }
      });
      window.webContents.on('will-redirect', navigation);
      window.webContents.on('console-message', (...args: unknown[]) => {
        const level = Number(args[1]), message = String(args[2]);
        diagnosticLog.record({ kind: 'console', level: level >= 3 ? 'error' : level === 2 ? 'warning' : level === 1 ? 'info' : 'debug', message, line: Number(args[3]) || null, url: String(args[4] ?? '') });
        this.diagnostics.push({ level: level >= 3 ? 'error' : 'warning', message: this.redact.text(message, 2000) });
        if (this.diagnostics.length > 50) this.diagnostics.shift();
      });
      window.webContents.on('did-fail-load', (...args: unknown[]) => diagnosticLog.record({ kind: 'navigation-failure', message: String(args[2] ?? ''), url: String(args[3] ?? '') }));
      window.webContents.on('render-process-gone', () => { if (this.window === window) { this.ready = false; this.invalidateObservation(); } diagnosticLog.record({ kind: 'renderer-crash', message: 'Preview renderer exited' }); });
      // Electron 在首次导航前可能挂起 CDP 命令；先建立空白目标，再为下一次工程导航安装监听。
      try { await this.bounded(window.loadURL('about:blank'), 5000); }
      catch (error) { this.dispose(); throw new CocosError('EDITOR_ERROR', 'Preview page failed to load', { cause: String(error) }); }
      try { await this.bounded(diagnosticLog.attach(window.webContents.debugger), 8000); }
      catch (error) { diagnosticLog.record({ kind: 'capture-gap', message: CocosError.from(error).message }); diagnosticLog.dispose(); }
      window.once('closed', () => { if (this.window === window) this.dispose(); });
      try { await this.prepareScene(); await this.bounded(window.loadURL(url), 15000); if (window.isDestroyed()) throw new Error('Preview closed while loading'); this.ready = true; }
      catch (error) { this.dispose(); throw new CocosError('EDITOR_ERROR', 'Preview page failed to load', { cause: String(error) }); }
      return this.status();
    }
    if (method === 'resize' || method === 'input') {
      if (method === 'input' && this.fixtureNetwork && Date.now() >= this.fixtureNetwork.expiresAt) throw new CocosError('STALE_HANDLE', 'Fixture expired; no input sent', { inputSent: false });
      const window = this.window;
      if (!window || window.isDestroyed() || !this.ready || !window.getContentSize) throw new CocosError('CONTEXT_UNAVAILABLE', 'Managed preview window is unavailable');
      if (method === 'resize') {
        const width = Number(params.width), height = Number(params.height);
        if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048)) throw new CocosError('INVALID_ARGUMENT', 'Preview dimensions must be 256..2048');
        const orientation = new PreviewCoordinates().orientation(width, height, params.orientation);
        if (!window.setContentSize) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Preview resize API unavailable');
        const previousSize = window.getContentSize(); window.setContentSize(width, height);
        try {
          const frame = await this.execute('capture', {}), actual = window.getContentSize();
          if (actual[0] !== width || actual[1] !== height) throw new CocosError('VERIFICATION_FAILED', 'Window manager did not apply requested viewport');
          return { ...frame as JsonObject, requestedViewport: { width, height }, actualWindowContent: { width: actual[0]!, height: actual[1]! }, orientation,
            viewport: { width: actual[0]!, height: actual[1]! }, previousSize, layoutVerified: false, imageDelivery: params.imageDelivery ?? 'image' };
        } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Preview resize or capture incomplete; query current viewport before retrying', { previousSize, actualSize: window.getContentSize(), cause: CocosError.from(error).message }); }
      }
      if (!window.webContents.sendInputEvent || !window.focus || !window.show || !window.isFocused) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Preview input APIs unavailable');
      // 隐藏窗口可能尚未启动场景。先显示并聚焦已绑定的自有窗口，再核对公开场景状态；聚焦不等于发出业务输入。
      window.show(); window.focus();
      if (!window.isFocused()) { this.factory.activate?.(); window.focus(); }
      for (let attempt = 0; attempt < 10 && !window.isFocused(); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      if (!window.isFocused()) throw new CocosError('CONTEXT_UNAVAILABLE', 'Preview window did not acquire input focus', { inputSent: false, stage: 'focus', focused: false });
      const size = window.getContentSize(); let observation: JsonObject;
      try { observation = await this.inspect(window, params); }
      catch (error) { throw new CocosError(CocosError.from(error).code, 'Preview input was not sent: ' + CocosError.from(error).message, { inputSent: false, stage: 'engine', focused: true }); }
      const coordinateSpace = String(params.coordinateSpace ?? 'window-css'), coordinates = new PreviewCoordinates();
      const referenceCapture = this.lastCapture;
      if (coordinateSpace === 'image-pixels') observation = coordinates.imageObservation(referenceCapture, params.captureId, observation, size);
      let { x, y } = coordinates.point(Number(params.x), Number(params.y), coordinateSpace, observation, size);
      if (!['click', 'wheel', 'drag', 'long_press', 'key', 'touch_drag', 'touch_cancel'].includes(String(params.action))) throw new CocosError('INVALID_ARGUMENT', 'Unsupported preview input action');
      const duration = Number(params.durationMs ?? 300), steps = Number(params.steps ?? 10);
      if (!Number.isInteger(duration) || duration < 0 || duration > 2000 || !Number.isInteger(steps) || steps < 1 || steps > 60) throw new CocosError('INVALID_ARGUMENT', 'Invalid bounded gesture');
      let { x: endX, y: endY } = coordinates.point(Number(params.endX ?? params.x), Number(params.endY ?? params.y), coordinateSpace, observation, size);
      if (params.action === 'key' && !/^(?:[A-Za-z0-9]|Space|Enter|Escape|Tab|Backspace|Left|Right|Up|Down)$/.test(String(params.key ?? ''))) throw new CocosError('INVALID_ARGUMENT', 'Unsupported key');
      if (String(params.action).startsWith('touch_') && !window.webContents.debugger?.isAttached()) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Touch input requires the managed preview debugger');
      if (params.action === 'wheel' && ![Number(params.deltaX ?? 0), Number(params.deltaY ?? 0)].every(n => Number.isInteger(n) && Math.abs(n) <= 2000)) throw new CocosError('INVALID_ARGUMENT', 'Wheel delta exceeds bounds');
      if (params.allowResume === true) await this.bounded(window.webContents.executeJavaScript(`(async()=>{${this.engineReadySource()}cc.game.resume();})()`), 12000);
      try {
        observation = Json.object(await this.execute('capture', { expectedSceneId: params.expectedSceneId ?? observation.sceneId ?? null, expectedGeneration: observation.sceneGeneration! }));
        const actualSize = window.getContentSize();
        // 聚焦后首帧可能改变 Canvas 布局；发送前重新换算，旧截图的几何身份必须仍然相同。
        if (coordinateSpace === 'image-pixels') observation = coordinates.imageObservation(referenceCapture, params.captureId, observation, actualSize);
        ({ x, y } = coordinates.point(Number(params.x), Number(params.y), coordinateSpace, observation, actualSize));
        ({ x: endX, y: endY } = coordinates.point(Number(params.endX ?? params.x), Number(params.endY ?? params.y), coordinateSpace, observation, actualSize));
      }
      catch (error) { throw new CocosError(CocosError.from(error).code, 'Preview input was not sent: ' + CocosError.from(error).message, { inputSent: false, stage: 'frame', focused: window.isFocused(), observation: this.observation }); }
      const focusTarget = String(params.focusTarget ?? (params.action === 'key' ? 'game-canvas' : 'window'));
      if (!['game-canvas', 'window'].includes(focusTarget)) throw new CocosError('INVALID_ARGUMENT', 'Invalid focus target');
      let focus: JsonValue = { target: 'window' };
      if (focusTarget === 'game-canvas') {
        // DOM 聚焦不产生游戏点击，避免用点击变通时触发攻击、购买等业务行为。
        focus = await this.bounded(window.webContents.executeJavaScript(`(async () => {
          ${this.engineReadySource()}
          const canvas = cc.game.canvas;
          if (!canvas || !canvas.isConnected) throw new Error('Game canvas unavailable');
          if (canvas.tabIndex < 0) canvas.tabIndex = 0;
          canvas.focus({preventScroll:true});
          const rect = canvas.getBoundingClientRect();
          return {target:'game-canvas', focused:document.activeElement === canvas, devicePixelRatio:devicePixelRatio,
            rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
        })()`), 5000) as JsonValue;
        if (!focus || typeof focus !== 'object' || Array.isArray(focus) || focus.focused !== true) throw new CocosError('CONTEXT_UNAVAILABLE', 'Game canvas did not acquire focus');
      }
      if (params.action === 'key') await this.bounded(window.webContents.executeJavaScript(`(() => {
        globalThis.__cocosMcpInputAck?.dispose();
        const rows=[]; const listener=e=>rows.push({type:e.type,key:e.key,code:e.code,isTrusted:e.isTrusted});
        window.addEventListener('keydown',listener,true); window.addEventListener('keyup',listener,true);
        globalThis.__cocosMcpInputAck={rows,dispose:()=>{window.removeEventListener('keydown',listener,true);window.removeEventListener('keyup',listener,true);delete globalThis.__cocosMcpInputAck;}};
      })()`), 5000);
      const sent: JsonObject[] = [];
      const attempted: JsonObject[] = [];
      const send = (event: JsonObject): void => { attempted.push(event); window.webContents.sendInputEvent!(event); sent.push(event); };
      const wait = async (milliseconds: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, milliseconds)); if (this.window !== window || window.isDestroyed()) throw new CocosError('STALE_HANDLE', 'Preview changed during input'); };
      try {
        send({ type: 'mouseMove', x, y });
        if (String(params.action).startsWith('touch_')) {
          const touch = async (type: string, points: JsonObject[]): Promise<void> => { const event = { type, touchPoints: points }; attempted.push(event); await window.webContents.debugger!.sendCommand('Input.dispatchTouchEvent', event); sent.push(event); };
          try {
            await touch('touchStart', [{ x, y, id: 0 }]);
            for (let i = 1; i <= steps; i++) { await wait(duration / steps); await touch('touchMove', [{ x: x + (endX - x) * i / steps, y: y + (endY - y) * i / steps, id: 0 }]); }
          } finally { await touch(params.action === 'touch_cancel' ? 'touchCancel' : 'touchEnd', []); }
        } else if (params.action === 'key') {
          try {
            send({ type: 'keyDown', keyCode: params.key! });
            // Electron 的 keyDown 不生成文本；字符事件交给当前焦点元素处理，不能直接修改 EditBox.string。
            const character = params.key === 'Space' ? ' ' : /^[A-Za-z0-9]$/.test(String(params.key)) ? String(params.key).toLowerCase() : null;
            if (character !== null) send({ type: 'char', keyCode: character });
            await wait(duration);
          }
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
        const frame = await this.execute('capture', {});
        const inputEvents = params.action === 'key' ? await this.bounded(window.webContents.executeJavaScript('globalThis.__cocosMcpInputAck?.rows ?? []'), 5000) as JsonValue : null;
        return { ...frame as JsonObject, inputSent: true, sentEvents: sent.length, sent, focus, inputEvents, outcomeUnknown: false, businessOutcomeVerified: false, coordinateSpace: 'preview-content-dip-top-left', requestedCoordinateSpace: coordinateSpace, imageDelivery: params.imageDelivery ?? 'image' };
      } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Preview input may have executed; inspect game state before retrying', { inputSent: sent.length > 0 ? true : attempted.length > 0 ? null : false, sentEvents: sent.length, sent, attempted, focus, outcomeUnknown: true, cause: CocosError.from(error).message }); }
      finally { if (params.action === 'key' && !window.isDestroyed()) await this.bounded(window.webContents.executeJavaScript('globalThis.__cocosMcpInputAck?.dispose()'), 1000).catch(() => {}); }
    }
    if (method === 'capture') {
      const window = this.window;
      if (!window || window.isDestroyed() || !this.ready) throw new CocosError('CONTEXT_UNAVAILABLE', 'Start an MCP preview before capturing it');
      if (params.frameMode === 'lastFrame') {
        const current = await this.inspect(window, params);
        if (!this.lastCapture || this.lastCapture.sceneGeneration !== current.sceneGeneration) throw new CocosError('CONTEXT_UNAVAILABLE', 'No captured frame exists in the current scene generation');
        return { ...this.lastCapture, stale: true, freshness: 'explicit-last-frame', imageDelivery: params.imageDelivery ?? 'image' };
      }
      // 等待引擎实际完成一帧，而不是把页面加载或 Canvas 存在误当作场景已经渲染。
      const frame = await this.bounded(window.webContents.executeJavaScript(`(async () => {
        ${this.engineReadySource()}
        ${new PreviewObserver().source()}
        return new Promise(resolve => {
          const timer=setTimeout(() => {cc.director.off(cc.Director.EVENT_AFTER_DRAW, done);resolve({...read(),ready:false, reason:'frame-timeout'});},5000);
          function done(){clearTimeout(timer);resolve(read());}
          cc.director.once(cc.Director.EVENT_AFTER_DRAW,done);
        });
      })()`), 18000);
      if (!frame || typeof frame !== 'object' || (frame as { ready?: boolean }).ready !== true) throw new CocosError('CONTEXT_UNAVAILABLE', 'Preview has not rendered a game frame', frame as JsonValue);
      if (this.window !== window || window.isDestroyed()) throw new CocosError('STALE_HANDLE', 'Managed preview session changed during capture');
      const observed = this.observe(Json.object(frame), params);
      this.gameReady = true;
      const image = await window.webContents.capturePage();
      const current = await this.inspect(window);
      if (current.sceneGeneration !== observed.sceneGeneration) throw new CocosError('STALE_HANDLE', 'Scene changed during window capture; image discarded', { before: observed.sceneGeneration!, after: current.sceneGeneration! });
      if (image.isEmpty()) throw new CocosError('VERIFICATION_FAILED', 'Preview capture returned an empty image');
      const capture = { ...new CaptureEvidence().summarize(image), ...observed, windowContentSize: window.getContentSize?.() ?? null, stale: false, source: 'managed-preview-window',
        imageDelivery: params.imageDelivery ?? 'image',
        frameBinding: 'draw-observed-before-composite', frameIndexAfterCapture: current.frameIndex ?? null, exactPixelFrameIndex: null,
        verification: 'rendered-frame-captured', businessOutcomeVerified: false, layoutVerified: false,
        checks: [{ check: 'image-nonempty', status: 'passed' }, { check: 'frame-drawn', status: 'passed' }, { check: 'expected-layout', status: 'unknown' }], rows: this.diagnostics.slice(-50) };
      this.lastCapture = capture;
      return capture;
    }
    throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown managed preview operation: ${method}`);
  }

  dispose(): void {
    this.refresh?.dispose();
    this.diagnosticLog.dispose();
    const window = this.window; this.window = undefined; this.sceneId = undefined; this.invalidateObservation(); this.ready = false; this.previewAddress = null;
    this.fixtureNetwork = undefined;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
