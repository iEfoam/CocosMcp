import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import type { RuntimeExecutor } from './index.js';
import type { ProjectRegistry } from './registry.js';

interface Command { id: string; capabilityId: string; params: JsonObject }
interface Pending { resolve(value: JsonValue): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface RuntimeSession { id: string; projectId: string; version: string; platform: string; lastSeen: string; commands: Command[]; wake?: () => void }

export class RuntimeGateway implements RuntimeExecutor {
  private server: Server | undefined;
  private readonly tokens = new Map<string, string>();
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly pending = new Map<string, Pending>();
  private readonly configPaths: string[] = [];

  constructor(private readonly projects: ProjectRegistry, private readonly timeoutMs = 30_000) {}

  async start(port = 0): Promise<number> {
    this.server = createServer((request, response) => { void this.handle(request, response); });
    const server = this.server;
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Runtime gateway did not bind');
    for (const project of this.projects.list().rows) {
      const token = randomBytes(32).toString('hex'); this.tokens.set(project.projectId, token);
      const directory = await this.projects.paths(project.projectId).work('cache', 'cocos-mcp');
      const path = join(directory, `runtime-${process.pid}.json`); this.configPaths.push(path);
      await writeFile(path, JSON.stringify({ projectId: project.projectId, url: `http://127.0.0.1:${address.port}`, token }, null, 2), { mode: 0o600 });
    }
    return address.port;
  }

  list(projectId: string): JsonValue {
    this.projects.paths(projectId);
    return { rows: [...this.sessions.values()].filter(session => session.projectId === projectId && Date.now() - Date.parse(session.lastSeen) < 30_000).map(session => ({ runtimeInstanceId: session.id, version: session.version, platform: session.platform, lastSeen: session.lastSeen })) };
  }

  async execute(projectId: string, runtimeInstanceId: string | undefined, capabilityId: string, params: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
    const rows = [...this.sessions.values()].filter(session => session.projectId === projectId && (!runtimeInstanceId || session.id === runtimeInstanceId));
    if (!rows.length) throw new CocosError('CONTEXT_UNAVAILABLE', 'No matching development runtime is connected');
    if (rows.length > 1) throw new CocosError('AMBIGUOUS_TARGET', 'Specify runtimeInstanceId when several runtimes are connected');
    if (signal?.aborted) throw new CocosError('CANCELLED', 'Runtime operation cancelled');
    const session = rows[0]!; const id = randomUUID();
    return new Promise((accept, reject) => {
      const cancel = (): void => finish(new CocosError('OUTCOME_UNKNOWN', 'Runtime call interrupted; its side effects may have occurred'));
      const finish = (error?: Error, result?: JsonValue): void => {
        const pending = this.pending.get(id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(id); signal?.removeEventListener('abort', cancel);
        session.commands = session.commands.filter(command => command.id !== id);
        if (error) reject(error); else accept(result ?? null);
      };
      const timer = setTimeout(() => finish(new CocosError('OUTCOME_UNKNOWN', 'Runtime did not reply before timeout')), this.timeoutMs);
      this.pending.set(id, { resolve: result => finish(undefined, result), reject: error => finish(error), timer });
      signal?.addEventListener('abort', cancel, { once: true });
      session.commands.push({ id, capabilityId, params }); session.wake?.();
    });
  }

  private async body(request: IncomingMessage): Promise<JsonObject> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += data.length;
      if (size > 32 * 1024 * 1024) throw new CocosError('INVALID_ARGUMENT', 'Runtime message exceeds configured body limit');
      chunks.push(data);
    }
    return Json.object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, result: unknown): void => { if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result)); } };
    try {
      const origin = request.headers.origin;
      if (origin) {
        const parsed = new URL(origin);
        if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new CocosError('UNAUTHORIZED', 'Only local preview origins are allowed');
        response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'POST'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); reply(204, null); return;
      }
      if (request.method !== 'POST') { reply(405, { error: { code: 'INVALID_ARGUMENT', message: 'POST required' } }); return; }
      const body = await this.body(request); const projectId = Json.string(body.projectId, 'projectId');
      const token = this.tokens.get(projectId); const provided = Buffer.from(request.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${token ?? ''}`);
      if (!token || provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new CocosError('UNAUTHORIZED', 'Runtime authentication failed');
      if (request.url === '/runtime/sessions') { reply(200, this.list(projectId)); return; }
      if (request.url === '/runtime/register') {
        const session: RuntimeSession = { id: randomUUID(), projectId, version: String(body.version ?? 'unknown'), platform: String(body.platform ?? 'unknown'), lastSeen: new Date().toISOString(), commands: [] };
        this.sessions.set(session.id, session); reply(200, { runtimeInstanceId: session.id }); return;
      }
      const session = this.sessions.get(Json.string(body.runtimeInstanceId, 'runtimeInstanceId'));
      if (!session || session.projectId !== projectId) throw new CocosError('UNAUTHORIZED', 'Runtime session is unavailable');
      session.lastSeen = new Date().toISOString();
      if (request.url === '/runtime/poll') {
        if (!session.commands.length) await new Promise<void>(accept => {
          const timer = setTimeout(() => { delete session.wake; accept(); }, 5000);
          session.wake = () => { clearTimeout(timer); delete session.wake; accept(); };
        });
        reply(200, { command: session.commands.shift() ?? null }); return;
      }
      if (request.url === '/runtime/reply') {
        const id = Json.string(body.commandId, 'commandId'); const pending = this.pending.get(id);
        if (pending) {
          if (body.error) { const error = Json.object(body.error); pending.reject(new CocosError('RUNTIME_ERROR', String(error.message), body.error)); }
          else pending.resolve(body.result ?? null);
        }
        reply(200, { accepted: Boolean(pending) }); return;
      }
      if (request.url === '/runtime/disconnect') { session.wake?.(); this.sessions.delete(session.id); reply(200, { disconnected: true }); return; }
      reply(404, { error: { code: 'NOT_FOUND', message: 'Unknown runtime endpoint' } });
    } catch (error) { const failure = CocosError.from(error); reply(failure.code === 'UNAUTHORIZED' ? 403 : 400, { error: failure.toJSON() }); }
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.wake?.();
    for (const pending of this.pending.values()) pending.reject(new CocosError('CANCELLED', 'Runtime gateway stopped'));
    this.sessions.clear();
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>((accept, reject) => this.server!.close(error => error ? reject(error) : accept())); }
    for (const path of this.configPaths) await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}
