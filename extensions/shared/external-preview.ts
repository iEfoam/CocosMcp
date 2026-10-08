import { PreviewDiagnosis } from './preview-diagnose.js';
import { request } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { ProjectPaths } from '../../packages/application/src/paths.js';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../packages/contracts/src/index.js';
import { PreviewRedaction } from './preview-redaction.js';

/** 由现有浏览器工具实现；MCP 不启动 Chrome 调试端口、不接管整个浏览器。 */
export interface ExternalBrowserPort {
  call(method: string, params: JsonObject): Promise<JsonObject>;
}

export class PreviewHttp {
  static local(raw: string): URL {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new CocosError('UNAUTHORIZED', 'Preview connection requires an unauthenticated loopback HTTP URL');
    return url;
  }
  static async send(url: URL, body?: JsonObject, token?: string): Promise<{ status: number; content: string }> {
    return new Promise((resolve, reject) => {
      const bytes = body ? JSON.stringify(body) : undefined;
      // Creator 2.4.15 的预览模板会直接读取 User-Agent；空请求头会令服务自身返回 500。
      const req = request(url, { method: body ? 'POST' : 'GET', headers: { 'User-Agent': 'CocosMCP-preview-probe/1.0', ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, response => {
        const chunks: Buffer[] = []; let length = 0;
        response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 8 * 1024 * 1024) req.destroy(new Error('Response exceeds limit')); else chunks.push(chunk); });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, content: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', reject);
      });
      const timer = setTimeout(() => req.destroy(new CocosError('TIMEOUT', 'Preview connection timed out')), 15000);
      req.on('close', () => clearTimeout(timer)); req.on('error', reject);
      req.end(bytes);
    });
  }
}

/** 配置由已有浏览器连接器创建，凭证不进入 capability 参数、日志或返回值。 */
export class ProjectBrowserConnector implements ExternalBrowserPort {
  constructor(private readonly projectPath: string) {}
  async call(method: string, params: JsonObject): Promise<JsonObject> {
    const paths = await ProjectPaths.open(this.projectPath);
    let config: JsonObject;
    try { config = Json.object(JSON.parse(await readFile(await paths.resolve('.codex-work/cache/cocos-mcp/browser-connector.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CocosError('CONTEXT_UNAVAILABLE', 'External browser connector is not configured'); throw new CocosError('UNAUTHORIZED', 'Invalid browser connector configuration'); }
    if (config.protocolVersion !== 1 || config.projectPath !== paths.root || typeof config.token !== 'string' || config.token.length < 32) throw new CocosError('UNAUTHORIZED', 'Browser connector project identity or credential is invalid');
    const url = PreviewHttp.local(Json.string(config.endpoint, 'endpoint'));
    if (url.search || url.hash) throw new CocosError('UNAUTHORIZED', 'Connector endpoint must not contain query credentials');
    try {
      const result = await PreviewHttp.send(url, { protocolVersion: 1, projectPath: paths.root, method, params }, config.token);
      if (result.status !== 200) throw new Error('Connector rejected request');
      const response = Json.object(JSON.parse(result.content));
      if (response.protocolVersion !== 1 || response.projectPath !== paths.root) throw new Error('Connector identity mismatch');
      const data = Json.object(response.result);
      if (['capture', 'resize', 'input'].includes(method) && data.path !== undefined) {
        const path = Json.string(data.path, 'screenshot path');
        if (!path.startsWith('.codex-work/')) throw new Error('Screenshot must remain in project work directory');
        const absolute = await paths.resolve(path), info = await stat(absolute);
        if (!info.isFile() || info.size < 24 || info.size > 32 * 1024 * 1024) throw new Error('Screenshot must be a bounded regular PNG');
        const bytes = await readFile(absolute);
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Screenshot must be PNG');
        data.dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
        data.image = { mimeType: 'image/png', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        data.width = bytes.readUInt32BE(16); data.height = bytes.readUInt32BE(20);
        data.source = 'scoped-browser-connector'; data.captureId = randomBytes(16).toString('hex'); data.capturedAt = new Date().toISOString();
      }
      return data;
    } catch {
      if (method === 'input') throw new CocosError('OUTCOME_UNKNOWN', 'External input response was lost; inspect page state before any retry', { inputSent: null });
      throw new CocosError('CONTEXT_UNAVAILABLE', 'External browser connector disconnected or rejected the scoped request');
    }
  }
}

export class ExternalPreview {
  private session: { sessionId: string; url: string; sceneId: string; tabId: string | null; owned: boolean } | undefined;
  private readonly redact = new PreviewRedaction();
  constructor(private readonly browser?: ExternalBrowserPort, private readonly major: 2 | 3 = 3) {}
  private async observe(method: string, params: JsonObject = {}): Promise<JsonObject> {
    const session = this.session;
    if (!session || !this.browser) throw new CocosError('CONTEXT_UNAVAILABLE', 'External preview browser is not connected');
    const result = await this.browser.call(method, { ...params, sessionId: session.sessionId, url: session.url, sceneId: session.sceneId, tabId: session.tabId });
    // 每次命令都重新核对页面归属；导航到其他工程后不能继续截图、收集或点击。
    if (result.sessionId !== session.sessionId || result.url !== session.url || typeof result.tabId !== 'string' || (session.tabId !== null && result.tabId !== session.tabId)) throw new CocosError('STALE_HANDLE', 'Browser session or preview page changed');
    if (result.connection !== 'connected') throw new CocosError('CONTEXT_UNAVAILABLE', 'External preview browser disconnected');
    if (params.expectedSceneId !== undefined && params.expectedSceneId !== result.currentSceneId) throw new CocosError('VERIFICATION_FAILED', 'External current scene differs from strict expectation', { actualSceneId: result.currentSceneId ?? null, inputSent: false });
    if (params.expectedGeneration !== undefined && params.expectedGeneration !== result.sceneGeneration) throw new CocosError('STALE_HANDLE', 'External scene generation changed', { inputSent: false });
    if (params.expectedRuntimeInstanceId !== undefined && params.expectedRuntimeInstanceId !== result.runtimeInstanceId) throw new CocosError('STALE_HANDLE', 'External runtime identity changed', { inputSent: false });
    session.tabId = result.tabId;
    return result;
  }
  async execute(method: string, params: JsonObject): Promise<JsonValue> {
    if (method === 'start') {
      if (params.browser !== undefined && params.browser !== 'chrome') throw new CocosError('INVALID_ARGUMENT', 'Only the Chrome connector contract is supported');
      const url = PreviewHttp.local(Json.string(params.url, 'url')); url.searchParams.set('scene', Json.string(params.sceneId, 'sceneId'));
      if (this.major === 3) url.searchParams.set('autoReload', 'false');
      if (this.session && this.session.url !== url.href) throw new CocosError('RESOURCE_BUSY', 'Stop the current external session before changing scenes');
      if (this.session?.tabId) return this.execute('status', {});
      const probe = await PreviewHttp.send(url);
      if (probe.status < 200 || probe.status >= 300) throw new CocosError('CONTEXT_UNAVAILABLE', 'Creator preview service is not ready', { status: probe.status });
      this.session ??= { sessionId: randomBytes(16).toString('hex'), url: url.href, sceneId: String(params.sceneId), tabId: null, owned: false };
      try {
        const observed = await this.observe('start', { browser: 'chrome', reuseExisting: params.reuseExisting !== false, ownership: 'close-only-created-tab' });
        this.session.owned = observed.owned === true;
        return this.state(observed);
      } catch (error) {
        if (CocosError.from(error).code !== 'CONTEXT_UNAVAILABLE') throw error;
        return { ...this.state(), service: 'ready', status: 'service-ready', reason: CocosError.from(error).message };
      }
    }
    if (method === 'status') {
      if (!this.session) return this.state();
      try { return this.state(await this.observe('status')); }
      catch (error) { return { ...this.state(), reason: CocosError.from(error).message }; }
    }
    if (method === 'stop') {
      const session = this.session;
      if (!session) return { stopped: true, target: 'external-browser', closedTab: false };
      if (session.tabId) {
        await this.observe('status');
        await this.observe('stop', { closeTab: session.owned });
      }
      this.session = undefined;
      return { stopped: true, target: 'external-browser', closedTab: session.owned, scope: 'owned-tab-only' };
    }
    await this.observe('status', params);
    let observed: JsonObject;
    try { observed = await this.observe(method === 'diagnose' ? 'logs' : method, params); }
    catch (error) {
      // 校验是在输入响应之后发生时，不能把未知副作用降级为可安全重试的连接错误。
      if (method === 'input') throw new CocosError('OUTCOME_UNKNOWN', 'External input may have executed; inspect page before retrying', { inputSent: null, cause: CocosError.from(error).message });
      throw error;
    }
    if (['logs', 'network', 'websocket', 'diagnose'].includes(method)) {
      const columns = new Set(['sequence', 'occurredAt', 'kind', 'level', 'message', 'stack', 'url', 'line', 'column', 'status', 'method', 'requestId', 'direction', 'frameType', 'size', 'closeCode', 'durationMs', 'corsError', 'blockedReason', 'connectionState', 'truncated']);
      const rows = Array.isArray(observed.rows) ? observed.rows.slice(0, Number(params.limit ?? 100)).map(row => Object.fromEntries(Object.entries(Json.object(row)).filter(([key]) => columns.has(key)))) : [];
      const result: JsonObject = { sessionId: this.session!.sessionId, connection: 'connected', rows: this.redact.value(rows), nextCursor: observed.nextCursor ?? 0, hasMore: observed.hasMore ?? false, droppedBefore: observed.droppedBefore ?? 0 };
      return method === 'diagnose' ? new PreviewDiagnosis().summarize(result, params.connectionRoles as JsonObject[] ?? []) : result;
    }
    // 截图是工具返回的图片，不作为文本递归截断；连接器只返回项目内截图路径。
    const result = Json.object(this.redact.value(observed));
    // 只保留已经核验的工具身份和工程内 PNG；诊断文本仍完整脱敏，不能截断图片正文。
    for (const key of ['sessionId', 'previewSessionId', 'diagnosticSessionId', 'runtimeInstanceId']) if (typeof observed[key] === 'string') result[key] = observed[key]!;
    if (typeof observed.dataUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(observed.dataUrl) && observed.dataUrl.length <= 48 * 1024 * 1024) result.dataUrl = observed.dataUrl;
    result.imageDelivery = params.imageDelivery ?? 'image';
    return result;
  }
  private state(observed?: JsonObject): JsonObject {
    const sceneId = observed?.currentSceneId ?? null;
    return { target: 'external-browser', browser: 'chrome', sessionId: this.session?.sessionId ?? null, previewSessionId: this.session?.sessionId ?? null, url: this.session?.url ?? null,
      launchSceneId: this.session?.sceneId ?? null, sceneId, currentSceneId: sceneId, sceneGeneration: observed?.sceneGeneration ?? null,
      frameIndex: observed?.frameIndex ?? null, runtimeInstanceId: observed?.runtimeInstanceId ?? null, observation: observed?.observation ? this.redact.value(observed.observation) : {},
      tabId: this.session?.tabId ?? null, owned: this.session?.owned ?? false, connection: observed ? 'connected' : 'disconnected',
      status: observed?.gameReady === true ? 'game-ready' : observed?.pageOpened === true ? 'page-opened' : 'unknown',
      service: observed ? 'ready' : 'unknown', running: observed?.pageOpened === true, pageReady: observed?.pageOpened === true, gameReady: observed?.gameReady === true };
  }
}
