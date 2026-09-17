import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';
import type { FrameSession } from '../../runtime3-bridge/src/frame-session.js';

export class Creator2PhysicsContact {
  constructor(private readonly inspector: SceneInspector) {}
  async trace(p: JsonObject, frames: FrameSession, progress: (value: JsonObject) => void): Promise<JsonObject> {
    const cc = this.inspector.environment.cc, manager = A.object(A.call(cc.director, 'getPhysicsManager'));
    if (!manager.enabled) throw new CocosError('CONTEXT_UNAVAILABLE', 'Box2D physics is disabled');
    const count = Number(p.frames ?? 120), limit = Number(p.limit ?? 1000), ratio = Number(A.object(cc.PhysicsManager).PTM_RATIO);
    if (!Number.isInteger(count) || count < 1 || count > 300 || !Number.isInteger(limit) || limit < 1 || limit > 5000) throw new CocosError('INVALID_ARGUMENT', 'Invalid bounded physics contact trace');
    if (!Number.isFinite(ratio) || ratio <= 0) throw new CocosError('VERIFICATION_FAILED', 'Invalid native PTM ratio');
    const bodies = this.inspector.all(this.inspector.node(Json.string(p.rootId, 'rootId'))).flatMap(node => this.inspector.components(node).filter(component => this.inspector.type(component) === 'cc.RigidBody'));
    const eligible = bodies.filter(body => body.enabled && A.object(body.node).activeInHierarchy && body._b2Body && body.enabledContactListener);
    if (!eligible.length) throw new CocosError('CONTEXT_UNAVAILABLE', 'No active initialized body with enabledContactListener in subtree');
    if (eligible.length > 128) throw new CocosError('RESOURCE_BUSY', 'Contact trace is limited to 128 receiver bodies');
    const skipped = bodies.filter(body => !eligible.includes(body)).map(body => ({ componentId: A.uuid(body), reason: !body.enabledContactListener ? 'contact-listener-disabled' : 'inactive-or-uninitialized' }));
    const rows: JsonObject[] = [], observers: RuntimeObject[] = [], token = frames.token();
    let active = true, frame = 0, dropped = 0, captureFailure: string | null = null;
    const record = (event: string, contact: unknown, self: unknown, other: unknown): void => {
      if (!active) return;
      if (rows.length >= limit) { dropped++; return; }
      try {
        // Contact、manifold、impulse 都由引擎复用；必须在接收者对应的回调内复制，不能留给异步查询。
        const manifold = A.object(A.call(contact, 'getWorldManifold'));
        const rawImpulse = event === 'postSolve' ? A.call(contact, 'getImpulse') : null;
        const impulse = rawImpulse ? A.object(rawImpulse) : null;
        const nativeNormal = impulse?.normalImpulses, nativeTangent = impulse?.tangentImpulses;
        if (impulse && (!Array.isArray(nativeNormal) || !Array.isArray(nativeTangent))) throw new Error('Invalid contact impulse arrays');
        rows.push({ event, frame, selfColliderId: A.uuid(self), otherColliderId: A.uuid(other), receiverNodeId: A.uuid(A.object(A.object(self).body).node),
          sensor: Boolean(A.object(self).sensor || A.object(other).sensor), manifold: A.safeData(manifold),
          // 2.4.15 getImpulse 只给法向乘 PTM_RATIO，切向没有换算；统一回 Box2D 单位，避免混用量纲。
          impulse: impulse ? { normal: (nativeNormal as number[]).map(value => value / ratio), tangent: [...nativeTangent as number[]] } : null,
          disabled: Boolean(A.object(contact).disabled), disabledOnce: Boolean(A.object(contact).disabledOnce) });
      } catch (error) { captureFailure = CocosError.from(error).message; active = false; }
    };
    const Observer = A.call(cc, 'Class', { extends: cc.Component,
      onBeginContact: (contact: unknown, self: unknown, other: unknown) => record('begin', contact, self, other),
      onEndContact: (contact: unknown, self: unknown, other: unknown) => record('end', contact, self, other),
      onPreSolve: (contact: unknown, self: unknown, other: unknown) => record('preSolve', contact, self, other),
      onPostSolve: (contact: unknown, self: unknown, other: unknown) => record('postSolve', contact, self, other),
    });
    try {
      for (const body of eligible) observers.push(A.object(A.call(body.node, 'addComponent', Observer)));
      for (frame = 0; frame < count; frame++) {
        await frames.wait(token);
        if (captureFailure) throw new CocosError('VERIFICATION_FAILED', 'Native contact data capture failed', { cause: captureFailure });
        progress({ rows, dropped, completedFrames: frame + 1, totalFrames: count });
      }
      return { rows, dropped, frames: count, skipped, receiverBodies: eligible.length, coordinateSpace: 'world-pixels', impulseUnits: 'Box2D-native-impulse', ptmRatio: ratio,
        limitations: ['只观察已启用接触监听的刚体，不改变业务监听开关或接触规则', '冲量仅在 postSolve 有效；sensor 通常不产生求解回调', '按接收者记录，双向回调不会去重；法线沿原生接收者方向'] };
    } finally {
      active = false; const failures: string[] = [];
      for (const observer of observers) if (observer.isValid !== false) { try { A.call(observer, 'destroy'); } catch (error) { failures.push(CocosError.from(error).message); } }
      try { A.call(cc.js, 'unregisterClass', Observer); } catch (error) { failures.push(CocosError.from(error).message); }
      if (failures.length) throw new CocosError('OUTCOME_UNKNOWN', 'Contact trace stopped recording but observer cleanup failed', { failures });
    }
  }
}
