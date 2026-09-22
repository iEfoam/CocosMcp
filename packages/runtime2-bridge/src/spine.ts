import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';

export class Creator2Spine {
  constructor(private readonly inspector: SceneInspector) {}
  private fields(value: RuntimeObject, keys: string[]): JsonObject { return Object.fromEntries(keys.map(key => [key, A.safeData(value[key])])); }
  details(p: JsonObject): JsonObject {
    const component = this.inspector.component(Json.string(p.componentId, 'componentId'));
    if (this.inspector.type(component) !== 'sp.Skeleton') throw new CocosError('INVALID_ARGUMENT', 'Expected sp.Skeleton');
    const limit = Number(p.limit ?? 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new CocosError('INVALID_ARGUMENT', 'limit must be 1..1000');
    if (!component.skeletonData) throw new CocosError('CONTEXT_UNAVAILABLE', 'Spine skeleton data is absent');
    const data = A.object(A.call(component.skeletonData, 'getRuntimeData', true));
    if (!Array.isArray(data.bones) || !Array.isArray(data.slots)) throw new CocosError('VERIFICATION_FAILED', 'Unexpected Spine skeleton data');
    const cached = Boolean(A.call(component, 'isAnimationCached'));
    // 缓存动画共享或复用骨架求值对象；findBone 返回值不能冒充本组件当前显示帧的姿态。
    const bones = (data.bones as RuntimeObject[]).slice(0, limit).map(bone => {
      const live = cached ? null : A.call(component, 'findBone', String(bone.name));
      return { name: String(bone.name), parent: bone.parent ? String(A.object(bone.parent).name) : null,
        setup: this.fields(bone, ['length', 'x', 'y', 'rotation', 'scaleX', 'scaleY', 'shearX', 'shearY']),
        pose: live ? this.fields(A.object(live), ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'worldX', 'worldY', 'a', 'b', 'c', 'd']) : null };
    });
    const slots = (data.slots as RuntimeObject[]).slice(0, limit).map(slot => {
      const live = cached ? null : A.call(component, 'findSlot', String(slot.name));
      const attachment = live ? A.object(live).attachment : null;
      return { name: String(slot.name), bone: slot.boneData ? String(A.object(slot.boneData).name) : null, setupAttachment: A.safeData(slot.attachmentName), blendMode: A.safeData(slot.blendMode),
        attachment: attachment ? { name: String(A.object(attachment).name), type: this.inspector.type(attachment) } : null, liveAvailable: Boolean(live) };
    });
    const state = cached ? null : A.call(component, 'getState');
    const nativeTracks = state ? A.object(state).tracks : null;
    if (nativeTracks !== null && !Array.isArray(nativeTracks)) throw new CocosError('VERIFICATION_FAILED', 'Unexpected Spine animation tracks');
    const tracks = Array.isArray(nativeTracks) ? nativeTracks.slice(0, 32).map((raw, index) => {
      if (!raw) return { index, active: false };
      const entry = A.object(raw);
      return { index, active: true, animation: entry.animation ? String(A.object(entry.animation).name) : null,
        ...this.fields(entry, ['trackTime', 'trackEnd', 'animationStart', 'animationEnd', 'loop', 'timeScale', 'alpha', 'mixTime', 'mixDuration']),
        mixingFrom: entry.mixingFrom && A.object(entry.mixingFrom).animation ? String(A.object(A.object(entry.mixingFrom).animation).name) : null,
        queuedAnimation: entry.next && A.object(entry.next).animation ? String(A.object(A.object(entry.next).animation).name) : null };
    }) : null;
    return { componentId: A.uuid(component), cached, cacheMode: A.safeData(component._cacheMode), bones, slots, tracks,
      totals: { bones: data.bones.length, slots: data.slots.length, tracks: Array.isArray(nativeTracks) ? nativeTracks.length : null },
      truncated: data.bones.length > limit || data.slots.length > limit || Array.isArray(nativeTracks) && nativeTracks.length > 32,
      poseSpace: 'skeleton-local', livePoseAvailable: !cached && bones.some(bone => bone.pose !== null), trackStateAvailable: !cached && Boolean(state),
      limitations: cached ? ['缓存模式仅返回静态骨架结构；姿态和轨道状态不可作为当前显示帧读取'] : ['骨骼 worldX/worldY 属于骨架坐标，不是场景世界坐标', '只读取已有求值状态，不主动推进动画；轨道混合链仅显示直接前驱'] };
  }
}
