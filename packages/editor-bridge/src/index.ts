import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync, readdirSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { CocosError, Json, type BridgeDescriptor, type BridgeRequest, type EditorAdapter, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { Operations } from '../../capability-catalog/src/operations.js';
import type { PanelState } from './panel-state.js';

interface LedgerEntry { fingerprint: string; status: 'pending' | 'completed' | 'failed'; result?: JsonValue; revision?: string; error?: JsonValue }

export class EditorBridge {
  private server: Server | undefined;
  private descriptor: BridgeDescriptor | undefined;
  private tail = Promise.resolve();
  private readonly events: JsonObject[] = [];
  private sequence = 0;
  private readonly logEpoch = randomBytes(16).toString('hex');
  private readonly catalog = new Map(new Operations().list().map(row => [row.id, row]));

  constructor(private readonly adapter: EditorAdapter, private readonly projectPath: string, private readonly editorVersion: string) {}

  private safePath(path: string): string {
    const root = realpathSync(this.projectPath);
    const target = resolve(root, path);
    const contains = (value: string): boolean => { const rel = relative(root, value); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
    if (!contains(target)) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Path escapes project');
    let ancestor = target;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (!contains(realpathSync(ancestor))) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Symlink escapes project');
    return target;
  }

  private assetUrl(url: string): void {
    if (!url.startsWith('db://assets/') || url.includes('\\') || url.includes('\0')) throw new CocosError('INVALID_ARGUMENT', 'Expected db://assets/ URL');
    const suffix = url.slice('db://assets/'.length);
    if (suffix.split('/').some(part => part === '..' || part === '.')) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Invalid asset path');
    this.safePath(join('assets', suffix));
  }

  private validatePaths(request: BridgeRequest): void {
    const capability = this.catalog.get(request.capabilityId);
    if (!capability) return;
    if (capability.effect === 'asset' || request.capabilityId === 'scene.create') {
      for (const key of ['url', 'sourceUrl', 'targetUrl']) {
        const value = request.params[key]; if (typeof value === 'string') this.assetUrl(value);
      }
    }
    if (request.params.sourcePath) this.safePath(Json.string(request.params.sourcePath, 'sourcePath'));
  }

  log(level: string, message: string, source = 'editor-bridge'): void {
    this.events.push({ sequence: ++this.sequence, level, message, source, occurredAt: new Date().toISOString() });
    if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000);
  }

  panelState(cursor?: string): PanelState {
    const descriptor = this.descriptor;
    let after = 0, reset = true;
    try {
      const parsed = JSON.parse(cursor ?? '') as { epoch?: string; sequence?: number };
      if (parsed.epoch === this.logEpoch && Number.isInteger(parsed.sequence) && parsed.sequence! >= 0 && parsed.sequence! <= this.sequence) { after = parsed.sequence!; reset = false; }
    } catch { /* 无游标或游标损坏时返回完整有界快照。 */ }
    // 状态查询不读取场景 revision：新工程尚未打开场景也必须能显示控制中心。
    return {
      projectPath: realpathSync(this.projectPath), editorVersion: this.editorVersion, creatorMajor: this.adapter.major,
      instance: descriptor ? {
        protocolVersion: descriptor.protocolVersion, projectId: descriptor.projectId, projectPath: descriptor.projectPath,
        instanceId: descriptor.instanceId, editorVersion: descriptor.editorVersion, creatorMajor: descriptor.creatorMajor,
        endpoint: descriptor.endpoint, pid: descriptor.pid, startedAt: descriptor.startedAt,
      } : null,
      supportedCapabilities: this.adapter.supportedCapabilities(),
      // 面板在有界日志快照上筛选和分页，不能提前截断而隐藏历史错误。
      logs: this.events.filter(row => Number(row.sequence) > after).map(row => ({ ...row })),
      logWindow: { epoch: this.logEpoch, cursor: this.sequence, droppedBefore: this.events.length ? Number(this.events[0]!.sequence) - 1 : 0, reset },
      runtimeConfigured: this.hasRuntimeConfiguration(),
    };
  }

  async panelStateWithRuntime(cursor?: string): Promise<PanelState> {
    const state = this.panelState(cursor);
    const directory = this.safePath('.codex-work/cache/cocos-mcp');
    const rows = existsSync(directory) ? readdirSync(directory).filter(name => /^runtime-\d+\.json$/.test(name)) : [];
    let connected = 0;
    const errors: string[] = [];
    for (const name of rows) {
      if (!this.runtimeProcessExists(name)) continue;
      try {
        const config = JSON.parse(readFileSync(this.safePath(join(directory, name)), 'utf8'));
        const projectId = createHash('sha256').update(realpathSync(this.projectPath)).digest('hex').slice(0, 24);
        if (config.projectId !== projectId || !/^http:\/\/127\.0\.0\.1:\d+$/.test(config.url) || typeof config.token !== 'string') continue;
        // 凭证仅在主进程使用；短超时避免已退出网关拖住面板刷新。
        const count = await new Promise<number>((accept, reject) => {
          const request = httpRequest(`${config.url}/runtime/sessions`, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' } }, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) request.destroy(new Error('Runtime response too large')); });
            response.on('error', reject);
            response.on('end', () => {
              try {
                const result = JSON.parse(body);
                if (response.statusCode !== 200 || !Array.isArray(result.rows)) throw new Error('Runtime session query failed');
                accept(result.rows.length);
              } catch (error) { reject(error); }
            });
          });
          request.setTimeout(1500, () => request.destroy(new Error('Runtime gateway timeout')));
          request.on('error', reject);
          request.end(JSON.stringify({ projectId }));
        });
        connected += count;
      } catch {
        // 网关可能在查询期间退出；残留文件不应盖过其他健康网关的状态。
        if (this.runtimeProcessExists(name)) errors.push('运行时网关查询失败，请检查 MCP 服务版本及运行状态');
      }
    }
    state.runtimeConfigured = this.hasRuntimeConfiguration();
    state.runtimeStatus = { connected, error: errors.length ? errors[0]! : null };
    return state;
  }

  private runtimeProcessExists(name: string): boolean {
    const match = /^runtime-(\d+)\.json$/.exec(name);
    const pid = Number(match?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) {
      // 只有 ESRCH 能确认进程退出；EPERM 等错误不能当作失效配置隐藏。
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private hasRuntimeConfiguration(): boolean {
    const directory = this.safePath('.codex-work/cache/cocos-mcp');
    if (!existsSync(directory)) return false;
    return readdirSync(directory).some(name => {
      if (!this.runtimeProcessExists(name)) return false;
      try {
        const config = JSON.parse(readFileSync(this.safePath(join(directory, name)), 'utf8')) as { projectId?: string; url?: string };
        const projectId = createHash('sha256').update(realpathSync(this.projectPath)).digest('hex').slice(0, 24);
        // 文件存在只说明网关配置就绪，不代表有游戏运行实例连接。
        return config.projectId === projectId && /^http:\/\/127\.0\.0\.1:\d+$/.test(config.url ?? '');
      } catch { return false; }
    });
  }

  private ledgerPath(operationId: string): string {
    const descriptor = this.descriptor!;
    return this.safePath(join('.codex-work', 'cache', 'cocos-mcp', 'operations', descriptor.instanceId,
      `${createHash('sha256').update(operationId).digest('hex')}.json`));
  }

  private writeLedger(path: string, entry: LedgerEntry): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.writing`;
    writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 }); renameSync(temporary, path);
  }

  private async perform(request: BridgeRequest): Promise<JsonValue> {
    const descriptor = this.descriptor!;
    if (request.protocolVersion !== 1 || request.projectId !== descriptor.projectId || request.instanceId !== descriptor.instanceId) throw new CocosError('UNAUTHORIZED', 'Bridge instance does not match');
    if (request.capabilityId === 'bridge.describe') return { result: { supportedCapabilities: this.adapter.supportedCapabilities(), editorVersion: this.editorVersion }, revision: await this.adapter.revision() };
    if (request.capabilityId === 'bridge.operation') {
      const path = this.ledgerPath(Json.string(request.params.operationId, 'operationId'));
      if (!existsSync(path)) throw new CocosError('NOT_FOUND', 'Operation record not found');
      return { result: JSON.parse(readFileSync(path, 'utf8')) as JsonValue, revision: await this.adapter.revision() };
    }
    const capability = this.catalog.get(request.capabilityId);
    if (!capability || !this.adapter.supportedCapabilities().includes(request.capabilityId)) throw new CocosError('UNSUPPORTED_CAPABILITY', `Not supported by this editor: ${request.capabilityId}`);
    this.validatePaths(request);
    if (request.capabilityId === 'console.query') {
      // 控制台诊断必须在场景脚本加载失败时仍可用；它不依赖场景 revision 或操作账本。
      if (request.expectedRevision !== undefined) throw new CocosError('INVALID_ARGUMENT', 'Console queries do not accept a scene revision');
      return { result: await this.adapter.execute(request.capabilityId, request.params), revision: '' };
    }
    const fingerprint = createHash('sha256').update(Json.canonical({ capabilityId: request.capabilityId, params: request.params, expectedRevision: request.expectedRevision ?? null })).digest('hex');
    const ledger = this.ledgerPath(Json.string(request.operationId, 'operationId'));
    if (existsSync(ledger)) {
      const previous = JSON.parse(readFileSync(ledger, 'utf8')) as LedgerEntry;
      if (previous.fingerprint !== fingerprint) throw new CocosError('OPERATION_CONFLICT', 'operationId was used with different arguments');
      if (previous.status === 'completed') return { result: previous.result ?? null, revision: previous.revision ?? '' };
      if (previous.status === 'failed') { const error = Json.object(previous.error); throw new CocosError(error.code as CocosError['code'], String(error.message)); }
      throw new CocosError('OUTCOME_UNKNOWN', 'This operation was interrupted; verify editor state before submitting a new operation');
    }
    const revision = await this.adapter.revision();
    if (request.expectedRevision !== undefined && request.expectedRevision !== revision) throw new CocosError('STALE_REVISION', 'Scene changed after it was read', { actualRevision: revision });
    this.writeLedger(ledger, { fingerprint, status: 'pending' });
    try {
      let result: JsonValue;
      if (request.capabilityId === 'logs.query') {
        const cursor = Number(request.params.cursor ?? 0);
        const rows = this.events.filter(event => Number(event.sequence) > cursor && (!request.params.level || request.params.level === event.level)).slice(0, Number(request.params.limit ?? 100));
        result = { rows, nextCursor: rows.length ? rows[rows.length - 1]!.sequence! : cursor, droppedBefore: this.events.length ? Number(this.events[0]!.sequence) - 1 : 0 };
      } else result = await this.adapter.execute(request.capabilityId, request.params);
      if (request.capabilityId !== 'logs.query') this.log('info', `${request.capabilityId} completed`);
      const nextRevision = await this.adapter.revision();
      this.writeLedger(ledger, { fingerprint, status: 'completed', result, revision: nextRevision });
      return { result, revision: nextRevision };
    } catch (error) {
      const failure = CocosError.from(error, 'EDITOR_ERROR');
      this.log('error', `${request.capabilityId} failed (${failure.code})`);
      this.writeLedger(ledger, { fingerprint, status: 'failed', error: Json.value(failure.toJSON()) });
      throw failure;
    }
  }

  private authorized(request: IncomingMessage): boolean {
    if (request.headers.origin) return false;
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${this.descriptor!.token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, value: unknown): void => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (!this.authorized(request)) { reply(403, { error: { code: 'UNAUTHORIZED', message: 'Bridge authentication failed' } }); return; }
    if (request.method !== 'POST' || request.url !== '/rpc') { reply(404, { error: { code: 'NOT_FOUND', message: 'Use POST /rpc' } }); return; }
    const chunks: Buffer[] = []; let size = 0;
    try {
      const body = await new Promise<BridgeRequest>((accept, reject) => {
        request.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) { reject(new CocosError('INVALID_ARGUMENT', 'Request exceeds bridge body limit')); request.destroy(); return; }
          chunks.push(chunk);
        });
        request.on('error', reject);
        request.on('end', () => { try { accept(Json.object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) as unknown as BridgeRequest); } catch (error) { reject(error); } });
      });
      Json.object(body.params, 'params');
      const task = this.tail.then(() => this.perform(body));
      this.tail = task.then(() => undefined, () => undefined);
      reply(200, await task);
    } catch (error) { if (!response.destroyed) reply(400, { error: CocosError.from(error, 'EDITOR_ERROR').toJSON() }); }
  }

  async start(): Promise<BridgeDescriptor> {
    if (this.descriptor) return this.descriptor;
    const root = realpathSync(this.projectPath);
    const instanceId = randomBytes(12).toString('hex');
    this.server = createServer((request, response) => { void this.handle(request, response); });
    const server = this.server;
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); accept(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new CocosError('INTERNAL_ERROR', 'Bridge did not bind a TCP port');
    this.descriptor = { protocolVersion: 1, projectId: createHash('sha256').update(root).digest('hex').slice(0, 24), projectPath: root,
      instanceId, editorVersion: this.editorVersion, creatorMajor: this.adapter.major, endpoint: `http://127.0.0.1:${address.port}/rpc`,
      token: randomBytes(32).toString('hex'), pid: process.pid, startedAt: new Date().toISOString() };
    const path = this.safePath(join('.codex-work/cache/cocos-mcp/instances', `${instanceId}.json`));
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(this.descriptor, null, 2), { mode: 0o600 });
    this.log('info', 'Editor bridge started'); return this.descriptor;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((accept, reject) => this.server!.close(error => error ? reject(error) : accept()));
    if (this.descriptor) {
      const path = this.safePath(join('.codex-work/cache/cocos-mcp/instances', `${this.descriptor.instanceId}.json`));
      if (existsSync(path)) unlinkSync(path);
    }
    await this.adapter.dispose(); this.server = undefined; this.descriptor = undefined;
  }
}
