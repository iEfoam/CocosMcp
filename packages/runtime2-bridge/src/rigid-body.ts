import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';

export class Creator2RigidBody {
  constructor(private readonly inspector: SceneInspector) {}
  private state(body: RuntimeObject): JsonObject {
    return { type: Number(body.type), enabled: Boolean(body.enabled), active: Boolean(A.object(body.node).activeInHierarchy), nativeReady: Boolean(body._b2Body),
      awake: Boolean(body.awake), linearVelocity: A.safeData(body.linearVelocity), angularVelocity: Number(body.angularVelocity),
      mass: body._b2Body ? A.safeData(A.call(body, 'getMass')) : null, worldCenter: body._b2Body ? A.safeData(A.call(body, 'getWorldCenter')) : null };
  }
  execute(id: string, p: JsonObject): JsonObject {
    const cc = this.inspector.environment.cc;
    const body = this.inspector.component(Json.string(p.componentId, 'componentId'));
    if (this.inspector.type(body) !== 'cc.RigidBody') throw new CocosError('INVALID_ARGUMENT', 'Expected Creator 2 cc.RigidBody');
    const manager = A.object(A.call(cc.director, 'getPhysicsManager')), before = this.state(body);
    const units: JsonObject = { coordinateSpace: 'world-pixels', velocity: 'pixels/second', force: 'Creator2-native-force', impulse: 'Creator2-native-impulse', ptmRatio: A.safeData(A.object(cc.PhysicsManager).PTM_RATIO), conversion: 'Native RigidBody divides vector and world point by PTM_RATIO exactly once' };
    if (id === 'runtime.rigidbody2d.inspect') return { ...before, physicsEnabled: Boolean(manager.enabled), units };
    if (!manager.enabled || !before.enabled || !before.active || !before.nativeReady) throw new CocosError('CONTEXT_UNAVAILABLE', 'Physics and native body must be active and initialized');
    if (body.type !== A.object(cc.RigidBodyType).Dynamic) throw new CocosError('INVALID_ARGUMENT', 'Force and impulse require a dynamic body');
    const vector = (raw: unknown, label: string): RuntimeObject => {
      const value = Json.object(Json.value(raw));
      if (![value.x, value.y].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1000000)) throw new CocosError('INVALID_ARGUMENT', `${label} must have finite x/y within ±1000000 native units`);
      return A.construct(cc.Vec2, [value.x, value.y]);
    };
    const value = vector(p.vector, 'vector'), point = vector(p.point, 'point');
    if (typeof p.wake !== 'boolean') throw new CocosError('INVALID_ARGUMENT', 'wake must be explicit boolean');
    const method = id === 'runtime.rigidbody2d.force' ? 'applyForce' : id === 'runtime.rigidbody2d.impulse' ? 'applyLinearImpulse' : null;
    if (!method) throw new CocosError('UNSUPPORTED_CAPABILITY', id);
    // 原生 API 自行执行 PTM 换算；再次换算会产生比例错误。这里不推进物理帧。
    A.call(body, method, value, point, p.wake);
    return { before, after: this.state(body), units, stepped: false, trajectoryVerified: false,
      limitations: ['施力结果需后续物理帧观察；冲量即时读回不代表碰撞或轨迹验收', '物理操作不可用编辑器 Undo 回滚，勿对不确定结果自动重试'] };
  }
}
