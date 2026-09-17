import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';

export class Creator2DragonBones {
  constructor(private readonly inspector: SceneInspector) {}
  private fields(value: RuntimeObject, keys: string[]): JsonObject { return Object.fromEntries(keys.map(key => [key, A.safeData(value[key])])); }
  details(p: JsonObject): JsonObject {
    const component = this.inspector.component(Json.string(p.componentId, 'componentId'));
    if (this.inspector.type(component) !== 'dragonBones.ArmatureDisplay') throw new CocosError('INVALID_ARGUMENT', 'Expected dragonBones.ArmatureDisplay');
    const limit = Number(p.limit ?? 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new CocosError('INVALID_ARGUMENT', 'limit must be 1..1000');
    const raw = A.call(component, 'armature');
    if (!raw) throw new CocosError('CONTEXT_UNAVAILABLE', 'DragonBones armature is not initialized');
    const armature = A.object(raw), data = A.object(armature.armatureData);
    if (!Array.isArray(data.sortedBones) || !Array.isArray(data.sortedSlots)) throw new CocosError('VERIFICATION_FAILED', 'Unexpected DragonBones armature data');
    const cached = Boolean(A.call(component, 'isAnimationCached'));
    // 缓存模式的 Armature 是缓存求值对象，不能把它的姿态和动画状态当作组件当前显示帧。
    const bones = (data.sortedBones as RuntimeObject[]).slice(0, limit).map(bone => {
      const live = cached ? null : A.call(armature, 'getBone', String(bone.name));
      return { name: String(bone.name), parent: bone.parent ? String(A.object(bone.parent).name) : null,
        length: A.safeData(bone.length), setup: bone.transform ? this.fields(A.object(bone.transform), ['x', 'y', 'rotation', 'skew', 'scaleX', 'scaleY']) : null,
        pose: live ? this.fields(A.object(A.object(live).globalTransformMatrix), ['a', 'b', 'c', 'd', 'tx', 'ty']) : null };
    });
    const slots = (data.sortedSlots as RuntimeObject[]).slice(0, limit).map(slot => {
      const live = cached ? null : A.call(armature, 'getSlot', String(slot.name));
      return { name: String(slot.name), bone: slot.parent ? String(A.object(slot.parent).name) : null,
        setupDisplayIndex: A.safeData(slot.displayIndex), blendMode: A.safeData(slot.blendMode),
        displayIndex: live ? A.safeData(A.object(live).displayIndex) : null, liveAvailable: Boolean(live) };
    });
    const nativeStates = cached ? null : A.call(armature.animation, 'getStates');
    if (nativeStates !== null && !Array.isArray(nativeStates)) throw new CocosError('VERIFICATION_FAILED', 'Unexpected DragonBones animation states');
    const states = Array.isArray(nativeStates) ? nativeStates.slice(0, 32).map(state => ({ ...this.fields(A.object(state),
      ['name', 'layer', 'group', 'currentTime', 'totalTime', 'currentPlayTimes', 'playTimes', 'timeScale', 'weight', 'isPlaying', 'isCompleted', 'isFadeIn', 'isFadeOut', 'isFadeComplete', 'fadeTotalTime']), fadeProgress: A.safeData(A.object(state)._fadeProgress), effectiveWeight: A.safeData(A.object(state)._weightResult) })) : null;
    return { componentId: A.uuid(component), armatureName: A.safeData(component.armatureName), cached, bones, slots, states,
      totals: { bones: data.sortedBones.length, slots: data.sortedSlots.length, states: Array.isArray(nativeStates) ? nativeStates.length : null },
      truncated: data.sortedBones.length > limit || data.sortedSlots.length > limit || Array.isArray(nativeStates) && nativeStates.length > 32,
      poseSpace: 'armature-local', rotationUnit: 'radians', livePoseAvailable: !cached && bones.some(bone => bone.pose !== null), stateAvailable: !cached,
      limitations: cached ? ['缓存模式仅返回静态结构；姿态与动画状态不代表组件显示帧，返回 null'] : ['矩阵属于骨架坐标，不是场景世界坐标；仅读取已有求值结果，不推进动画'] };
  }
}
