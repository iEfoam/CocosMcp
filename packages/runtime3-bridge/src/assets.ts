import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';

/** 句柄只拥有 addRef 增加的那一份引用；不强制释放游戏或引擎缓存中的共享对象。 */
export class RuntimeAssets {
  private generation = 0;
  private sequence = 0;
  private readonly handles = new Map<string, RuntimeObject>();
  private readonly pending = new Map<number, (error: Error) => void>();
  private watching = false;
  private readonly sceneChanged = (): void => this.dispose();
  constructor(private readonly cc: RuntimeObject) {}
  private scene(): unknown {
    return this.cc.director && typeof A.object(this.cc.director).getScene === 'function' ? A.call(this.cc.director, 'getScene') : null;
  }
  private watch(): void {
    const director = this.cc.director;
    if (!this.watching && director && typeof A.object(director).on === 'function') {
      A.call(director, 'on', 'director_after_scene_launch', this.sceneChanged); this.watching = true;
    }
  }
  private async load(uuid: string, preload: boolean, timeoutMs: number): Promise<unknown> {
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(@[a-zA-Z0-9_-]{1,32})?$/.test(uuid)) throw new CocosError('INVALID_ARGUMENT', 'Expected a full local AssetDB UUID, not a URL or path');
    if (this.pending.size + this.handles.size >= 128) throw new CocosError('RESOURCE_BUSY', 'Runtime asset handle and request limit reached');
    const requestId = ++this.sequence, generation = this.generation;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, value?: unknown): void => {
        if (settled) return; settled = true; clearTimeout(timer); this.pending.delete(requestId);
        if (error) reject(error);
        else if (generation !== this.generation) reject(new CocosError('STALE_HANDLE', 'Runtime changed during resource loading'));
        else resolve(value);
      };
      const timer = setTimeout(() => finish(new CocosError('CONTEXT_UNAVAILABLE', 'Resource load timed out; engine request may still finish')), timeoutMs);
      this.pending.set(requestId, error => finish(error));
      try { A.call(this.cc.assetManager, preload ? 'preloadAny' : 'loadAny', uuid, finish); }
      catch (error) { finish(CocosError.from(error)); }
    });
  }
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    if (id === 'runtime.bundle.inspect') {
      const rows: JsonObject[] = [];
      A.call(A.object(this.cc.assetManager).bundles, 'forEach', (bundle: RuntimeObject) => rows.push({ name: String(bundle.name), base: String(bundle.base ?? ''), ownedByTool: false }));
      return { rows, scope: 'loaded-bundles', unloadSupported: false };
    }
    if (id === 'runtime.asset.load' || id === 'runtime.asset.preload') {
      this.watch();
      const generation = this.generation, scene = this.scene(), timeoutMs = Number(p.timeoutMs ?? 10000);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new CocosError('INVALID_ARGUMENT', 'timeoutMs must be 100..30000');
      const uuid = Json.string(p.uuid, 'uuid'), value = await this.load(uuid, id.endsWith('preload'), timeoutMs);
      // Promise 交接期间也可能断线；任何代际变化均不得取得新的资源所有权。
      if (generation !== this.generation || scene !== this.scene()) throw new CocosError('STALE_HANDLE', 'Runtime changed before resource acquisition');
      if (id.endsWith('preload')) return { uuid, phase: 'downloaded-not-parsed', bound: false };
      const asset = A.object(value, 'loaded asset');
      if (typeof asset.addRef !== 'function' || typeof asset.decRef !== 'function') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Loaded object is not a reference-counted asset');
      A.call(asset, 'addRef'); const handle = `${generation}:asset:${++this.sequence}`; this.handles.set(handle, asset);
      return { handle, uuid: A.uuid(asset), phase: 'loaded', bound: false, refCount: Number(asset.refCount) };
    }
    const handle = Json.string(p.handle, 'handle'), asset = this.handles.get(handle);
    if (!asset) throw new CocosError('STALE_HANDLE', 'Resource handle is absent or expired');
    if (id === 'runtime.asset.inspect') return { handle, uuid: A.uuid(asset), valid: asset.isValid !== false, refCount: Number(asset.refCount), ownedReferences: 1 };
    if (id === 'runtime.asset.release') {
      A.call(asset, 'decRef', false); this.handles.delete(handle);
      return { handle, releasedOwnedReference: true, engineCacheReleased: false };
    }
    throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown asset tool: ${id}`);
  }
  dispose(): void {
    this.generation++;
    if (this.watching) {
      try { A.call(this.cc.director, 'off', 'director_after_scene_launch', this.sceneChanged); }
      catch { /* 引擎退出时 Director 可能先失效，仍须继续归还引用和拒绝挂起请求。 */ }
      this.watching = false;
    }
    for (const cancel of this.pending.values()) cancel(new CocosError('STALE_HANDLE', 'Runtime session or scene ended')); this.pending.clear();
    for (const asset of this.handles.values()) { try { A.call(asset, 'decRef', false); } catch { /* 场景可能先于桥接销毁资产，只释放工具引用，不尝试再次销毁。 */ } }
    this.handles.clear();
  }
}
