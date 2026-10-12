import { performance } from 'node:perf_hooks';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import type { ServiceClientControl } from '../../../packages/application/src/service-connections.js';

interface ClientLease { secret: string; seen: number }

/** 客户端租约与工程任务分别计数；首个客户端退出不能取消其他会话或后台构建。 */
export class SharedWorkerLifecycle implements ServiceClientControl {
  private readonly clients = new Map<string, ClientLease>();
  private requests = 0;
  private idleSince: number;
  private draining = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly ttlMs = 60_000, private readonly idleMs = 90_000, private readonly now = () => performance.now()) { this.idleSince = now(); }
  private expire(): void { for (const [id, row] of this.clients) if (this.now() - row.seen >= this.ttlMs) this.clients.delete(id); }
  handle(route: string, body: JsonObject): JsonValue {
    this.expire();
    if (route === '/clients/status') return { clients: this.clients.size, requests: this.requests, draining: this.draining };
    if (this.draining) throw new CocosError('RESOURCE_BUSY', 'Shared backend is closing; reconnect after its lease is released');
    const id = Json.string(body.clientId, 'clientId');
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(id)) throw new CocosError('INVALID_ARGUMENT', 'Invalid clientId');
    if (route === '/clients/register') {
      if (this.clients.has(id)) throw new CocosError('OPERATION_CONFLICT', 'Client lease already exists');
      if (this.clients.size >= 512) throw new CocosError('RESOURCE_BUSY', 'Too many connected clients');
      const secret = randomBytes(32).toString('hex'); this.clients.set(id, { secret, seen: this.now() }); this.idleSince = this.now();
      return { clientId: id, leaseToken: secret, leaseTtlMs: this.ttlMs };
    }
    const row = this.authenticate(id, Json.string(body.leaseToken, 'leaseToken'));
    if (route === '/clients/heartbeat') { row.seen = this.now(); this.idleSince = this.now(); return { renewed: true }; }
    if (route === '/clients/release') { this.clients.delete(id); this.idleSince = this.now(); return { released: true }; }
    throw new CocosError('NOT_FOUND', 'Unknown client control route');
  }
  private authenticate(id: string, secret: string): ClientLease {
    const row = this.clients.get(id), provided = Buffer.from(secret), expected = Buffer.from(row?.secret ?? '');
    if (!row || provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new CocosError('UNAUTHORIZED', 'Client lease expired or does not match');
    return row;
  }
  acquire(request: Pick<IncomingMessage, 'headers'>): () => void {
    this.expire();
    if (this.draining) throw new CocosError('RESOURCE_BUSY', 'Shared backend is closing');
    const id = request.headers['x-cocos-client-id'], secret = request.headers['x-cocos-lease-token'];
    if (typeof id !== 'string' || typeof secret !== 'string') throw new CocosError('UNAUTHORIZED', 'Shared backend requires a registered client lease');
    this.authenticate(id, secret).seen = this.now(); this.requests++; this.idleSince = this.now();
    let released = false;
    return () => { if (!released) { released = true; this.requests--; this.idleSince = this.now(); } };
  }
  async sweep(busy: () => boolean, close: () => Promise<void>): Promise<void> {
    this.expire();
    if (this.draining) return;
    if (this.clients.size || this.requests || busy()) { this.idleSince = this.now(); return; }
    if (this.now() - this.idleSince < this.idleMs) return;
    // 先同步拒绝新租约，再关闭服务，防止最后一次空闲检查与注册请求交错。
    this.draining = true; this.stop(); await close();
  }
  start(busy: () => boolean, close: () => Promise<void>): void {
    this.timer = setInterval(() => { void this.sweep(busy, close).catch(error => console.error('[CocosMCP shared worker]', String(error))); }, Math.min(1000, this.idleMs));
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }
}
