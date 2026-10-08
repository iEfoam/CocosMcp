import { PreviewRedaction } from '../../shared/preview-redaction.js';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ProjectPaths } from '../../../packages/application/src/paths.js';
import { AtomicJsonFile } from '../../../packages/native-adapters/src/atomic-json.js';
import { CocosError, type JsonObject } from '../../../packages/contracts/src/index.js';

export interface PreviewDebugger {
  attach(version?: string): void; detach(): void; isAttached(): boolean;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, callback: (...args: any[]) => void): unknown;
  removeListener(event: string, callback: (...args: any[]) => void): unknown;
}
export class PreviewDiagnostics {
  readonly sessionId = randomBytes(16).toString('hex');
  private rows: JsonObject[] = []; private sequence = 0; private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined; private pending = Promise.resolve(); private persistenceError: string | null = null;
  private readonly writer = new AtomicJsonFile();
  private debugger: PreviewDebugger | undefined; private owned = false; private sourceId: string | undefined;
  private readonly binding = `__cocos_diag_${this.sessionId}`;
  private readonly requests = new Map<string, { url: string; method: string; timestamp: number; startedAt: string; proofUrl?: string; manifestUrl?: string; loaderId?: string; frameId?: string; responseEligible?: boolean }>();
  private readonly sockets = new Map<string, string>();
  private readonly contexts = new Map<number, string>();
  private readonly redaction = new PreviewRedaction();
  private revisionSession: { navigationId: string; origin: string; loaderId: string | null; frameId: string | null; urls: Set<string>; resources: Set<string>; nativeFiles: Map<string, string>; sourceMaps: Map<string, string>; artifacts: Map<string, JsonObject>; pending: Set<Promise<void>> } | undefined;
  async beginRevision(artifacts: JsonObject[], origin: string): Promise<string> {
    const navigationId = randomBytes(16).toString('hex');
    const urls = new Set(artifacts.map(row => {
      const url = new URL(String(row.url), origin);
      if (url.origin !== origin || url.username || url.password || url.hash) throw new CocosError('UNAUTHORIZED', 'Compiled script must belong to the managed preview origin');
      return url.href;
    }));
    const resources = new Set(artifacts.filter(row => row.kind === 'resource').map(row => new URL(String(row.url), origin).href));
    const nativeFiles = new Map(artifacts.filter(row => row.kind === 'resource' && typeof row.nativeFile === 'string' && /^[a-f0-9-]{32,36}(?:@[a-zA-Z0-9_-]+)?\.[a-zA-Z0-9]+$/.test(row.nativeFile)).map(row => [String(row.nativeFile), new URL(String(row.url), origin).href]));
    const sourceMaps = new Map(artifacts.filter(row => typeof row.sourceMapSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sourceMapSha256)).map(row => [String(row.sourceMapSha256), new URL(String(row.url), origin).href]));
    this.revisionSession = { navigationId, origin, loaderId: null, frameId: null, urls, resources, nativeFiles, sourceMaps, artifacts: new Map(), pending: new Set() };
    if (this.owned && this.debugger?.isAttached()) {
      await this.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true });
      await this.debugger.sendCommand('Debugger.enable');
    }
    return navigationId;
  }
  async revision(navigationId: string): Promise<JsonObject> {
    const state = this.revisionSession;
    if (!state || state.navigationId !== navigationId) throw new CocosError('STALE_HANDLE', 'Script observation navigation changed');
    await Promise.all(state.pending);
    return { evidence: state.resources.size ? 'loaded-artifact-bytes' : 'loaded-script-bytes', navigationId: state.loaderId, artifacts: [...state.artifacts.values()] };
  }
  endRevision(): void {
    this.revisionSession = undefined;
    if (this.owned && this.debugger?.isAttached()) void this.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
  }
  private sceneOverride: { url: string; bytes: string } | undefined;
  async prepareScene(snapshot: { sceneId: string; data: string }, origin: string): Promise<void> {
    if (!this.owned || !this.debugger?.isAttached()) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Owned native scene interception is unavailable');
    if (Buffer.byteLength(snapshot.data) > 16 * 1024 * 1024) throw new CocosError('RESOURCE_BUSY', 'Native scene snapshot exceeds limit');
    JSON.parse(snapshot.data);
    this.sceneOverride = { url: new URL('/preview-scene.json', origin).href, bytes: Buffer.from(snapshot.data).toString('base64') };
    // 仅拦截本工具窗口的场景快照请求，保留 Creator 全局 start-scene 配置。
    await this.debugger.sendCommand('Fetch.enable', { patterns: [{ urlPattern: `${this.sceneOverride.url}*`, requestStage: 'Request' }] });
  }
  private async scriptSource(debuggerApi: PreviewDebugger, scriptId: string): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([debuggerApi.sendCommand('Debugger.getScriptSource', { scriptId }), new Promise((_, reject) => { timer = setTimeout(() => reject(new CocosError('TIMEOUT', 'Loaded script byte observation timed out')), 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  constructor(private readonly projectPath?: string) {}
  private async responseBytes(debuggerApi: PreviewDebugger, requestId: string): Promise<Buffer> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([debuggerApi.sendCommand('Network.getResponseBody', { requestId }), new Promise((_, reject) => { timer = setTimeout(() => reject(new CocosError('TIMEOUT', 'Artifact byte observation timed out')), 5000); })]) as { body?: unknown; base64Encoded?: boolean };
      if (typeof response.body !== 'string' || response.body.length > 24 * 1024 * 1024) throw new CocosError('RESOURCE_BUSY', 'Artifact response exceeds limit');
      const bytes = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf8');
      if (bytes.length > 16 * 1024 * 1024) throw new CocosError('RESOURCE_BUSY', 'Artifact response exceeds limit');
      return bytes;
    } finally { if (timer) clearTimeout(timer); }
  }
  private text(value: unknown, size: number): string { return this.redaction.text(value, size); }
  private url(value: unknown): string { return value ? this.redaction.url(value) : ''; }
  record(value: JsonObject): void {
    const message = this.text(value.message, 16384), stack = this.text(value.stack, 65536);
    const row: JsonObject = { sequence: ++this.sequence, occurredAt: new Date().toISOString(), kind: this.text(value.kind, 64), level: ['debug', 'info', 'warning', 'error'].includes(String(value.level)) ? value.level! : 'error', message, stack,
      url: this.url(value.url ?? ''), line: typeof value.line === 'number' ? value.line : null, column: typeof value.column === 'number' ? value.column : null,
      status: typeof value.status === 'number' ? value.status : null, method: this.text(value.method, 16), truncated: String(value.message ?? '').length > message.length || String(value.stack ?? '').length > stack.length };
    row.diagnosticSessionId = this.sessionId;
    for (const key of ['requestId', 'requestStartedAt', 'direction', 'frameType', 'size', 'closeCode', 'durationMs', 'corsError', 'blockedReason', 'connectionState']) {
      if (value[key] !== undefined) row[key] = this.redaction.value(value[key]);
    }
    this.rows.push(row); this.bytes += JSON.stringify(row).length;
    while (this.rows.length > 2000 || this.bytes > 8 * 1024 * 1024) this.bytes -= JSON.stringify(this.rows.shift()!).length;
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 100); this.timer.unref?.(); }
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.projectPath) return;
    const snapshot = { sessionId: this.sessionId, sequence: this.sequence, rows: [...this.rows] };
    this.pending = this.pending.then(async () => {
      const paths = await ProjectPaths.open(this.projectPath!); const dir = await paths.work('logs', 'web-preview');
      await this.writer.write(await paths.resolve(`${dir}/${this.sessionId}.json`), snapshot); this.persistenceError = null;
    }).catch(error => { this.persistenceError = CocosError.from(error).message; });
    await this.pending;
  }
  async query(p: JsonObject): Promise<JsonObject> {
    await this.flush(); const sessionId = p.sessionId ?? this.sessionId;
    if (typeof sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(sessionId)) throw new CocosError('INVALID_ARGUMENT', 'Invalid diagnostic session ID');
    let rows = this.rows, sequence = this.sequence;
    if (sessionId !== this.sessionId) {
      if (!this.projectPath) throw new CocosError('NOT_FOUND', 'Persistent diagnostics unavailable');
      const paths = await ProjectPaths.open(this.projectPath), bytes = await readFile(await paths.resolve(`.codex-work/logs/web-preview/${sessionId}.json`));
      if (bytes.length > 24 * 1024 * 1024) throw new CocosError('INVALID_ARGUMENT', 'Diagnostic file exceeds limit');
      const saved = JSON.parse(bytes.toString()); rows = saved.rows; sequence = saved.sequence;
      if (saved.sessionId !== sessionId || !Array.isArray(rows) || rows.length > 2000) throw new CocosError('INVALID_ARGUMENT', 'Invalid diagnostic file');
    }
    const cursor = Number(p.cursor ?? 0), limit = Number(p.limit ?? 100);
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new CocosError('INVALID_ARGUMENT', 'Invalid diagnostic pagination');
    const instant = (key: string, fallback: number): number => {
      if (p[key] === undefined) return fallback;
      const value = String(p[key]);
      if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new CocosError('INVALID_ARGUMENT', 'Time bounds require an explicit timezone');
      return Date.parse(value);
    };
    const from = instant('from', -Infinity), to = instant('to', Infinity);
    if (from >= to) throw new CocosError('INVALID_ARGUMENT', 'Expected from < to');
    const matching = rows.filter(r => Number(r.sequence) > cursor && Date.parse(String(r.occurredAt)) >= from && Date.parse(String(r.occurredAt)) < to && (!p.category || (p.category === 'network' ? ['http-response', 'http-error', 'network-failure', 'http-request'].includes(String(r.kind)) : String(r.kind).startsWith('websocket-'))) && (!p.level || p.level === r.level) && (!p.kind || p.kind === r.kind) && (!p.contains || `${r.message}\n${r.stack}\n${r.url}`.toLowerCase().includes(String(p.contains).toLowerCase())));
    const page: JsonObject[] = matching.slice(0, limit).map(row => ({ ...this.redaction.value(row) as JsonObject, diagnosticSessionId: sessionId }));
    return { sessionId, connection: this.debugger?.isAttached() && this.owned ? 'connected' : 'disconnected', rows: page, nextCursor: page.length ? page[page.length - 1]!.sequence! : Math.max(cursor, sequence), hasMore: matching.length > limit,
      droppedBefore: rows.length ? Number(rows[0]!.sequence) - 1 : sequence, retained: rows.length, persistenceError: this.persistenceError, persistence: this.projectPath ? 'project-log' : 'memory-only',
      limitations: ['仅本 MCP 预览；不含独立浏览器或未附加的 Worker', '最多保留 2000 条及约 8 MiB 字符内容；单条超限标记 truncated', '不记录请求头、正文和帧内容；日志按敏感键值、凭证格式脱敏，无法识别无上下文的任意秘密', '调试器被 DevTools 断开期间有捕捉缺口'] };
  }
  private readonly detached = (_event: unknown, reason: unknown): void => { this.owned = false; this.record({ kind: 'capture-gap', message: `Debugger detached: ${String(reason)}` }); };
  private readonly message = (_event: unknown, method: string, p: any): void => {
    try {
      if (method === 'Runtime.executionContextsCleared') this.contexts.clear();
      if (method === 'Runtime.executionContextDestroyed') this.contexts.delete(Number(p.executionContextId));
      if (method === 'Runtime.executionContextCreated' && Number.isInteger(p.context?.id) && typeof p.context?.auxData?.frameId === 'string') {
        if (this.contexts.size >= 1000) this.contexts.delete(this.contexts.keys().next().value!);
        this.contexts.set(p.context.id, p.context.auxData.frameId);
      }
      if (method === 'Fetch.requestPaused' && this.debugger) {
        const snapshot = this.sceneOverride;
        if (snapshot && p.request?.method === 'GET' && new URL(String(p.request.url)).origin === new URL(snapshot.url).origin && new URL(String(p.request.url)).pathname === '/preview-scene.json') {
          void this.debugger.sendCommand('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: snapshot.bytes }).catch(() => this.record({ kind: 'capture-gap', message: 'Native scene snapshot delivery failed' }));
        } else void this.debugger.sendCommand('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      }
      if (method === 'Page.frameNavigated' && this.revisionSession && !p.frame?.parentId) {
        const state = this.revisionSession;
        if (new URL(String(p.frame?.url)).origin === state.origin && typeof p.frame?.loaderId === 'string' && typeof p.frame?.id === 'string') {
          state.loaderId = p.frame.loaderId; state.frameId = p.frame.id; state.artifacts.clear();
        }
      }
      if (method === 'Runtime.bindingCalled' && p.name === this.binding && typeof p.payload === 'string' && p.payload.length <= 200000) {
        const data = JSON.parse(p.payload); if (['error', 'unhandledrejection', 'resource-error'].includes(data.kind)) this.record(data);
      }
      if (method === 'Debugger.scriptParsed') {
        const state = this.revisionSession, debuggerApi = this.debugger;
        const frameId = p.executionContextAuxData?.frameId ?? this.contexts.get(Number(p.executionContextId));
        const nativeMap = typeof p.sourceMapURL === 'string' && p.sourceMapURL.length <= 32 * 1024 * 1024 ? state?.sourceMaps.get(createHash('sha256').update(p.sourceMapURL).digest('hex')) : undefined;
        const manifestUrl = state?.urls.has(p.url) && !state.resources.has(p.url) ? String(p.url) : nativeMap;
        if (state?.loaderId && manifestUrl && frameId === state.frameId && debuggerApi && typeof p.scriptId === 'string' && (p.length === undefined || Number(p.length) <= 16 * 1024 * 1024)) {
          const loaderId = state.loaderId;
          const pending = this.scriptSource(debuggerApi, p.scriptId).then(response => {
            const source = (response as { scriptSource?: unknown }).scriptSource;
            if (state.loaderId === loaderId && typeof source === 'string' && Buffer.byteLength(source) <= 16 * 1024 * 1024) state.artifacts.set(manifestUrl, { url: manifestUrl,
              ...(nativeMap ? { mapping: 'native-inline-source-map-digest', observedUrl: p.url ? this.url(p.url) : null } : {}), sha256: createHash('sha256').update(source).digest('hex') });
          }).catch(() => {}).finally(() => state.pending.delete(pending));
          state.pending.add(pending);
        }
      }
      if (method === 'Runtime.consoleAPICalled') this.record({ kind: 'console', level: p.type === 'error' ? 'error' : p.type === 'warning' ? 'warning' : p.type === 'debug' ? 'debug' : 'info', message: (p.args ?? []).map((v: any) => typeof v.value === 'object' ? JSON.stringify(this.redaction.value(v.value)) : this.text(v.value ?? v.description, 4096)).join(' ') });
      if (method === 'Runtime.exceptionThrown') this.record({ kind: 'error', message: p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'Unhandled exception', url: p.exceptionDetails?.url ?? '', line: Number(p.exceptionDetails?.lineNumber ?? -1) + 1 });
      if (method === 'Network.requestWillBeSent') {
        if (this.requests.size >= 2000) this.requests.delete(this.requests.keys().next().value!);
        const state = this.revisionSession;
        const address = new URL(String(p.request.url));
        const nativeRoute = /^\/assets\/[a-zA-Z0-9_-]+\/(?:import|native)\/([a-f0-9]{2})\/([^/]+)$/.exec(address.pathname);
        // 只接受同源 Bundle 中原生清单已有的 UUID 文件；不读取其他业务请求，也不靠任意 URL 回显证明版本。
        const manifestUrl = state?.resources.has(p.request.url) ? String(p.request.url) : state && address.origin === state.origin && nativeRoute && nativeRoute[1] === nativeRoute[2]!.slice(0, 2) ? state.nativeFiles.get(nativeRoute[2]!) : undefined;
        const request = { url: this.url(p.request.url), method: this.text(p.request.method, 16), timestamp: Number(p.timestamp), startedAt: Number.isFinite(p.wallTime) ? new Date(p.wallTime * 1000).toISOString() : new Date().toISOString(),
          ...(state?.loaderId && manifestUrl && p.request.method === 'GET' && p.loaderId === state.loaderId && p.frameId === state.frameId ? { proofUrl: String(p.request.url), manifestUrl, loaderId: String(p.loaderId), frameId: String(p.frameId) } : {}) };
        this.requests.set(p.requestId, request);
      }
      if (method === 'Network.responseReceived') {
        const request = this.requests.get(p.requestId);
        if (request?.proofUrl) request.responseEligible = p.response.url === request.proofUrl && p.response.status >= 200 && p.response.status < 300 && p.loaderId === request.loaderId && p.frameId === request.frameId;
        if (request) this.record({ kind: 'http-request', level: 'info', requestId: p.requestId, requestStartedAt: request.startedAt, url: request.url, method: request.method, message: 'Request metadata; body and headers excluded' });
        this.record({ kind: p.response.status >= 400 ? 'http-error' : 'http-response', level: p.response.status >= 400 ? 'error' : 'info', message: `HTTP ${p.response.status}`, requestId: p.requestId, status: p.response.status, url: p.response.url, method: request?.method ?? '', durationMs: request && Number.isFinite(p.timestamp - request.timestamp) ? Math.max(0, (p.timestamp - request.timestamp) * 1000) : null });
      }
      if (method === 'Network.loadingFailed') { this.record({ kind: 'network-failure', requestId: p.requestId, message: p.errorText ?? 'Request failed', corsError: p.corsErrorStatus?.corsError ?? null, blockedReason: p.blockedReason ?? null, url: this.requests.get(p.requestId)?.url ?? '', method: this.requests.get(p.requestId)?.method ?? '' }); this.requests.delete(p.requestId); }
      if (method === 'Network.loadingFinished') {
        const request = this.requests.get(p.requestId), state = this.revisionSession, debuggerApi = this.debugger;
        // 正文读取仅限调用方刷新清单中的工程产物；普通业务请求始终不采集正文。
        if (request?.proofUrl && request.responseEligible && state && state.loaderId === request.loaderId && state.frameId === request.frameId && debuggerApi && Number(p.encodedDataLength) <= 16 * 1024 * 1024) {
          const loaderId = state.loaderId, url = request.manifestUrl!;
          const pending = this.responseBytes(debuggerApi, String(p.requestId)).then(bytes => {
            if (this.revisionSession === state && state.loaderId === loaderId) state.artifacts.set(url, { url, kind: 'resource', ...(request.proofUrl !== url ? { observedUrl: this.url(request.proofUrl), mapping: 'native-uuid-file-in-same-preview-origin' } : {}), sha256: createHash('sha256').update(bytes).digest('hex') });
          }).catch(() => {}).finally(() => state.pending.delete(pending)); state.pending.add(pending);
        }
        this.requests.delete(p.requestId);
      }
      if (method === 'Network.webSocketCreated') { if (this.sockets.size >= 2000) this.sockets.delete(this.sockets.keys().next().value!); this.sockets.set(p.requestId, this.url(p.url)); this.record({ kind: 'websocket-created', level: 'info', requestId: p.requestId, url: p.url, connectionState: 'connecting' }); }
      if (method === 'Network.webSocketHandshakeResponseReceived') this.record({ kind: 'websocket-handshake', level: p.response.status === 101 ? 'info' : 'error', requestId: p.requestId, url: this.sockets.get(p.requestId) ?? '', status: p.response.status, connectionState: p.response.status === 101 ? 'connected' : 'failed' });
      if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
        const opcode = Number(p.response.opcode), payload = String(p.response.payloadData ?? '');
        // CDP 的非文本 payload 是 Base64，只计算字节数，绝不保存或返回内容。
        const size = opcode === 1 ? Buffer.byteLength(payload, 'utf8') : Buffer.byteLength(payload, 'base64');
        const closeCode = opcode === 8 && size >= 2 ? Buffer.from(payload, 'base64').readUInt16BE(0) : null;
        this.record({ kind: 'websocket-frame', level: 'info', requestId: p.requestId, url: this.sockets.get(p.requestId) ?? '', direction: method.endsWith('Sent') ? 'sent' : 'received', frameType: opcode === 1 ? 'text' : opcode === 2 ? 'binary' : 'control', size, closeCode });
      }
      if (method === 'Network.webSocketFrameError') this.record({ kind: 'websocket-error', requestId: p.requestId, url: this.sockets.get(p.requestId) ?? '', message: p.errorMessage ?? 'WebSocket frame failed' });
      if (method === 'Network.webSocketClosed') { this.record({ kind: 'websocket-closed', level: 'info', requestId: p.requestId, url: this.sockets.get(p.requestId) ?? '', connectionState: 'closed' }); this.sockets.delete(p.requestId); }
    } catch { this.record({ kind: 'capture-gap', message: 'Malformed browser diagnostic was rejected' }); }
  };
  async attach(debuggerApi?: PreviewDebugger): Promise<void> {
    if (!debuggerApi || debuggerApi.isAttached()) { this.record({ kind: 'capture-gap', message: 'Debugger unavailable or already owned by another client; console fallback only' }); return; }
    this.debugger = debuggerApi;
    try {
      debuggerApi.attach('1.3'); this.owned = true; debuggerApi.on('message', this.message); debuggerApi.on('detach', this.detached);
      await debuggerApi.sendCommand('Runtime.enable'); await debuggerApi.sendCommand('Network.enable'); await debuggerApi.sendCommand('Page.enable');
      await debuggerApi.sendCommand('Runtime.addBinding', { name: this.binding });
      // 固定脚本只监听事件，不 preventDefault，不替换 console/fetch/XHR，也不发送网络请求。
      const source = `(()=>{const send=v=>{try{globalThis[${JSON.stringify(this.binding)}](JSON.stringify(v))}catch{}};const text=v=>{try{return String(v??'').slice(0,65537)}catch{return '[unprintable]'}};addEventListener('error',e=>{const resource=e.target&&e.target!==globalThis;send({kind:resource?'resource-error':'error',message:resource?'Resource load failed':text(e.message),stack:text(e.error&&e.error.stack),url:resource?text(e.target.src||e.target.href):text(e.filename),line:e.lineno,column:e.colno})},true);addEventListener('unhandledrejection',e=>send({kind:'unhandledrejection',message:text(e.reason&&e.reason.message||e.reason),stack:text(e.reason&&e.reason.stack),url:location.href}));})()`;
      const result = await debuggerApi.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source }) as { identifier: string }; this.sourceId = result.identifier;
    } catch (error) { this.record({ kind: 'capture-gap', message: CocosError.from(error).message }); this.dispose(); }
  }
  dispose(): void {
    const d = this.debugger; this.debugger = undefined; this.requests.clear(); this.sockets.clear(); this.contexts.clear(); this.revisionSession = undefined; this.sceneOverride = undefined;
    if (d) { d.removeListener('message', this.message); d.removeListener('detach', this.detached); if (this.owned && d.isAttached()) { if (this.sourceId) void d.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.sourceId }).catch(() => {}); d.detach(); } }
    this.owned = false; void this.flush();
  }
}
