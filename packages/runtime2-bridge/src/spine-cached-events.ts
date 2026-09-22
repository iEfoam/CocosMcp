import { CocosError, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { FrameSession } from '../../runtime3-bridge/src/frame-session.js';

/** 2.4.15 缓存事件没有多监听 API；在保留原回调的前提下临时转发，发生外部改写则停止。 */
export class Creator2SpineCachedEvents {
  private static readonly owned = new WeakSet<object>();
  static readonly events = ['start', 'complete', 'end'];
  async trace(component: RuntimeObject, events: string[], count: number, limit: number, frames: FrameSession, progress: (value: JsonObject) => void): Promise<JsonObject> {
    if (events.some(event => !Creator2SpineCachedEvents.events.includes(event))) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Cached Spine only emits start/complete/end');
    if (Creator2SpineCachedEvents.owned.has(component)) throw new CocosError('RESOURCE_BUSY', 'Cached Spine already has an owned trace');
    A.call(component, '_ensureListener');
    const owner = A.object(component._listener), mode = component._cacheMode;
    // 只接受原生数据属性，避免读取/覆盖业务自定义访问器或不可恢复属性。
    for (const event of events) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, event);
      if (!descriptor || !('value' in descriptor) || !descriptor.writable) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Cached Spine listener slot is not writable native data');
      if (descriptor.value !== null && descriptor.value !== undefined && typeof descriptor.value !== 'function') throw new CocosError('INVALID_ARGUMENT', 'Cached Spine callback is not callable');
    }
    Creator2SpineCachedEvents.owned.add(component);
    const rows: JsonObject[] = [], slots: Array<{ event: string; original: unknown; wrapper: (...args: unknown[]) => unknown }> = [];
    let active = true, frame = 0, dropped = 0;
    const token = frames.token();
    try {
      for (const event of events) {
        const original = owner[event];
        const wrapper = function (this: unknown, ...args: unknown[]): unknown {
          try { return typeof original === 'function' ? original.apply(this, args) : undefined; }
          finally {
            if (active && component._cacheMode === mode && component._listener === owner) {
              if (rows.length >= limit) dropped++;
              else {
                const entry = args[0] ? A.object(args[0]) : null;
                // 缓存分支只提供合成的名字和轨道索引；不把它标记为实时 TrackEntry。
                rows.push({ event, frame, animation: entry?.animation ? A.safeData(A.object(entry.animation).name) : null,
                  trackIndex: entry ? A.safeData(entry.trackIndex) : null, trackTime: null, loop: null, payload: null, syntheticEntry: true });
              }
            }
          }
        };
        slots.push({ event, original, wrapper }); owner[event] = wrapper;
      }
      for (frame = 0; frame < count; frame++) {
        await frames.wait(token);
        if (component.isValid === false) throw new CocosError('STALE_HANDLE', 'Spine target destroyed');
        if (component._cacheMode !== mode || component._listener !== owner || slots.some(slot => owner[slot.event] !== slot.wrapper)) throw new CocosError('OPERATION_CONFLICT', 'Cached Spine mode or business callback changed during trace');
        progress({ rows, dropped, completedFrames: frame + 1, totalFrames: count });
      }
      return { rows, dropped, frames: count, cached: true, businessListenersPreserved: true, limitations: ['缓存事件仅提供合成的动画名和轨道索引；不提供实时轨道时间、自定义事件或中断事件'] };
    } finally {
      active = false;
      const failures: string[] = [];
      for (const slot of slots) {
        try {
          // 业务重设回调后不得用旧值覆盖它；只恢复仍由本任务持有的槽。
          if (owner[slot.event] === slot.wrapper) { owner[slot.event] = slot.original; if (owner[slot.event] !== slot.original) throw new Error('Callback restoration failed'); }
        } catch (error) { failures.push(CocosError.from(error).message); }
      }
      if (failures.length) throw new CocosError('OUTCOME_UNKNOWN', 'Cached Spine trace stopped recording but callback restoration failed', { failures });
      Creator2SpineCachedEvents.owned.delete(component);
    }
  }
}
