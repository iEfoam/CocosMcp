import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';

export class PhysicsQueries {
  constructor(private readonly cc: RuntimeObject) {}
  private vector(value: JsonValue | undefined, dimensions: 2 | 3): number[] {
    const object = Json.object(value), axes = dimensions === 2 ? ['x', 'y'] : ['x', 'y', 'z'];
    return axes.map(key => { const n = object[key]; if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1000000) throw new CocosError('INVALID_ARGUMENT', 'Physics vector must have finite bounded coordinates'); return n; });
  }
  execute(id: string, p: JsonObject): JsonValue {
    const dimension = id.startsWith('runtime.physics2d.') ? 2 : 3;
    const type = this.cc[dimension === 2 ? 'PhysicsSystem2D' : 'PhysicsSystem'];
    if (!type || !A.object(type).instance) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Requested physics module is not available');
    const system = A.object(A.object(type).instance);
    if (id.endsWith('.inspect')) return { dimension, enabled: Boolean(system.enable), gravity: A.safeData(system.gravity), backend: 'not-detected', scope: 'current-physics-world' };
    if (!id.endsWith('.raycast')) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Unknown physics query');
    const limit = Number(p.limit ?? 100), mask = Number(p.mask ?? 0xffffffff);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(mask) || mask < 0 || mask > 0xffffffff) throw new CocosError('INVALID_ARGUMENT', 'Invalid raycast limit or layer mask');
    let results: RuntimeObject[], length = 0;
    if (dimension === 2) {
      const start = this.vector(p.start, 2), end = this.vector(p.end, 2); length = Math.hypot(end[0]! - start[0]!, end[1]! - start[1]!);
      if (!length) throw new CocosError('INVALID_ARGUMENT', '2D ray endpoints must differ');
      results = A.call(system, 'raycast', A.construct(this.cc.Vec2, start), A.construct(this.cc.Vec2, end), 3, mask) as RuntimeObject[];
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
