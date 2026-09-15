import { GraphicsInspector } from './graphics.js';
import { ParticleController } from './particle.js';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, RuntimePolicy, type RuntimeObject } from './access.js';
import { SceneInspector, type SceneEnvironment } from './scene.js';
import { MaterialController } from './material.js';
import { ShaderPreview } from './shader-preview.js';
import { PhysicsQueries } from './physics.js';
import { MediaController } from './media.js';
import { AnimationController } from './animation-control.js';
import { RuntimeAssets } from './assets.js';

interface Handle { value: unknown; owned: boolean; generation: number }
interface Subscription { owner: RuntimeObject; event: string; callback: (...args: unknown[]) => void }

export class RuntimeController {
  readonly inspector: SceneInspector;
  private readonly handles = new Map<string, Handle>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly events: JsonObject[] = [];
  private generation = 0;
  private nextHandle = 0;
  private nextEvent = 0;
  private scene: unknown;
  private cleanupErrors: JsonObject[] = [];
  private readonly materials: MaterialController;
  private readonly shaderPreview: ShaderPreview;
  private readonly assets: RuntimeAssets;

  constructor(private readonly environment: SceneEnvironment, private readonly eventCapacity = 1000, private readonly policy = new RuntimePolicy()) {
    this.inspector = new SceneInspector(environment);
    this.materials = new MaterialController(environment);
    this.shaderPreview = new ShaderPreview(environment, this.materials);
    this.assets = new RuntimeAssets(environment.cc);
  }

  private synchronize(): void {
    const current = A.call(this.environment.cc.director, 'getScene');
    if (current !== this.scene) {
      this.clearSession(); this.scene = current;
    }
  }

  private handle(value: unknown, owned = false): JsonValue {
    for (const [id, entry] of this.handles) if (entry.value === value) return { handle: id, type: this.inspector.type(value) };
    const id = `${this.generation}:${++this.nextHandle}`;
    this.handles.set(id, { value, owned, generation: this.generation });
    return { handle: id, type: this.inspector.type(value) };
  }

  private encode(value: unknown): JsonValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (Array.isArray(value)) return value.map(entry => this.encode(entry));
    if (typeof value === 'object' || typeof value === 'function') return this.handle(value);
    return String(value);
  }

  private decode(value: JsonValue): unknown {
    if (Array.isArray(value)) return value.map(entry => this.decode(entry));
    if (value && typeof value === 'object') {
      if (typeof value.$handle === 'string') return this.target(value.$handle);
      if (typeof value.$node === 'string') return this.inspector.node(value.$node);
      if (typeof value.$component === 'string') return this.inspector.component(value.$component);
      if (typeof value.$type === 'string') return A.construct(this.type(value.$type), (value.args as JsonValue[] ?? []).map(entry => this.decode(entry)));
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, entry] of Object.entries(value)) { Json.safePath(key); result[key] = this.decode(entry); }
      return result;
    }
    return value;
  }

  private type(name: string): unknown {
    const path = name.startsWith('cc.') ? name.slice(3) : name;
    this.policy.path(path);
    try {
      const type = A.get(this.environment.cc, path);
      if (type !== undefined) return type;
    } catch (error) { if (!(error instanceof CocosError) || error.code !== 'NOT_FOUND') throw error; }
    return A.call(this.environment.cc.js, 'getClassByName', name);
  }

  private target(id = 'scene'): unknown {
    if (id === 'scene') return this.inspector.current();
    if (id === 'cc') return this.environment.cc;
    if (id.startsWith('node:')) return this.inspector.node(id.slice(5));
    if (id.startsWith('component:')) return this.inspector.component(id.slice(10));
    if (id.startsWith('cc.')) return this.type(id);
    const handle = this.handles.get(id);
    if (!handle || handle.generation !== this.generation) throw new CocosError('STALE_HANDLE', 'Handle expired or belongs to another runtime');
    const value = handle.value;
    if (value && typeof value === 'object' && A.object(value).isValid === false) throw new CocosError('STALE_HANDLE', 'Referenced engine object was destroyed');
    return value;
  }

  private publicPath(path: string): string[] {
    return this.policy.path(path);
  }

  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    this.synchronize();
    if (id.startsWith('runtime.graphics.') || /^runtime\.particle[23]d\./.test(id)) {
      if (this.environment.major !== 3 || A.engineVersion(this.environment.cc) !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Graphics and particle tools require Creator 3.8.8');
      return id.startsWith('runtime.graphics.') ? new GraphicsInspector(this.environment.cc).execute(id, p) : new ParticleController(this.inspector).execute(id, p);
    }
    if (/^runtime\.(physics[23]d|audio|video|webview)\./.test(id)) {
      if (this.environment.major !== 3 || A.engineVersion(this.environment.cc) !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Physics and media tools require Creator 3.8.8');
      return id.startsWith('runtime.physics') ? new PhysicsQueries(this.environment.cc).execute(id, p) : new MediaController(this.inspector).execute(id, p);
    }
    if (id.startsWith('runtime.animation.')) {
      if (this.environment.major !== 3 || A.engineVersion(this.environment.cc) !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Animation controls require Creator 3.8.8');
      return new AnimationController(this.inspector).execute(id, p);
    }
    if (id.startsWith('runtime.asset.') || id === 'runtime.bundle.inspect') {
      if (this.environment.major !== 3 || A.engineVersion(this.environment.cc) !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Runtime asset tools require Creator 3.8.8');
      return this.assets.execute(id, p);
    }
    if (id.startsWith('runtime.material.') || id === 'runtime.shader.variants.compile') return this.materials.execute(id, p);
    if (id.startsWith('runtime.shader.')) return this.shaderPreview.execute(id, p);
    const str = (key: string): string => Json.string(p[key], key);
    switch (id) {
      case 'runtime.query': return { scene: this.inspector.sceneInfo(), engineVersion: A.engineVersion(this.environment.cc), generation: this.generation, cleanupErrors: this.cleanupErrors };
      case 'runtime.hierarchy': return this.inspector.hierarchy(p);
      case 'runtime.types': return { rows: A.propertyNames(this.environment.cc).map(name => {
        const descriptor = A.descriptor(this.environment.cc, name);
        return { name, kind: descriptor?.get ? 'accessor' : typeof descriptor?.value };
      }) };
      case 'runtime.inspect': {
        const target = this.target(String(p.target ?? 'scene'));
        return { type: this.inspector.type(target), rows: A.propertyNames(target).map(name => {
          const descriptor = A.descriptor(target, name);
          return { name, kind: descriptor?.get ? 'accessor' : typeof descriptor?.value, writable: Boolean(descriptor?.set || descriptor?.writable) };
        }) };
      }
      case 'runtime.get': this.publicPath(str('path')); return { value: this.encode(A.get(this.target(String(p.target ?? 'scene')), str('path'))) };
      case 'runtime.set': {
        const path = this.publicPath(str('path')); const key = path.pop()!;
        const root = this.target(String(p.target ?? 'scene'));
        const owner = A.object(path.length ? A.get(root, path.join('.')) : root);
        const descriptor = A.descriptor(owner, key);
        if (!descriptor || (!descriptor.set && !descriptor.writable)) throw new CocosError('INVALID_ARGUMENT', 'Property does not exist or is read-only');
        owner[key] = this.decode(p.value ?? null);
        return { value: this.encode(owner[key]) };
      }
      case 'runtime.invoke': {
        const method = str('method'); this.policy.method(method);
        const args = (p.args as JsonValue[] ?? []).map(entry => this.decode(entry));
        this.policy.arguments(args);
        const result = await A.call(this.target(String(p.target ?? 'scene')), method, ...args);
        return { value: this.encode(result) };
      }
      case 'runtime.create': {
        const args = (p.args as JsonValue[] ?? []).map(entry => this.decode(entry));
        this.policy.arguments(args);
        return { object: this.handle(A.construct(this.type(str('type')), args), true) };
      }
      case 'runtime.release': {
        const id = str('target'); const entry = this.handles.get(id);
        if (!entry) throw new CocosError('STALE_HANDLE', 'Handle is unavailable');
        if (p.destroy === true) {
          if (!entry.owned) throw new CocosError('UNAUTHORIZED', 'Cannot destroy an engine-owned object via handle release');
          A.call(entry.value, 'destroy');
        }
        this.handles.delete(id); return { released: id };
      }
      case 'runtime.subscribe': {
        const owner = A.object(this.target(String(p.target ?? 'scene'))); const event = str('event');
        if (this.subscriptions.size >= 128) throw new CocosError('RESOURCE_BUSY', 'At most 128 active or pending-cleanup subscriptions are allowed');
        const subscriptionId = `${this.generation}:event:${++this.nextHandle}`, generation = this.generation;
        let listening = false;
        const callback = (...args: unknown[]): void => {
          if (!listening || generation !== this.generation) return;
          this.events.push({ sequence: ++this.nextEvent, subscriptionId, event, occurredAt: new Date().toISOString(), args: args.map(value => A.safeData(value)) });
          if (this.events.length > this.eventCapacity) this.events.splice(0, this.events.length - this.eventCapacity);
        };
        this.subscriptions.set(subscriptionId, { owner, event, callback });
        try { A.call(owner, 'on', event, callback); listening = true; }
        catch (error) {
          // on 可能先注册再抛错；回调保持失活，若 off 也失败则保留记录供清理重试。
          try { A.call(owner, 'off', event, callback); this.subscriptions.delete(subscriptionId); } catch { /* 保留 pending cleanup。 */ }
          throw new CocosError('OUTCOME_UNKNOWN', 'Subscription registration failed; inspect cleanup before retrying', { subscriptionId, cause: CocosError.from(error).message });
        }
        return { subscriptionId };
      }
      case 'runtime.unsubscribe': {
        const id = str('subscriptionId'); const subscription = this.subscriptions.get(id);
        if (!subscription) throw new CocosError('NOT_FOUND', 'Subscription does not exist');
        A.call(subscription.owner, 'off', subscription.event, subscription.callback); this.subscriptions.delete(id); return { unsubscribed: id };
      }
      case 'runtime.events': {
        const cursor = Number(p.cursor ?? 0); const rows = this.events.filter(event => Number(event.sequence) > cursor).slice(0, Number(p.limit ?? 100));
        return { rows, nextCursor: rows.length ? rows[rows.length - 1]!.sequence! : cursor,
          droppedBefore: this.events.length ? Number(this.events[0]!.sequence) - 1 : 0 };
      }
      case 'runtime.pause': A.call(this.environment.cc.game, 'pause'); return { paused: true };
      case 'runtime.resume': A.call(this.environment.cc.game, 'resume'); return { paused: false };
      case 'runtime.capture': {
        const game = A.object(this.environment.cc.game); const canvas = game.canvas;
        if (!canvas) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Canvas capture is unavailable on this platform');
        return { dataUrl: String(A.call(canvas, 'toDataURL', 'image/png')), source: 'game-canvas' };
      }
      case 'runtime.statistics': {
        const rows = this.inspector.all();
        const director = A.object(this.environment.cc.director);
        return { nodeCount: rows.length, componentCount: rows.reduce((sum, node) => sum + this.inspector.components(node).length, 0),
          deltaTime: typeof director.getDeltaTime === 'function' ? Number(A.call(director, 'getDeltaTime')) : null,
          totalFrames: typeof director.getTotalFrames === 'function' ? Number(A.call(director, 'getTotalFrames')) : null,
          unavailableMetrics: ['gpu-memory', 'draw-calls', 'triangles'] };
      }
      default: throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown runtime capability: ${id}`);
    }
  }

  private clearSubscriptions(): void {
    const failed: string[] = [];
    for (const [id, subscription] of this.subscriptions) {
      try { A.call(subscription.owner, 'off', subscription.event, subscription.callback); this.subscriptions.delete(id); }
      catch { failed.push(id); }
    }
    if (failed.length) throw new CocosError('OUTCOME_UNKNOWN', 'Some native listeners could not be removed; callbacks are invalidated and cleanup can be retried', { subscriptionIds: failed });
  }

  private clearSession(): void {
    // 每项独立收敛；一项原生释放异常不能阻止取消订阅和使旧句柄失效。
    this.generation++;
    const cleanup: Array<[string, () => void]> = [['assets', () => this.assets.dispose()], ['shader-preview', () => this.shaderPreview.dispose()], ['materials', () => this.materials.dispose()], ['subscriptions', () => this.clearSubscriptions()]];
    const failures: JsonObject[] = [];
    for (const [scope, action] of cleanup) {
      try { action(); } catch (error) { failures.push({ scope, message: CocosError.from(error).message }); }
    }
    if (failures.length) this.cleanupErrors = [...this.cleanupErrors, ...failures].slice(-20);
    this.handles.clear(); this.events.length = 0;
  }
  connectionLost(): void { this.clearSession(); }
  dispose(): void { this.clearSession(); }

}

export { SceneInspector } from './scene.js';
export type { SceneEnvironment } from './scene.js';
