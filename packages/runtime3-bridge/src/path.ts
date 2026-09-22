import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import { FeatureSupport as F } from './feature-support.js';

export class PathSampler {
  constructor(private readonly cc: RuntimeObject) {}
  sample(p: JsonObject): JsonObject {
    const geometry = F.require(this.cc.geometry, 'geometry'), splineType = F.require(geometry.Spline, 'Spline');
    F.methods(splineType, ['create']); F.require(this.cc.Vec3, 'Vec3');
    const modes: Record<string, number> = { linear: 0, bezier: 1, catmull_rom: 2 }, mode = String(p.mode ?? 'catmull_rom');
    const points = p.points;
    if (!Object.hasOwn(modes, mode) || !Array.isArray(points) || points.length < 2 || points.length > 256 || (mode === 'bezier' && points.length % 4 !== 0)) throw new CocosError('INVALID_ARGUMENT', '路径需 2..256 个控制点；贝塞尔点数为 4 的倍数');
    const knots = points.map(point => {
      const v = Json.object(point);
      if (['x', 'y', 'z'].some(key => typeof v[key] !== 'number' || !Number.isFinite(v[key]) || Math.abs(v[key] as number) > 100000)) throw new CocosError('INVALID_ARGUMENT', '控制点坐标无效');
      return A.construct(this.cc.Vec3, [v.x, v.y, v.z]);
    });
    const count = Number(p.samples ?? 60);
    if (!Number.isInteger(count) || count < 2 || count > 1000) throw new CocosError('INVALID_ARGUMENT', 'samples 必须为 2..1000');
    const spline = A.call(splineType, 'create', modes[mode], knots);
    const denseCount = p.uniformSpeed === true ? Math.min(8192, Math.max(1024, points.length * 32)) : count;
    const dense: Array<{ x: number; y: number; z: number; distance: number; t: number }> = [];
    for (let i = 0; i < denseCount; i++) {
      const t = i / (denseCount - 1), v = A.object(A.call(spline, 'getPoint', t));
      const x = Number(v.x), y = Number(v.y), z = Number(v.z), previous = dense[dense.length - 1];
      if (![x, y, z].every(Number.isFinite)) throw new CocosError('CONTEXT_UNAVAILABLE', '引擎返回无效路径采样');
      dense.push({ x, y, z, t, distance: previous ? previous.distance + Math.hypot(x - previous.x, y - previous.y, z - previous.z) : 0 });
    }
    const length = dense[dense.length - 1]!.distance; let cursor = 1;
    const rows = Array.from({ length: count }, (_, index) => {
      const fraction = index / (count - 1);
      if (p.uniformSpeed !== true || length === 0) {
        const v = A.object(A.call(spline, 'getPoint', fraction));
        return { fraction, parameter: fraction, position: { x: Number(v.x), y: Number(v.y), z: Number(v.z) } };
      }
      const distance = fraction * length;
      while (cursor < dense.length - 1 && dense[cursor]!.distance < distance) cursor++;
      const a = dense[cursor - 1]!, b = dense[cursor]!, ratio = b.distance === a.distance ? 0 : (distance - a.distance) / (b.distance - a.distance);
      const parameter = a.t + (b.t - a.t) * ratio, v = A.object(A.call(spline, 'getPoint', parameter));
      return { fraction, parameter, position: { x: Number(v.x), y: Number(v.y), z: Number(v.z) } };
    });
    return { supported: true, rows, approximateLength: length, lengthSamples: denseCount, coordinateSpace: 'local-to-animation-target-parent', uniformSpeed: p.uniformSpeed === true, speedAccuracy: 'sampled-approximation' };
  }
  clip(p: JsonObject): JsonObject {
    const sampled = this.sample(p), duration = Number(p.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new CocosError('INVALID_ARGUMENT', 'duration 必须大于 0 且不超过 600');
    return { name: Json.string(p.name, 'name'), duration, tracks: [{ path: String(p.targetPath ?? ''), property: 'position', keys: (sampled.rows as JsonObject[]).map(row => ({ time: Number(row.fraction) * duration, value: row.position!, interpolation: 'linear' })) }] };
  }
  execute(id: string, p: JsonObject): JsonValue { return id === 'path.clip_document' ? this.clip(p) : this.sample(p); }
}
