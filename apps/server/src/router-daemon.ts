import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ClientPolicies } from '../../../packages/application/src/client-policy.js';
import { ProjectPaths } from '../../../packages/application/src/paths.js';
import type { ServiceLease } from '../../../packages/application/src/service-connections.js';
import { RouterRuntime } from './router-runtime.js';
import type { RouterSession } from './router-session.js';

interface RouterConnection { session: RouterSession; closeWire: () => Promise<void>; requests: number; closing?: Promise<void> }
interface HttpConnection extends RouterConnection { handle: (request: IncomingMessage, response: ServerResponse, body?: unknown) => Promise<void> }

/** 路由服务只绑定回环；连接保留到主动关闭，不用空闲时间猜测宿主是否仍持有会话。 */
export class RouterDaemon {
  private readonly connections = new Set<RouterConnection>();
  private readonly httpSessions = new Map<string, HttpConnection>();
  private server: Server | undefined;
  private lease: ServiceLease | undefined;
  private timer: NodeJS.Timeout | undefined;
  private idleSince = performance.now();
  private draining = false;
  private initializing = 0;
  private sessionModule: Promise<typeof import('./router-session.js')> | undefined;
  private closing: Promise<void> | undefined;
  private starting: Promise<string> | undefined;

  private reply(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value));
  }
  private async body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []; let bytes = 0;
    const deadline = setTimeout(() => request.destroy(new Error('Request body timeout')), 10_000);
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) throw new Error('Request exceeds 8 MB');
        chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally { clearTimeout(deadline); }
  }
  private workspace(request: IncomingMessage): string | undefined {
    const encoded = request.headers['x-cocos-workspace'];
    if (encoded === undefined || encoded === '') return undefined;
    if (typeof encoded !== 'string' || encoded.length > 5500 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid workspace header');
    const value = Buffer.from(encoded, 'base64').toString('utf8');
    if (!isAbsolute(value) || value.length > 4096 || value.includes('\0') || Buffer.from(value).toString('base64') !== encoded) throw new Error('Invalid workspace path');
    return value;
  }
  private async session(installation: string, worker: string, workspace?: string): Promise<RouterSession> {
    // 使用运行时 URL 加载独立制品；esbuild 不把重型依赖重新内联到轻量服务中。
    const location = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'session.mjs')).href;
    const { RouterSession } = await (this.sessionModule ??= import(location));
    return new RouterSession(installation, worker, await new ClientPolicies().load(await ProjectPaths.open(installation)), workspace);
  }
  private release(row: RouterConnection): Promise<void> {
    return row.closing ??= Promise.resolve().then(async () => {
      await row.closeWire();
      while (row.requests) await new Promise(resolve => setTimeout(resolve, 20));
      await row.session.close(); this.connections.delete(row); this.idleSince = performance.now();
    });
  }
  private async handle(request: IncomingMessage, response: ServerResponse, installation: string, worker: string, token: string): Promise<void> {
    const host = new URL(`http://${request.headers.host ?? ''}`).hostname;
    // 浏览器不需要访问私有控制入口；拒绝 Origin，缩小本地跨站请求面。
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host) || request.headers.origin) { this.reply(response, 403, { error: 'Local non-browser client required' }); request.resume(); return; }
    const actual = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { this.reply(response, 401, { error: 'Bearer token required' }); request.resume(); return; }
    if (request.url === '/router/status' && request.method === 'POST') {
      request.resume(); this.reply(response, 200, { pid: process.pid, sessions: this.connections.size, initializing: this.initializing, loaded: Boolean(this.sessionModule),
        connectors: [...this.connections].filter(row => row.session.connected()).length, memory: process.memoryUsage() }); return;
    }
    if (this.draining) { this.reply(response, 503, { error: 'Router is draining; reconnect explicitly' }); request.resume(); return; }
    if (request.url === '/stdio' && request.method === 'POST') {
      if (request.headers['content-type'] !== 'application/x-ndjson') { this.reply(response, 415, { error: 'Use application/x-ndjson' }); request.resume(); return; }
      if (this.connections.size + this.initializing >= 512) { this.reply(response, 503, { error: 'Router session capacity reached' }); request.resume(); return; }
      this.initializing++;
      let session: RouterSession | undefined;
      try {
        session = await this.session(installation, worker, this.workspace(request));
        const { serveStdio, StdioServerTransport } = await this.sessionModule!;
        if (response.destroyed || this.draining) { await session.close(); return; }
        response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' }); response.flushHeaders();
        const wire = serveStdio(() => session!.factory.create(), { transport: new StdioServerTransport(request, response, { maxBufferSize: 8 * 1024 * 1024 }), onerror: error => console.error('[CocosMCP session]', error.message) });
        const row: RouterConnection = { session, closeWire: () => wire.close(), requests: 0 }; this.connections.add(row);
        const release = () => { void this.release(row).catch(error => console.error('[CocosMCP release]', String(error))); };
        response.once('close', release); request.once('end', () => { response.end(); release(); }); request.once('error', release);
      } catch (error) { await session?.close(); throw error; }
      finally { this.initializing--; this.idleSince = performance.now(); }
      return;
    }
    if (request.url !== '/mcp') { this.reply(response, 404, { error: 'Use /mcp' }); request.resume(); return; }
    if (!['GET', 'POST', 'DELETE'].includes(request.method ?? '')) { this.reply(response, 405, { error: 'Use GET, POST or DELETE' }); request.resume(); return; }
    let body: unknown;
    if (request.method === 'POST') {
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) { this.reply(response, 415, { error: 'Use application/json' }); request.resume(); return; }
      body = await this.body(request);
    }
    const id = request.headers['mcp-session-id']; let row = typeof id === 'string' ? this.httpSessions.get(id) : undefined;
    if (!row && id !== undefined) { this.reply(response, 404, { error: 'Unknown MCP session; initialize a new connection, do not replay writes' }); return; }
    if (!row) {
      if (request.method !== 'POST' || !body || typeof body !== 'object' || !('method' in body) || body.method !== 'initialize') {
        this.reply(response, 400, { jsonrpc: '2.0', id: body && typeof body === 'object' && 'id' in body ? body.id : null, error: { code: -32600, message: 'Initialize a stateful MCP connection first' } }); return;
      }
      if (this.connections.size + this.initializing >= 512) { this.reply(response, 503, { error: 'Router session capacity reached' }); return; }
      this.initializing++;
      try {
        const session = await this.session(installation, worker, this.workspace(request));
        try {
          const { NodeStreamableHTTPServerTransport } = await this.sessionModule!;
          const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: sessionId => { this.httpSessions.set(sessionId, current); },
            onsessionclosed: sessionId => { this.httpSessions.delete(sessionId); void this.release(current).catch(error => console.error('[CocosMCP HTTP release]', String(error))); } });
          const server = session.factory.create(); await server.connect(transport);
          const current: HttpConnection = { session, requests: 0, closeWire: () => server.close(), handle: (req, res, value) => transport.handleRequest(req, res, value) };
          row = current; this.connections.add(current);
          const previousClose = transport.onclose;
          transport.onclose = () => { previousClose?.(); if (transport.sessionId) this.httpSessions.delete(transport.sessionId); void this.release(current).catch(error => console.error('[CocosMCP HTTP close]', String(error))); };
        } catch (error) { await session.close(); throw error; }
      } finally { this.initializing--; }
    }
    row.requests++;
    try { await row.handle(request, response, body); }
    finally {
      row.requests--; this.idleSince = performance.now();
      // 初始化被拒绝时不存在可再次使用的会话，不能留下无人可释放的连接。
      if (![...this.httpSessions.values()].includes(row) && request.method === 'POST') await this.release(row);
    }
  }
  start(installation: string, workspace: ProjectPaths, worker: string, port = 0, persistent = false): Promise<string> {
    if (this.draining) return Promise.reject(new Error('Router is closing'));
    return this.starting ??= this.listen(installation, workspace, worker, port, persistent);
  }
  private async listen(installation: string, workspace: ProjectPaths, worker: string, port: number, persistent: boolean): Promise<string> {
    const policy = await new ClientPolicies().load(await ProjectPaths.open(installation));
    const connections = await new RouterRuntime().connections(workspace, worker);
    this.lease = await connections.claim('http', 'client');
    try {
      const token = this.lease.token();
      this.server = createServer((request, response) => {
        void this.handle(request, response, installation, worker, token).catch(error => {
          console.error('[CocosMCP router]', error instanceof Error ? error.message : String(error));
          if (!response.headersSent) this.reply(response, 400, { error: 'Invalid router request' }); else response.destroy();
        });
      });
      // 长连接不受 HTTP 请求超时回收；每条 MCP 消息由 SDK 单独限长。
      this.server.requestTimeout = 0;
      const server = this.server;
      await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept(); }); });
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing router listener');
      const endpoint = `http://127.0.0.1:${address.port}/mcp`; await this.lease.publish(endpoint);
      if (!persistent) this.timer = setInterval(() => {
        if (this.connections.size || this.initializing) { this.idleSince = performance.now(); return; }
        if (performance.now() - this.idleSince >= policy.idleExitSeconds * 1000) void this.close().catch(error => console.error('[CocosMCP idle close]', String(error)));
      }, Math.min(1000, policy.idleExitSeconds * 1000));
      return endpoint;
    } catch (error) { await this.shutdown(); throw error; }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.draining = true; await this.starting?.catch(() => {}); await this.shutdown();
    })();
  }
  private async shutdown(): Promise<void> {
    this.draining = true; clearInterval(this.timer);
    while (this.initializing) await new Promise(resolve => setTimeout(resolve, 20));
    await Promise.all([...this.connections].map(row => this.release(row)));
    this.server?.closeAllConnections();
    if (this.server?.listening) await new Promise<void>((accept, reject) => this.server!.close(error => error ? reject(error) : accept()));
    await this.lease?.close();
  }
}

class RouterDaemonEntry {
  async run(): Promise<void> {
    const { values } = parseArgs({ options: { installation: { type: 'string' }, workspace: { type: 'string' }, worker: { type: 'string' }, port: { type: 'string' }, persistent: { type: 'boolean' } } });
    if (!values.installation || !values.workspace || !values.worker) throw new Error('Missing installation, workspace or worker');
    const port = Number(values.port ?? 0); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid loopback port');
    const workspace = await ProjectPaths.open(values.workspace); Object.assign(process.env, workspace.environment());
    const daemon = new RouterDaemon();
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void daemon.close().catch(error => console.error(String(error))); });
    const endpoint = await daemon.start(values.installation, workspace, values.worker, port, values.persistent);
    console.error('[CocosMCP router] Listening:', endpoint);
  }
}
void new RouterDaemonEntry().run().catch(error => { console.error('[CocosMCP router]', String(error)); process.exitCode = 1; });
