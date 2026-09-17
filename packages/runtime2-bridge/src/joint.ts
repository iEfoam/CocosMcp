import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';

/** 只读取关节，不调用 apply：apply 会销毁并重建 Box2D 约束。 */
export class Creator2Joint {
  constructor(private readonly inspector: SceneInspector) {}
  inspect(p: JsonObject): JsonObject {
    const joint = this.inspector.component(Json.string(p.componentId, 'componentId')), type = this.inspector.type(joint);
    if (!['cc.DistanceJoint', 'cc.RopeJoint', 'cc.WeldJoint', 'cc.WheelJoint', 'cc.RevoluteJoint', 'cc.PrismaticJoint', 'cc.MotorJoint', 'cc.MouseJoint'].includes(type)) throw new CocosError('INVALID_ARGUMENT', 'Expected a Creator 2 joint component');
    const body = this.inspector.components(A.object(joint.node)).find(c => this.inspector.type(c) === 'cc.RigidBody');
    const connected = joint.connectedBody ? A.object(joint.connectedBody) : null, ready = Boolean(joint._joint), issues: JsonObject[] = [];
    if (!body) issues.push({ code: 'BODY_MISSING' });
    if (!connected) issues.push({ code: 'CONNECTED_BODY_MISSING' });
    if (connected && connected === body) issues.push({ code: 'SELF_CONNECTION' });
    if (connected && (connected.isValid === false || !connected._b2Body)) issues.push({ code: 'CONNECTED_BODY_UNAVAILABLE' });
    if (!ready) issues.push({ code: 'NATIVE_JOINT_NOT_READY' });
    const properties: JsonObject = {};
    for (const key of ['distance', 'maxLength', 'frequency', 'dampingRatio', 'referenceAngle', 'enableLimit', 'lowerAngle', 'upperAngle', 'lowerLimit', 'upperLimit', 'enableMotor', 'motorSpeed', 'maxMotorTorque', 'maxMotorForce', 'maxForce', 'maxTorque', 'correctionFactor', 'linearOffset', 'angularOffset']) if (key in joint) properties[key] = A.safeData(joint[key]);
    const worldAnchor = (method: string): JsonObject | null => {
      if (!ready) return null;
      // 2.4.15 Joint 包装器漏传 Box2D 必需的 out 参数；直接读取原生约束并只做一次像素转换。
      const out = { x: 0, y: 0 }, ratio = Number(A.object(this.inspector.environment.cc.PhysicsManager).PTM_RATIO);
      if (!Number.isFinite(ratio) || ratio <= 0) throw new CocosError('CONTEXT_UNAVAILABLE', 'Invalid native physics pixel ratio');
      A.call(joint._joint, method, out);
      return { x: out.x * ratio, y: out.y * ratio };
    };
    // 未初始化时原生 getter 返回零向量，必须报告 null，避免伪造有效世界锚点。
    return { type, bodyId: body ? A.uuid(body) : null, connectedBodyId: connected ? A.uuid(connected) : null,
      enabled: Boolean(joint.enabled), nativeReady: ready, collideConnected: Boolean(joint.collideConnected),
      anchor: A.safeData(joint.anchor), connectedAnchor: A.safeData(joint.connectedAnchor),
      worldAnchor: worldAnchor('GetAnchorA'),
      worldConnectedAnchor: worldAnchor('GetAnchorB'),
      properties, issues, coordinateSpace: 'world-pixels', anchorSpace: 'body-local-pixels', mutated: false,
      limitations: ['Creator 2 Joint 要求连接刚体；MouseJoint 在拖拽时建立连接，未拖拽时可未就绪', '检查配置和原生锚点不代表已验证约束运动轨迹'] };
  }
}
