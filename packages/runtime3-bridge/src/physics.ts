import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';

export class PhysicsQueries {
  constructor(private readonly cc: RuntimeObject) {}
  private emptyBox2dWorld(type: RuntimeObject, system: RuntimeObject): boolean {
    if (type.PHYSICS_BOX2D !== true || A.engineVersion(this.cc) !== '3.8.8') return false;
    const world = system.physicsWorld ? A.object(system.physicsWorld) : undefined;
    const native = world?.impl ? A.object(world.impl) : undefined;
    // 3.8.8 随附 JS Box2D 的空树 Query/RayCast 会 Push(null)，随后 Pop 抛无消息异常。
    // 只依据公开代理计数确认空世界；不吞原生错误，也不检查引擎私有树字段。
    return typeof native?.GetProxyCount === 'function' && A.call(native, 'GetProxyCount') === 0;
  }
  private vector(value: JsonValue | undefined, dimensions: 2 | 3): number[] {
    const object = Json.object(value), axes = dimensions === 2 ? ['x', 'y'] : ['x', 'y', 'z'];
    return axes.map(key => { const n = object[key]; if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1000000) throw new CocosError('INVALID_ARGUMENT', 'Physics vector must have finite bounded coordinates'); return n; });
  }
  execute(id: string, p: JsonObject): JsonValue {
    const dimension = id.startsWith('runtime.physics2d.') ? 2 : 3;
    const type = this.cc[dimension === 2 ? 'PhysicsSystem2D' : 'PhysicsSystem'];
    if (!type || !A.object(type).instance) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Requested physics module is not available');
    const system = A.object(A.object(type).instance), physicsType = A.object(type);
    const backend = dimension === 2 ? physicsType.PHYSICS_BOX2D ? 'box2d' : physicsType.PHYSICS_BOX2D_WASM ? 'box2d-wasm' : physicsType.PHYSICS_BUILTIN ? 'builtin' : 'not-detected' : 'not-detected';
    if (id.endsWith('.inspect')) return { dimension, enabled: Boolean(system.enable), gravity: A.safeData(system.gravity), backend, scope: 'current-physics-world' };
    if (dimension === 2 && (id.endsWith('.test_point') || id.endsWith('.test_aabb'))) {
      let results: RuntimeObject[];
      if (id.endsWith('.test_point')) {
        const point = A.construct(this.cc.Vec2, this.vector(p.point, 2));
        results = this.emptyBox2dWorld(physicsType, system) ? [] : A.call(system, 'testPoint', point) as RuntimeObject[];
      }
      else {
        const values = ['x', 'y', 'width', 'height'].map(key => Number(p[key]));
        if (!values.every(n => Number.isFinite(n) && Math.abs(n) <= 1000000) || values[2]! <= 0 || values[3]! <= 0) throw new CocosError('INVALID_ARGUMENT', 'Invalid query rectangle');
        results = this.emptyBox2dWorld(physicsType, system) ? [] : A.call(system, 'testAABB', A.construct(this.cc.Rect, values)) as RuntimeObject[];
      }
      const rows = [...new Set(results)].map(c => ({ colliderId: A.uuid(c), nodeId: A.uuid(A.object(c).node) }));
      return { rows: rows.slice(0, 500), total: rows.length, truncated: rows.length > 500, coordinateSpace: 'world', stepsSimulation: false };
    }
    if (!id.endsWith('.raycast')) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Unknown physics query');
    const limit = Number(p.limit ?? 100), mask = Number(p.mask ?? 0xffffffff);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(mask) || mask < 0 || mask > 0xffffffff) throw new CocosError('INVALID_ARGUMENT', 'Invalid raycast limit or layer mask');
    let results: RuntimeObject[], length = 0;
    if (dimension === 2) {
      const start = this.vector(p.start, 2), end = this.vector(p.end, 2); length = Math.hypot(end[0]! - start[0]!, end[1]! - start[1]!);
      if (!length) throw new CocosError('INVALID_ARGUMENT', '2D ray endpoints must differ');
      results = this.emptyBox2dWorld(physicsType, system) ? [] : A.call(system, 'raycast', A.construct(this.cc.Vec2, start), A.construct(this.cc.Vec2, end), 3, mask) as RuntimeObject[];
    } else {
      const origin = this.vector(p.origin, 3), direction = this.vector(p.direction, 3), magnitude = Math.hypot(...direction), maxDistance = Number(p.maxDistance ?? 1000);
      if (!magnitude || !Number.isFinite(maxDistance) || maxDistance <= 0 || maxDistance > 100000) throw new CocosError('INVALID_ARGUMENT', 'Ray direction and maxDistance must be positive and bounded');
      const ray = A.construct(A.object(this.cc.geometry).Ray, [...origin, ...direction.map(n => n / magnitude)]);
      const hit = A.call(system, 'raycast', ray, mask, maxDistance, p.queryTrigger ?? true);
      results = hit ? system.raycastResults as RuntimeObject[] : [];
    }
    // 原生结果池会在下次查询复用；立即复制值，不向 Agent 暴露可变的引擎对象。
    const rows = results.map(hit => ({ colliderId: A.uuid(hit.collider), nodeId: A.uuid(A.object(hit.collider).node), distance: dimension === 2 ? Number(hit.fraction) * length : Number(hit.distance),
      point: A.safeData(dimension === 2 ? hit.point : hit.hitPoint), normal: A.safeData(dimension === 2 ? hit.normal : hit.hitNormal) })).sort((a, b) => a.distance - b.distance);
    return { rows: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit, dimension, coordinateSpace: 'world', units: dimension === 2 ? 'Creator 2D scene units' : 'Creator 3D world units',
      limitations: ['查询当前物理世界，不主动步进或同步变换；后端兼容性需单独验证', ...(dimension === 2 ? ['All 模式可能返回同一 Collider 的多个夹具命中'] : [])] };
  }
}
