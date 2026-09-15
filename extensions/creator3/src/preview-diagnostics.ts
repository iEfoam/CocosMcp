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
  private readonly requests = new Map<string, { url: string; method: string }>();
  constructor(private readonly projectPath?: string) {}
  private text(value: unknown, size: number): string { return String(value ?? '').slice(0, size); }
  private url(value: unknown): string {
    try { const u = new URL(String(value)); if (!['http:', 'https:', 'file:'].includes(u.protocol)) return `[${u.protocol}]`; u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.href; } catch { return this.text(value, 2048); }
  }
  record(value: JsonObject): void {
    const message = this.text(value.message, 16384), stack = this.text(value.stack, 65536);
    const row: JsonObject = { sequence: ++this.sequence, occurredAt: new Date().toISOString(), kind: this.text(value.kind, 64), level: value.level === 'warning' ? 'warning' : 'error', message, stack,
      url: this.url(value.url ?? ''), line: typeof value.line === 'number' ? value.line : null, column: typeof value.column === 'number' ? value.column : null,
      status: typeof value.status === 'number' ? value.status : null, method: this.text(value.method, 16), truncated: String(value.message ?? '').length > message.length || String(value.stack ?? '').length > stack.length };
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
    const matching = rows.filter(r => Number(r.sequence) > cursor && (!p.level || p.level === r.level) && (!p.kind || p.kind === r.kind) && (!p.contains || `${r.message}\n${r.stack}\n${r.url}`.toLowerCase().includes(String(p.contains).toLowerCase())));
    const page = matching.slice(0, limit);
    return { sessionId, rows: page, nextCursor: page.length ? page[page.length - 1]!.sequence! : Math.max(cursor, sequence), hasMore: matching.length > limit,
      droppedBefore: rows.length ? Number(rows[0]!.sequence) - 1 : sequence, retained: rows.length, persistenceError: this.persistenceError, persistence: this.projectPath ? 'project-log' : 'memory-only',
      limitations: ['仅本 MCP 预览；不含独立浏览器或未附加的 Worker', '最多保留 2000 条及约 8 MiB 字符内容；单条超限标记 truncated', '不记录请求头或正文；错误消息和堆栈仍可能包含业务敏感信息', '调试器被 DevTools 断开期间有捕捉缺口'] };
  }
  private readonly detached = (_event: unknown, reason: unknown): void => { this.owned = false; this.record({ kind: 'capture-gap', message: `Debugger detached: ${String(reason)}` }); };
  private readonly message = (_event: unknown, method: string, p: any): void => {
    try {
      if (method === 'Runtime.bindingCalled' && p.name === this.binding && typeof p.payload === 'string' && p.payload.length <= 200000) {
        const data = JSON.parse(p.payload); if (['error', 'unhandledrejection', 'resource-error'].includes(data.kind)) this.record(data);
      }
      if (method === 'Network.requestWillBeSent') {
        if (this.requests.size >= 2000) this.requests.delete(this.requests.keys().next().value!);
        this.requests.set(p.requestId, { url: this.url(p.request.url), method: this.text(p.request.method, 16) });
      }
      if (method === 'Network.responseReceived' && p.response.status >= 400) this.record({ kind: 'http-error', message: `HTTP ${p.response.status}`, status: p.response.status, url: p.response.url, method: this.requests.get(p.requestId)?.method ?? '' });
      if (method === 'Network.loadingFailed') { this.record({ kind: 'network-failure', message: p.errorText ?? 'Request failed', ...this.requests.get(p.requestId) }); this.requests.delete(p.requestId); }
      if (method === 'Network.loadingFinished') this.requests.delete(p.requestId);
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
    const d = this.debugger; this.debugger = undefined; this.requests.clear();
    if (d) { d.removeListener('message', this.message); d.removeListener('detach', this.detached); if (this.owned && d.isAttached()) { if (this.sourceId) void d.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.sourceId }).catch(() => {}); d.detach(); } }
    this.owned = false; void this.flush();
  }
}
