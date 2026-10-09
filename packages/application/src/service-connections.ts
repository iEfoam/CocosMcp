import { createServer, request, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, rmdir, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { URL } from 'node:url';
import { CocosError } from '../../contracts/src/index.js';
import { ProjectPaths } from './paths.js';

export interface ServiceDescriptor {
  schemaVersion: 1; projectId: string; projectPath: string; serviceId: string; pid: number;
  startedAt: string; transport: 'stdio' | 'http'; owner: 'client' | 'extension';
  status: 'starting' | 'running'; endpoint: string | null; identityEndpoint: string; tokenFile: string;
}

/** 工程接入配置与服务租约共用一个边界，不能用面板内存或 PID 代替服务身份。 */
export class ServiceConnections {
  readonly projectId: string;
  constructor(readonly paths: ProjectPaths) { this.projectId = createHash('sha256').update(paths.root).digest('hex').slice(0, 24); }
  private async path(name: string): Promise<string> { return this.paths.resolve(join('.codex-work/cache/cocos-mcp', name)); }
  private async json(name: string): Promise<unknown | null> {
    const path = await this.path(name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new CocosError('VERIFICATION_FAILED', 'Invalid MCP connection file', { name });
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async atomic(name: string, value: unknown): Promise<void> {
    const target = await this.path(name);
    try { const info = await lstat(target); if (info.isSymbolicLink() || !info.isFile()) throw new CocosError('VERIFICATION_FAILED', 'Connection target must be a regular file', { name }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // 临时文件保持在工程 tmp；rename 同盘原子替换，读取方不会看到半份 JSON。
    const directory = await this.paths.work('tmp', `mcp-connection-${randomUUID()}`), temporary = join(directory, 'connection.json');
    try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); await rmdir(directory); }
  }
  async port(): Promise<number> {
    const value = await this.json('connection.json') as { schemaVersion?: unknown; http?: { port?: unknown } } | null;
    if (!value) return 0;
    if (value.schemaVersion !== 1 || !Number.isInteger(value.http?.port) || Number(value.http?.port) < 0 || Number(value.http?.port) > 65535) throw new CocosError('VERIFICATION_FAILED', 'Invalid saved MCP port');
    return Number(value.http!.port);
  }
  async savePort(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CocosError('INVALID_ARGUMENT', 'MCP port must be an integer from 0 to 65535');
    await this.paths.work('cache', 'cocos-mcp');
    await this.atomic('connection.json', { schemaVersion: 1, http: { port } });
  }
  async configurePort(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CocosError('INVALID_ARGUMENT', 'MCP port must be an integer from 0 to 65535');
    // 设置端口也走启动租约，避免另一客户端在检查后启动、导致配置和实际地址不同。
    const lease = await this.claim('http', 'extension');
    try { await this.savePort(port); } finally { await lease.close(); }
  }
  async token(tokenFile = '.codex-work/cache/cocos-mcp/mcp-http-token', create = true): Promise<string> {
    const path = await this.paths.resolve(tokenFile);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new CocosError('VERIFICATION_FAILED', 'Invalid MCP token file');
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await writeFile(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure; }
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new CocosError('VERIFICATION_FAILED', 'Invalid MCP token file');
    const token = (await readFile(path, 'utf8')).trim();
    if (token.length < 32 || token.length > 4096 || /[\r\n]/.test(token)) throw new CocosError('VERIFICATION_FAILED', 'Invalid MCP authentication token');
    return token;
  }
  alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
  private descriptor(value: unknown): ServiceDescriptor {
    const row = value as ServiceDescriptor | null;
    if (!row || row.schemaVersion !== 1 || row.projectPath !== this.paths.root || row.projectId !== this.projectId ||
      !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(row.serviceId ?? '') || !Number.isInteger(row.pid) || row.pid < 1 ||
      !['http', 'stdio'].includes(row.transport) || !['client', 'extension'].includes(row.owner) || !['starting', 'running'].includes(row.status) ||
      typeof row.tokenFile !== 'string' || typeof row.startedAt !== 'string' || !row.startedAt.endsWith('Z') || !Number.isFinite(Date.parse(row.startedAt)) || !this.local(row.identityEndpoint, '/identity') ||
      (row.transport === 'http' && row.status === 'running' ? !this.local(row.endpoint, '/mcp') : row.endpoint !== null)) throw new CocosError('VERIFICATION_FAILED', 'MCP service descriptor does not match this project');
    return row;
  }
  private local(value: unknown, path: string): boolean {
    try { const url = new URL(String(value)); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port) && !url.username && !url.password && !url.search && !url.hash && url.pathname === path; }
    catch { return false; }
  }
  async active(): Promise<ServiceDescriptor | null> {
    const value = await this.json('service.json');
    if (!value) return null;
    const row = this.descriptor(value);
    if (!this.alive(row.pid)) return null;
    try {
      const token = await this.token(row.tokenFile, false);
      // Creator 2/早期 Creator 3 的 Electron 没有 fetch/AbortSignal，主进程使用原生 HTTP。
      const value = await new Promise<unknown>((accept, reject) => {
        const call = request(row.identityEndpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, response => {
          const chunks: Buffer[] = []; let size = 0;
          response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024) call.destroy(new Error('Identity response too large')); else chunks.push(chunk); });
          response.on('error', reject);
          response.on('end', () => { try { if (response.statusCode !== 200) throw new Error('Identity denied'); accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
        });
        const timeout = setTimeout(() => call.destroy(new Error('Identity timed out')), 1500);
        call.once('close', () => clearTimeout(timeout)); call.once('error', reject); call.end('{}');
      });
      const actual = this.descriptor(value);
      if (actual.serviceId === row.serviceId && actual.pid === row.pid && actual.identityEndpoint === row.identityEndpoint && actual.transport === row.transport && actual.owner === row.owner && actual.endpoint === row.endpoint && actual.status === row.status) return actual;
    } catch { /* 存活但身份无法核实的进程不能被接管或停止。 */ }
    throw new CocosError('RESOURCE_BUSY', 'MCP service PID is alive but its authenticated identity is unavailable; retry after the owner recovers');
  }
  async claim(transport: 'http' | 'stdio', owner: 'client' | 'extension', tokenFile?: string): Promise<ServiceLease> {
    await this.paths.work('cache', 'cocos-mcp');
    const lease = new ServiceLease(this, transport, owner, tokenFile);
    const lock = await this.path('service.lock');
    try {
      await lease.startIdentity();
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await mkdir(lock, { mode: 0o700 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if ((await lstat(lock)).isSymbolicLink()) throw new CocosError('VERIFICATION_FAILED', 'Service lock must not be a symbolic link');
          await this.recover(lock); continue;
        }
        lease.ownsLock = true;
        await this.atomic('service.lock/owner.json', lease.snapshot());
        await this.legacyGateway();
        await lease.publish(null, 'starting');
        return lease;
      }
      throw new CocosError('RESOURCE_BUSY', 'MCP service startup is already in progress');
    } catch (error) { await lease.close(); throw error; }
  }
  private async recover(lock: string): Promise<void> {
    // 锁内的恢复目录串行化历史租约回收，防止两个启动者删除对方刚获得的锁。
    const recovery = await this.path('service.lock/recovery');
    try { await mkdir(recovery); }
    catch (error) { if (['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new CocosError('RESOURCE_BUSY', 'MCP service startup/recovery is in progress'); throw error; }
    let stale = false;
    try {
      const value = await this.json('service.lock/owner.json');
      if (!value) throw new CocosError('RESOURCE_BUSY', 'MCP service startup lock is not ready');
      const owner = this.descriptor(value);
      if (this.alive(owner.pid)) {
        const active = await this.active();
        throw new CocosError('RESOURCE_BUSY', active?.owner === 'client' ? '此工程的 MCP 服务由 AI 客户端管理，请使用已有连接' : '此工程已有 MCP 服务，请使用已有连接');
      }
      await this.removeOwned('service.json', owner.serviceId);
      await this.removeOwned('service.lock/owner.json', owner.serviceId);
      stale = true;
    } finally { await rmdir(recovery); }
    if (stale) await rmdir(lock);
  }
  private async legacyGateway(): Promise<void> {
    for (const name of await readdir(await this.path(''))) {
      const match = /^runtime-(\d+)\.json$/.exec(name);
      // 旧版网关没有服务租约，兼容保留其归属；不能为了新接入抢占它。
      if (match && Number(match[1]) > 0 && this.alive(Number(match[1]))) throw new CocosError('RESOURCE_BUSY', '此工程已有运行时网关，请先停止外部 MCP 服务，避免重复启动');
    }
  }
  async removeOwned(name: string, serviceId: string): Promise<void> {
    const row = await this.json(name) as { serviceId?: unknown } | null;
    if (row?.serviceId === serviceId) await unlink(await this.path(name));
  }
  async release(serviceId: string): Promise<void> {
    await this.removeOwned('service.json', serviceId);
    const value = await this.json('service.lock/owner.json') as { serviceId?: unknown } | null;
    if (!value || value.serviceId === serviceId) {
      if (value) await this.removeOwned('service.lock/owner.json', serviceId);
      await rmdir(await this.path('service.lock'));
    }
  }
}

export class ServiceLease {
  ownsLock = false;
  readonly tokenFile: string;
  private server: Server | undefined;
  private readonly descriptor: ServiceDescriptor;
  private tokenValue = '';
  private closed = false;
  constructor(private readonly connections: ServiceConnections, transport: 'http' | 'stdio', owner: 'client' | 'extension', tokenFile = '.codex-work/cache/cocos-mcp/mcp-http-token') {
    this.tokenFile = tokenFile;
    this.descriptor = { schemaVersion: 1, projectId: connections.projectId, projectPath: connections.paths.root, serviceId: randomUUID(), pid: process.pid,
      startedAt: new Date().toISOString(), transport, owner, status: 'starting', endpoint: null, identityEndpoint: '', tokenFile };
  }
  snapshot(): ServiceDescriptor { return { ...this.descriptor }; }
  token(): string { return this.tokenValue; }
  async startIdentity(): Promise<void> {
    this.tokenValue = await this.connections.token(this.tokenFile);
    this.server = createServer((request, response) => {
      const reply = (status: number, body: unknown): void => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
      try {
        const host = new URL(`http://${request.headers.host ?? ''}`).hostname;
        const origin = request.headers.origin ? new URL(request.headers.origin) : null;
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host) || (origin && (!['http:', 'https:'].includes(origin.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))) { reply(403, { error: 'Local connection required' }); return; }
        if (request.method !== 'POST' || request.url !== '/identity') { reply(405, { error: 'Use POST /identity' }); return; }
        const actual = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${this.tokenValue}`);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { reply(401, { error: 'Bearer token required' }); return; }
        reply(200, this.snapshot());
      } catch { reply(400, { error: 'Invalid identity request' }); }
      // 身份入口不消费请求体，也不执行任何工程操作。
      request.resume();
    });
    const server = this.server;
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); accept(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Service identity listener unavailable');
    this.descriptor.identityEndpoint = `http://127.0.0.1:${address.port}/identity`;
  }
  async publish(endpoint: string | null, status: 'starting' | 'running' = 'running'): Promise<void> {
    this.descriptor.endpoint = endpoint; this.descriptor.status = status;
    await this.connections.atomic('service.json', this.snapshot());
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    try { if (this.server?.listening) { this.server.closeAllConnections(); await new Promise<void>((accept, reject) => this.server!.close(error => error ? reject(error) : accept())); } }
    finally { if (this.ownsLock) await this.connections.release(this.descriptor.serviceId); }
  }
}
