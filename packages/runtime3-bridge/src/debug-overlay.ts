import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import { FeatureSupport as F } from './feature-support.js';
import type { SceneInspector } from './scene.js';
import { DebugShapes } from './debug-shapes.js';

interface Drawing { id: string; ownerId: string; camera: RuntimeObject; renderer: RuntimeObject; expires: number; rows: Array<{ start: RuntimeObject; end: RuntimeObject }>; color: RuntimeObject; depthTest: boolean }
export class DebugOverlayController {
  private readonly drawings = new Map<string, Drawing>();
  private sequence = 0;
  private listening = false;
  private scene: unknown;
  private errors: string[] = [];
  constructor(private readonly inspector: SceneInspector) {}
  private get cc(): RuntimeObject { return this.inspector.environment.cc; }
  private readonly draw = (): void => {
    try {
      if (A.call(this.cc.director, 'getScene') !== this.scene) { this.dispose(); return; }
      for (const [id, drawing] of this.drawings) {
        if (performance.now() > drawing.expires || drawing.camera.isValid === false) { this.drawings.delete(id); continue; }
        try { for (const row of drawing.rows) A.call(drawing.renderer, 'addLine', row.start, row.end, drawing.color, drawing.depthTest); }
        catch (error) { this.drawings.delete(id); this.errors.push(CocosError.from(error).message); this.errors = this.errors.slice(-20); }
      }
      if (!this.drawings.size) this.unlisten();
    } catch (error) { this.errors.push(CocosError.from(error).message); this.errors = this.errors.slice(-20); }
  };
  private unlisten(): void {
    if (!this.listening) return;
    A.call(this.cc.director, 'off', F.require(this.cc.Director, 'Director').EVENT_BEFORE_DRAW, this.draw); this.listening = false;
  }
  execute(id: string, p: JsonObject): JsonValue {
    if (id.endsWith('.shape')) return this.execute('runtime.debug.draw',{...p,lines:new DebugShapes().lines(p)});
    if (id.endsWith('.inspect')) return { supported: true, rows: [...this.drawings.values()].map(row => ({ drawingId: row.id, ownerId: row.ownerId, remainingMs: Math.max(0, row.expires - performance.now()), lines: row.rows.length })), errors: this.errors };
    if (id.endsWith('.clear')) {
      const ownerId = Json.string(p.ownerId, 'ownerId'); let removed = 0;
      for (const [key, row] of this.drawings) if (row.ownerId === ownerId) { this.drawings.delete(key); removed++; }
      if (!this.drawings.size) this.unlisten();
      return { supported: true, removed, pixelsClearedOnNextFrame: true };
    }
    const camera = this.inspector.component(Json.string(p.cameraComponentId, 'cameraComponentId'));
    const type = F.require(this.cc.Camera, 'Camera');
    if (typeof type !== 'function' || !(camera instanceof type)) throw new CocosError('INVALID_ARGUMENT', '目标不是 Camera');
    // 不替换或 reset 共享绘制器；未激活调试几何的管线明确返回不支持。
    const native = F.require(camera.camera, 'active camera'), renderer = F.require(native.geometryRenderer, '已激活的相机 GeometryRenderer');
    F.methods(renderer, ['addLine']); F.require(this.cc.Vec3, 'Vec3'); F.require(this.cc.Color, 'Color');
    const director = F.require(this.cc.director, 'Director'); F.methods(director, ['on', 'off']);
    const event = F.require(this.cc.Director, 'Director').EVENT_BEFORE_DRAW;
    if (typeof event !== 'string') throw new CocosError('UNSUPPORTED_CAPABILITY', '缺少绘制前事件');
    if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 1024 || this.drawings.size >= 32 || [...this.drawings.values()].reduce((sum,row) => sum + row.rows.length,0) + p.lines.length > 4096) throw new CocosError('INVALID_ARGUMENT', '绘制超过数量预算');
    const vector = (v: JsonValue | undefined): RuntimeObject => {
      const point = Json.object(v);
      if (['x','y','z'].some(key => typeof point[key] !== 'number' || !Number.isFinite(point[key]) || Math.abs(Number(point[key])) > 100000)) throw new CocosError('INVALID_ARGUMENT', '调试坐标无效');
      return A.construct(this.cc.Vec3, [point.x, point.y, point.z]);
    };
    const rows = p.lines.map(row => { const line = Json.object(row); return { start: vector(line.start), end: vector(line.end) }; });
    const ttlMs = Number(p.ttlMs ?? 3000);
    if (!Number.isInteger(ttlMs) || ttlMs < 16 || ttlMs > 30000) throw new CocosError('INVALID_ARGUMENT', 'ttlMs 必须为 16..30000');
    const color = Array.isArray(p.color) ? p.color : [0,255,0,255];
    if (color.length !== 4 || color.some(c => typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > 255)) throw new CocosError('INVALID_ARGUMENT', '颜色需为 RGBA 0..255');
    const key = `debug-${++this.sequence}`;
    this.scene = A.call(director, 'getScene');
    this.drawings.set(key, { id: key, ownerId: Json.string(p.ownerId, 'ownerId'), camera, renderer, rows, expires: performance.now() + ttlMs, color: A.construct(this.cc.Color, color), depthTest: p.depthTest !== false });
    if (!this.listening) {
      try { this.listening = true; A.call(director, 'on', event, this.draw); }
      catch (error) { this.drawings.delete(key); this.unlisten(); throw error; }
    }
    return { supported: true, drawingId: key, status: 'queued', coordinateSpace: 'world', frameVerified: false };
  }
  dispose(): void { this.drawings.clear(); this.unlisten(); }
}
