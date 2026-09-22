import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';
import type { FrameSession } from '../../runtime3-bridge/src/frame-session.js';

export class Creator2DragonBonesEvents {
  static readonly events = ['start', 'loopComplete', 'complete', 'fadeIn', 'fadeInComplete', 'fadeOut', 'fadeOutComplete', 'frameEvent', 'soundEvent'];
  constructor(private readonly inspector: SceneInspector) {}
  private payload(value: unknown): JsonObject | null {
    if (!value || typeof value !== 'object') return null;
    const data = value as RuntimeObject;
    let truncated = false;
    const copy = (key: string): Array<number | string | null> => {
      const values = data[key];
      if (!Array.isArray(values)) return [];
      if (values.length > 8) truncated = true;
      return values.slice(0, 8).map(value => {
        if (key === 'strings' && typeof value === 'string') { if (value.length > 256) truncated = true; return value.slice(0, 256); }
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
      });
    };
    // UserData 与事件一样可被原生池复用；复制并限制负载体积，不保存原生数组引用。
    const ints = copy('ints'), floats = copy('floats'), strings = copy('strings');
    return { ints, floats, strings, truncated };
  }
  async trace(p: JsonObject, frames: FrameSession, progress: (value: JsonObject) => void): Promise<JsonObject> {
    const component = this.inspector.component(Json.string(p.componentId, 'componentId'));
    if (this.inspector.type(component) !== 'dragonBones.ArmatureDisplay') throw new CocosError('INVALID_ARGUMENT', 'Expected dragonBones.ArmatureDisplay');
    const count = Number(p.frames ?? 120), limit = Number(p.limit ?? 1000);
    if (!Number.isInteger(count) || count < 1 || count > 300 || !Number.isInteger(limit) || limit < 1 || limit > 5000) throw new CocosError('INVALID_ARGUMENT', 'Invalid bounded DragonBones trace');
    const events = p.events ?? ['start', 'loopComplete', 'complete'];
    if (!Array.isArray(events) || events.length < 1 || events.length > 9 || new Set(events).size !== events.length || events.some(event => typeof event !== 'string' || !Creator2DragonBonesEvents.events.includes(event))) throw new CocosError('INVALID_ARGUMENT', 'Invalid DragonBones events');
    const cached = Boolean(A.call(component, 'isAnimationCached')), cacheMode = component._cacheMode;
    if (cached && events.some(event => !['start', 'loopComplete', 'complete'].includes(String(event)))) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Cached DragonBones only emits start/loopComplete/complete');
    const rows: JsonObject[] = [], listeners: Array<{ event: string; callback: (value?: unknown) => void }> = [];
    let active = true, dropped = 0, frame = 0;
    const token = frames.token();
    try {
      for (const event of events as string[]) {
        const callback = (value?: unknown): void => {
          if (!active || component._cacheMode !== cacheMode) return;
          if (rows.length >= limit) { dropped++; return; }
          // 原生 EventObject 会被池回收；回调内只复制稳定标量。缓存回调没有 EventObject，不能补造动画名或时间。
          const native = value && typeof value === 'object' ? value as RuntimeObject : null;
          const state = native?.animationState ? A.object(native.animationState) : null;
          rows.push({ event, frame, hasNativePayload: Boolean(native), name: native ? A.safeData(native.name) : null,
            animation: state ? A.safeData(state.name) : null, animationTime: state ? A.safeData(state.currentTime) : null,
            bone: native?.bone ? A.safeData(A.object(native.bone).name) : null, slot: native?.slot ? A.safeData(A.object(native.slot).name) : null, payload: this.payload(native?.data) });
        };
        // 先记录所有权，兼容注册后抛错的原生实现；finally 只移除本任务回调。
        listeners.push({ event, callback }); A.call(component, 'addEventListener', event, callback);
      }
      for (frame = 0; frame < count; frame++) {
        await frames.wait(token);
        if (component.isValid === false) throw new CocosError('STALE_HANDLE', 'DragonBones target destroyed');
        if (component._cacheMode !== cacheMode) throw new CocosError('OPERATION_CONFLICT', 'DragonBones cache mode changed during trace');
        progress({ rows, dropped, completedFrames: frame + 1, totalFrames: count });
      }
      return { rows, dropped, frames: count, cached, businessListenersPreserved: true,
        limitations: cached ? ['缓存事件没有原生负载；动画名、时间和骨骼字段返回 null'] : ['只记录追踪期间原生已分发事件；不触发声音播放、不推进动画'] };
    } finally {
      active = false;
      const failures: string[] = [];
      for (const listener of listeners) {
        try { A.call(component, 'removeEventListener', listener.event, listener.callback); }
        catch (error) { failures.push(CocosError.from(error).message); }
      }
      if (failures.length) throw new CocosError('OUTCOME_UNKNOWN', 'DragonBones trace stopped recording but listener cleanup failed', { failures });
    }
  }
}
