import { PreviewRedaction } from '../../shared/preview-redaction.js';
import { randomBytes } from 'node:crypto';
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
  private readonly requests = new Map<string, { url: string; method: string; timestamp: number }>();
  private readonly sockets = new Map<string, string>();
  private readonly redaction = new PreviewRedaction();
  constructor(private readonly projectPath?: string) {}
  private text(value: unknown, size: number): string { return this.redaction.text(value, size); }
  private url(value: unknown): string { return value ? this.redaction.url(value) : ''; }
  record(value: JsonObject): void {
    const message = this.text(value.message, 16384), stack = this.text(value.stack, 65536);
    const row: JsonObject = { sequence: ++this.sequence, occurredAt: new Date().toISOString(), kind: this.text(value.kind, 64), level: ['debug', 'info', 'warning', 'error'].includes(String(value.level)) ? value.level! : 'error', message, stack,
      url: this.url(value.url ?? ''), line: typeof value.line === 'number' ? value.line : null, column: typeof value.column === 'number' ? value.column : null,
      status: typeof value.status === 'number' ? value.status : null, method: this.text(value.method, 16), truncated: String(value.message ?? '').length > message.length || String(value.stack ?? '').length > stack.length };
    for (const key of ['requestId', 'direction', 'frameType', 'size', 'closeCode', 'durationMs', 'corsError', 'blockedReason', 'connectionState']) {
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
    const page = matching.slice(0, limit).map(row => this.redaction.value(row) as JsonObject);
    return { sessionId, connection: this.debugger?.isAttached() && this.owned ? 'connected' : 'disconnected', rows: page, nextCursor: page.length ? page[page.length - 1]!.sequence! : Math.max(cursor, sequence), hasMore: matching.length > limit,
      droppedBefore: rows.length ? Number(rows[0]!.sequence) - 1 : sequence, retained: rows.length, persistenceError: this.persistenceError, persistence: this.projectPath ? 'project-log' : 'memory-only',
      limitations: ['仅本 MCP 预览；不含独立浏览器或未附加的 Worker', '最多保留 2000 条及约 8 MiB 字符内容；单条超限标记 truncated', '不记录请求头、正文和帧内容；日志按敏感键值、凭证格式脱敏，无法识别无上下文的任意秘密', '调试器被 DevTools 断开期间有捕捉缺口'] };
  }
  private readonly detached = (_event: unknown, reason: unknown): void => { this.owned = false; this.record({ kind: 'capture-gap', message: `Debugger detached: ${String(reason)}` }); };
  private readonly message = (_event: unknown, method: string, p: any): void => {
    try {
      if (method === 'Runtime.bindingCalled' && p.name === this.binding && typeof p.payload === 'string' && p.payload.length <= 200000) {
        const data = JSON.parse(p.payload); if (['error', 'unhandledrejection', 'resource-error'].includes(data.kind)) this.record(data);
      }
      if (method === 'Runtime.consoleAPICalled') this.record({ kind: 'console', level: p.type === 'error' ? 'error' : p.type === 'warning' ? 'warning' : 'info', message: (p.args ?? []).map((v: any) => typeof v.value === 'object' ? JSON.stringify(this.redaction.value(v.value)) : this.text(v.value ?? v.description, 4096)).join(' ') });
      if (method === 'Runtime.exceptionThrown') this.record({ kind: 'error', message: p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'Unhandled exception', url: p.exceptionDetails?.url ?? '', line: Number(p.exceptionDetails?.lineNumber ?? -1) + 1 });
      if (method === 'Network.requestWillBeSent') {
        if (this.requests.size >= 2000) this.requests.delete(this.requests.keys().next().value!);
        const request = { url: this.url(p.request.url), method: this.text(p.request.method, 16), timestamp: Number(p.timestamp) };
        this.requests.set(p.requestId, request);
      }
      if (method === 'Network.responseReceived') {
        const request = this.requests.get(p.requestId);
        this.record({ kind: p.response.status >= 400 ? 'http-error' : 'http-response', level: p.response.status >= 400 ? 'error' : 'info', message: `HTTP ${p.response.status}`, requestId: p.requestId, status: p.response.status, url: p.response.url, method: request?.method ?? '', durationMs: request && Number.isFinite(p.timestamp - request.timestamp) ? Math.max(0, (p.timestamp - request.timestamp) * 1000) : null });
      }
      if (method === 'Network.loadingFailed') { this.record({ kind: 'network-failure', requestId: p.requestId, message: p.errorText ?? 'Request failed', corsError: p.corsErrorStatus?.corsError ?? null, blockedReason: p.blockedReason ?? null, url: this.requests.get(p.requestId)?.url ?? '', method: this.requests.get(p.requestId)?.method ?? '' }); this.requests.delete(p.requestId); }
      if (method === 'Network.loadingFinished') this.requests.delete(p.requestId);
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
    const d = this.debugger; this.debugger = undefined; this.requests.clear(); this.sockets.clear();
    if (d) { d.removeListener('message', this.message); d.removeListener('detach', this.detached); if (this.owned && d.isAttached()) { if (this.sourceId) void d.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.sourceId }).catch(() => {}); d.detach(); } }
    this.owned = false; void this.flush();
  }
}
