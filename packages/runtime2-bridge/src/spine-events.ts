import { Creator2SpineCachedEvents } from './spine-cached-events.js';
import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';
import type { FrameSession } from '../../runtime3-bridge/src/frame-session.js';

export class Creator2SpineEvents {
  static readonly events = ['start', 'interrupt', 'end', 'dispose', 'complete', 'event'];
  constructor(private readonly inspector: SceneInspector) {}
  async trace(p: JsonObject, frames: FrameSession, progress: (value: JsonObject) => void): Promise<JsonObject> {
    const component = this.inspector.component(Json.string(p.componentId, 'componentId'));
    if (this.inspector.type(component) !== 'sp.Skeleton') throw new CocosError('INVALID_ARGUMENT', 'Expected sp.Skeleton');
    const count = Number(p.frames ?? 120), limit = Number(p.limit ?? 1000);
    if (!Number.isInteger(count) || count < 1 || count > 300 || !Number.isInteger(limit) || limit < 1 || limit > 5000) throw new CocosError('INVALID_ARGUMENT', 'Invalid bounded Spine trace');
    const cached = Boolean(A.call(component, 'isAnimationCached'));
    const events = p.events ?? (cached ? Creator2SpineCachedEvents.events : Creator2SpineEvents.events);
    if (!Array.isArray(events) || events.length < 1 || events.length > 6 || new Set(events).size !== events.length || events.some(event => typeof event !== 'string' || !Creator2SpineEvents.events.includes(event))) throw new CocosError('INVALID_ARGUMENT', 'Invalid Spine events');
    if (cached) return new Creator2SpineCachedEvents().trace(component, events as string[], count, limit, frames, progress);
    const rawState = A.call(component, 'getState');
    if (!rawState) throw new CocosError('CONTEXT_UNAVAILABLE', 'Spine animation state is not initialized');
    const state = A.object(rawState);
    if (typeof state.addListener !== 'function' || typeof state.removeListener !== 'function' || !Array.isArray(state.listeners)) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Spine native listener API is unavailable');
    const rows: JsonObject[] = [], listener: RuntimeObject = {}, token = frames.token();
    let active = true, dropped = 0, frame = 0;
    for (const event of events as string[]) listener[event] = (rawEntry: unknown, rawEvent?: unknown): void => {
      if (!active || A.call(component, 'isAnimationCached') || A.call(component, 'getState') !== rawState) return;
      if (rows.length >= limit) { dropped++; return; }
      // TrackEntry 和事件均可回收；只复制当前回调的标量，不持有业务对象或序列化整个骨架。
      const entry = A.object(rawEntry), data = rawEvent ? A.object(rawEvent) : null;
      rows.push({ event, frame, animation: entry.animation ? A.safeData(A.object(entry.animation).name) : null,
        trackIndex: A.safeData(entry.trackIndex), trackTime: A.safeData(entry.trackTime), loop: A.safeData(entry.loop),
        payload: data ? { name: data.data ? A.safeData(A.object(data.data).name) : null, time: A.safeData(data.time), intValue: A.safeData(data.intValue), floatValue: A.safeData(data.floatValue), stringValue: A.safeData(data.stringValue) } : null });
    };
    try {
      A.call(state, 'addListener', listener);
      for (frame = 0; frame < count; frame++) {
        await frames.wait(token);
        if (component.isValid === false) throw new CocosError('STALE_HANDLE', 'Spine target destroyed');
        if (A.call(component, 'isAnimationCached') || A.call(component, 'getState') !== rawState) throw new CocosError('OPERATION_CONFLICT', 'Spine animation state changed during trace');
        progress({ rows, dropped, completedFrames: frame + 1, totalFrames: count });
      }
      return { rows, dropped, frames: count, cached: false, businessListenersPreserved: true };
    } finally {
      active = false;
      try {
        A.call(state, 'removeListener', listener);
        if (!Array.isArray(state.listeners) || state.listeners.includes(listener)) throw new Error('Native listener still registered');
      } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Spine trace stopped recording but listener cleanup failed', { cause: CocosError.from(error).message }); }
    }
  }
}
