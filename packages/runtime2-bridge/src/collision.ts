import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';
import type { FrameSession } from '../../runtime3-bridge/src/frame-session.js';

export class Creator2Collision {
  constructor(private readonly inspector: SceneInspector) {}
  private colliders(node: RuntimeObject): RuntimeObject[] { return this.inspector.components(node).filter(c => ['cc.BoxCollider', 'cc.CircleCollider', 'cc.PolygonCollider'].includes(this.inspector.type(c))); }
  inspect(p: JsonObject): JsonObject {
    const cc = this.inspector.environment.cc, manager = A.object(A.call(cc.director, 'getCollisionManager'));
    const nodes = this.inspector.all(this.inspector.node(Json.string(p.rootId, 'rootId')));
    const rows = nodes.flatMap(node => this.colliders(node).map(c => ({ nodeId: A.uuid(node), componentId: A.uuid(c), type: this.inspector.type(c),
      enabled: Boolean(c.enabled), active: Boolean(node.activeInHierarchy), groupIndex: Number(node.groupIndex), tag: A.safeData(c.tag),
      world: c.world ? { aabb: A.safeData(A.object(c.world).aabb), points: A.safeData(A.object(c.world).points), radius: A.safeData(A.object(c.world).radius), position: A.safeData(A.object(c.world).position) } : null })));
    return { enabled: Boolean(manager.enabled), groups: A.safeData(A.object(cc.game).groupList), matrix: A.safeData(A.object(cc.game).collisionMatrix), rows,
      coordinateSpace: 'world-pixels', cachedGeometry: true, stepped: false, limitations: ['世界边界来自上次原生更新；禁用、暂停或尚未更新时可能过期', '普通碰撞器不同于 Box2D 物理碰撞器'] };
  }
  async trace(p: JsonObject, frames: FrameSession, progress: (value: JsonObject) => void = () => {}): Promise<JsonObject> {
    const cc = this.inspector.environment.cc, manager = A.object(A.call(cc.director, 'getCollisionManager'));
    if (!manager.enabled) throw new CocosError('CONTEXT_UNAVAILABLE', 'Collision manager is disabled');
    const count = Number(p.frames), limit = Number(p.limit ?? 1000);
    if (!Number.isInteger(count) || count < 1 || count > 300 || !Number.isInteger(limit) || limit < 1 || limit > 5000) throw new CocosError('INVALID_ARGUMENT', 'Invalid bounded collision trace');
    const nodes = this.inspector.all(this.inspector.node(Json.string(p.rootId, 'rootId'))).filter(node => node.activeInHierarchy && this.colliders(node).some(c => c.enabled));
    if (nodes.length > 128) throw new CocosError('RESOURCE_BUSY', 'Collision trace is limited to 128 receiver nodes');
    const rows: JsonObject[] = [], observers: RuntimeObject[] = [], token = frames.token(); let active = true, dropped = 0, frame = 0;
    const record = (event: string, other: unknown, self: unknown): void => {
      if (!active) return;
      if (rows.length >= limit) { dropped++; return; }
      rows.push({ event, frame, selfColliderId: A.uuid(self), otherColliderId: A.uuid(other), receiverNodeId: A.uuid(A.object(self).node), otherNodeId: A.uuid(A.object(other).node) });
    };
    // 附加自有观察组件接收原生回调；不替换已有组件方法或 CollisionManager 分发函数。
    const Observer = A.call(cc, 'Class', { extends: cc.Component,
      onCollisionEnter: (other: unknown, self: unknown) => record('enter', other, self),
      onCollisionStay: (other: unknown, self: unknown) => record('stay', other, self),
      onCollisionExit: (other: unknown, self: unknown) => record('exit', other, self),
    });
    try {
      for (const node of nodes) observers.push(A.object(A.call(node, 'addComponent', Observer)));
      for (frame = 0; frame < count; frame++) { await frames.wait(token); progress({ completedFrames: frame + 1, totalFrames: count, recordedEvents: rows.length, dropped, rows }); }
      return { rows, dropped, frames: count, receiverNodes: nodes.length, scope: 'native-callback-deliveries', businessCallbacksPreserved: true };
    } finally {
      // destroy 延迟到帧尾；先关闭记录，保证等待销毁期间不会再捕获事件。
      active = false;
      const failures: string[] = [];
      for (const observer of observers) if (observer.isValid !== false) {
        try { A.call(observer, 'destroy'); } catch (error) { failures.push(CocosError.from(error).message); }
      }
      try { A.call(cc.js, 'unregisterClass', Observer); } catch (error) { failures.push(CocosError.from(error).message); }
      if (failures.length) throw new CocosError('OUTCOME_UNKNOWN', 'Collision observers stopped recording but cleanup is incomplete', { failures });
    }
  }
}
