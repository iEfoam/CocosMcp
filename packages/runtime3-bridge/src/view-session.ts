import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';

interface Restore { before: JsonObject; policy: unknown; appliedPolicy: RuntimeObject; policyRevision: number; appliedHash: string }

/** 恢复句柄只属于当前运行时场景；并发修改后宁可保留现场，也不覆盖后来设置。 */
export class RuntimeViewSession {
  private readonly restores = new Map<string, Restore>();
  private sequence = 0;
  private policySequence = 0;
  private readonly strategies = new WeakMap<object, number>();
  private readonly policyObservers = new Map<RuntimeObject, { revision: number; dispose(): void }>();
  constructor(private readonly cc: RuntimeObject) {}
  private pruneObservers(): void {
    const retained = new Set([A.object(A.call(this.cc.view, 'getResolutionPolicy'))]);
    for (const record of this.restores.values()) { retained.add(A.object(record.policy)); retained.add(record.appliedPolicy); }
    for (const [policy, observer] of this.policyObservers) if (!retained.has(policy)) { observer.dispose(); this.policyObservers.delete(policy); }
  }
  private watch(policy: RuntimeObject): void {
    if (this.policyObservers.has(policy)) return;
    const undo: Array<() => void> = [], observer = { revision: 0, dispose: () => { for (const restore of undo.reverse()) restore(); } };
    try {
      for (const name of ['setContentStrategy', 'setContainerStrategy']) {
        const original = policy[name]; if (typeof original !== 'function') continue;
        const descriptor = Object.getOwnPropertyDescriptor(policy, name);
        const wrapper = function (this: RuntimeObject, ...args: unknown[]): unknown { observer.revision++; return Reflect.apply(original, this, args); };
        Object.defineProperty(policy, name, { configurable: true, writable: true, value: wrapper });
        undo.push(() => { if (policy[name] === wrapper) { if (descriptor) Object.defineProperty(policy, name, descriptor); else delete policy[name]; } });
      }
      // 公开 getter 不完整时，通过公开 setter 记录策略修改；不读取引擎私有字段。
      if (!undo.length && (typeof policy.getContentStrategy !== 'function' || typeof policy.getContainerStrategy !== 'function')) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Resolution policy cannot be observed safely');
      this.policyObservers.set(policy, observer);
    } catch (error) { observer.dispose(); throw error; }
  }
  private policy(view: RuntimeObject): JsonObject {
    if (typeof view.getResolutionPolicy !== 'function') return { status: 'unknown' };
    const policy = A.object(A.call(view, 'getResolutionPolicy'));
    const identify = (value: unknown): number => { const object = A.object(value); if (!this.strategies.has(object)) this.strategies.set(object, ++this.policySequence); return this.strategies.get(object)!; };
    // 2.4.15 没有策略 getter，3.8.8 只提供内容策略 getter。公开 policy 对象身份仍可检测适配模式替换。
    return { status: 'observed', policyId: identify(policy),
      contentStrategyId: typeof policy.getContentStrategy === 'function' ? identify(A.call(policy, 'getContentStrategy')) : null,
      containerStrategyId: typeof policy.getContainerStrategy === 'function' ? identify(A.call(policy, 'getContainerStrategy')) : null,
      publicSetterRevision: this.policyObservers.get(policy)?.revision ?? 0,
      customStrategyMutationCoverage: this.policyObservers.has(policy) ? 'public-setters-and-object-identity' : 'partial-public-api' };
  }
  private geometry(): JsonObject {
    const view = A.object(this.cc.view, 'public view'), canvas = A.object(this.cc.game).canvas as HTMLCanvasElement | undefined;
    const size = (method: string): JsonObject | null => {
      if (typeof view[method] !== 'function') return null;
      const value = A.object(A.call(view, method)); return { width: Number(value.width), height: Number(value.height) };
    };
    const rect = canvas?.getBoundingClientRect?.();
    const viewport = typeof view.getViewportRect === 'function' ? A.object(A.call(view, 'getViewportRect')) : undefined;
    const geometry: JsonObject = { designResolution: size('getDesignResolutionSize'), frameSize: size('getFrameSize'),
      canvasPixelSize: canvas ? { width: canvas.width, height: canvas.height } : null,
      canvasRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      engineScale: { x: typeof view.getScaleX === 'function' ? Number(A.call(view, 'getScaleX')) : null, y: typeof view.getScaleY === 'function' ? Number(A.call(view, 'getScaleY')) : null },
      engineViewportRect: viewport ? { x: Number(viewport.x), y: Number(viewport.y), width: Number(viewport.width), height: Number(viewport.height) } : null,
      devicePixelRatio: typeof devicePixelRatio === 'number' ? devicePixelRatio : null, resolutionPolicy: this.policy(view) };
    return geometry;
  }
  private unchanged(observed: JsonObject): boolean {
    const { viewHash: _hash, scope: _scope, trueDeviceSimulation: _device, ...geometry } = observed;
    return Json.canonical(geometry) === Json.canonical(this.geometry());
  }
  async inspect(): Promise<JsonObject> {
    const geometry = this.geometry();
    if (!globalThis.crypto?.subtle) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Public cryptographic digest is unavailable');
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(Json.canonical(geometry)));
    return { ...geometry, viewHash: [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''), scope: 'current-runtime-scene', trueDeviceSimulation: false };
  }
  async configure(p: JsonObject): Promise<JsonObject> {
    if (this.restores.size >= 16) throw new CocosError('RESOURCE_BUSY', 'At most sixteen view restore handles may be retained');
    this.pruneObservers();
    const view = A.object(this.cc.view), before = await this.inspect();
    if (before.viewHash !== p.expectedHash) throw new CocosError('STALE_REVISION', 'View geometry changed before configuration', before);
    if (Json.object(before.resolutionPolicy).status !== 'observed') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Public resolution strategy inspection is unavailable; settings were preserved');
    const width = Number(p.width), height = Number(p.height);
    if (![width, height].every(value => Number.isInteger(value) && value >= 256 && value <= 4096)) throw new CocosError('INVALID_ARGUMENT', 'Design resolution must be 256..4096');
    const previousPolicy = A.call(view, 'getResolutionPolicy');
    const policy = p.policy === undefined ? previousPolicy : A.object(this.cc.ResolutionPolicy)[String(p.policy)];
    if (policy === undefined) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Requested resolution policy is unavailable');
    // SHA 计算会让出事件循环，发送原生修改前再次检查，防止读取与写入之间的并发覆盖。
    const confirmed = await this.inspect();
    if (confirmed.viewHash !== before.viewHash || !this.unchanged(confirmed)) throw new CocosError('STALE_REVISION', 'View changed during preflight');
    this.watch(A.object(previousPolicy));
    const policyRevision = this.policyObservers.get(A.object(previousPolicy))!.revision;
    try { A.call(view, 'setDesignResolutionSize', width, height, policy); }
    catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'View configuration may have changed; inspect before retrying', { before, cause: CocosError.from(error).message }); }
    const appliedPolicy = A.object(A.call(view, 'getResolutionPolicy')); this.watch(appliedPolicy);
    const after = await this.inspect(), restoreId = `view:${++this.sequence}`;
    this.restores.set(restoreId, { before, policy: previousPolicy, appliedPolicy, policyRevision, appliedHash: String(after.viewHash) });
    return { restoreId, before, after, restored: false };
  }
  async restore(p: JsonObject): Promise<JsonObject> {
    const id = Json.string(p.restoreId, 'restoreId'), record = this.restores.get(id);
    if (!record) throw new CocosError('STALE_HANDLE', 'View restore handle expired');
    const current = await this.inspect();
    if (current.viewHash !== record.appliedHash || !this.unchanged(current) || this.policyObservers.get(A.object(record.policy))?.revision !== record.policyRevision) throw new CocosError('STALE_REVISION', 'View or saved policy changed; settings were preserved', current);
    const size = Json.object(record.before.designResolution);
    try { A.call(this.cc.view, 'setDesignResolutionSize', size.width, size.height, record.policy); }
    catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'View restoration may have changed settings; inspect before retrying', { restoreId: id, cause: CocosError.from(error).message }); }
    this.restores.delete(id); this.pruneObservers(); return { restoreId: id, restored: true, after: await this.inspect() };
  }
  snapshot(): JsonObject { return { viewRestoreHandles: this.restores.size }; }
  dispose(): void { this.restores.clear(); for (const observer of this.policyObservers.values()) observer.dispose(); this.policyObservers.clear(); }
}
