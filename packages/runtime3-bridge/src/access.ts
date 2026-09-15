import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';

export type RuntimeObject = Record<string, unknown>;

/** 运行时桥接的最小权限策略。默认拒绝能执行脚本、加载模块或控制宿主进程的入口。 */
export class RuntimePolicy {
  private readonly denied = new Set(['eval', 'Function', 'constructor', 'require', 'import', 'exec', 'spawn', 'fork', 'kill', 'exit', 'destroyImmediate',
    'destroy', 'destroyAllChildren', 'removeFromParent', 'removeAllChildren', 'setParent']);
  constructor(readonly maxArguments = 32) {}

  path(path: string): string[] {
    let segments: string[];
    try { segments = Json.safePath(path); }
    catch (error) {
      if (error instanceof CocosError && error.code === 'INVALID_ARGUMENT') throw new CocosError('UNAUTHORIZED', 'Runtime path is not exposed');
      throw error;
    }
    if (segments.some(segment => segment.startsWith('_') || this.denied.has(segment))) throw new CocosError('UNAUTHORIZED', 'Runtime path is not exposed');
    return segments;
  }

  method(method: string): string[] {
    const segments = this.path(method);
    if (segments.length > 4 || segments.some(segment => segment.includes('..'))) throw new CocosError('UNAUTHORIZED', 'Runtime method path is not allowed');
    return segments;
  }

  arguments(args: unknown[]): void {
    if (args.length > this.maxArguments) throw new CocosError('INVALID_ARGUMENT', `Runtime method accepts at most ${this.maxArguments} arguments`);
  }
}

export class RuntimeAccess {
  /** System.import('cc') 使用公开 VERSION；ENGINE_VERSION 仅存在于旧版全局对象。 */
  static engineVersion(cc: RuntimeObject): string { return String(cc.VERSION ?? cc.ENGINE_VERSION ?? 'unknown'); }

  private static readonly released = new WeakSet<object>();

  /** 引擎延迟到帧末释放；isValid 属性在 destroy 已排队时仍可能为 true。 */
  static destroyOwned(cc: RuntimeObject, value: unknown): void {
    const object = RuntimeAccess.object(value);
    if (this.released.has(object) || object.isValid === false) return;
    if (typeof cc.isValid === 'function' && RuntimeAccess.call(cc, 'isValid', object, true) === false) return;
    this.released.add(object);
    try { RuntimeAccess.call(object, 'destroy'); }
    catch (error) { this.released.delete(object); throw error; }
  }

  static object(value: unknown, label = 'object'): RuntimeObject {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) throw new CocosError('NOT_FOUND', `${label} is unavailable`);
    return value as RuntimeObject;
  }

  static get(value: unknown, path: string): unknown {
    let current = value;
    for (const key of Json.safePath(path)) current = RuntimeAccess.object(current)[key];
    return current;
  }

  static call(value: unknown, method: string, ...args: unknown[]): unknown {
    const owner = RuntimeAccess.object(value);
    Json.safePath(method);
    const callable = owner[method];
    if (typeof callable !== 'function') throw new CocosError('UNSUPPORTED_CAPABILITY', `Method is unavailable: ${method}`);
    return Reflect.apply(callable, owner, args);
  }

  static construct(value: unknown, args: unknown[]): RuntimeObject {
    if (typeof value !== 'function') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Type is not constructible');
    return RuntimeAccess.object(Reflect.construct(value, args));
  }

  static propertyNames(value: unknown): string[] {
    const names = new Set<string>();
    let current: object | null = RuntimeAccess.object(value);
    while (current && current !== Object.prototype && current !== Function.prototype) {
      for (const name of Object.getOwnPropertyNames(current)) if (!name.startsWith('_') && !['constructor', 'prototype', 'caller', 'callee', 'arguments'].includes(name)) names.add(name);
      current = Object.getPrototypeOf(current) as object | null;
    }
    return [...names].sort();
  }

  static descriptor(value: unknown, key: string): PropertyDescriptor | undefined {
    let current: object | null = RuntimeAccess.object(value);
    while (current && current !== Object.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return descriptor;
      current = Object.getPrototypeOf(current) as object | null;
    }
    return undefined;
  }

  static uuid(value: unknown): string { const object = RuntimeAccess.object(value); return String(object.uuid ?? object._id ?? ''); }

  static safeData(value: unknown, depth = 0, seen = new Set<unknown>()): JsonValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value !== 'object') return String(value);
    const object = RuntimeAccess.object(value);
    if (seen.has(value) || depth > 5) return { reference: RuntimeAccess.uuid(value) || '[circular]' };
    seen.add(value);
    if (Array.isArray(value)) return value.map(entry => RuntimeAccess.safeData(entry, depth + 1, new Set(seen)));
    const result: JsonObject = {};
    for (const key of Object.keys(object)) {
      if (key.startsWith('_') || ['node', 'parent', 'children'].includes(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      // 默认枚举不执行 getter，避免为了检查对象而改变引擎状态。
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value === 'function') continue;
      result[key] = RuntimeAccess.safeData(descriptor.value, depth + 1, new Set(seen));
    }
    return result;
  }
}
