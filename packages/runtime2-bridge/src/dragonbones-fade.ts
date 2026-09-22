import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';

export class Creator2DragonBonesFade {
  static readonly modes = ['none', 'sameLayer', 'sameGroup', 'sameLayerAndGroup', 'all', 'single'];
  constructor(private readonly inspector: SceneInspector) {}
  private states(animation: RuntimeObject): RuntimeObject[] {
    const states = A.call(animation, 'getStates');
    if (!Array.isArray(states)) throw new CocosError('VERIFICATION_FAILED', 'Unexpected DragonBones animation states');
    return [...states] as RuntimeObject[];
  }
  private summary(state: RuntimeObject): JsonObject {
    return Object.fromEntries(['name', 'layer', 'group', 'currentTime', 'playTimes', 'weight', 'fadeTotalTime', 'isFadeIn', 'isFadeOut', 'isFadeComplete'].map(key => [key, A.safeData(state[key])]));
  }
  fade(p: JsonObject): JsonObject {
    const component = this.inspector.component(Json.string(p.componentId, 'componentId'));
    if (this.inspector.type(component) !== 'dragonBones.ArmatureDisplay') throw new CocosError('INVALID_ARGUMENT', 'Expected dragonBones.ArmatureDisplay');
    if (A.call(component, 'isAnimationCached')) throw new CocosError('UNSUPPORTED_CAPABILITY', 'DragonBones blending requires realtime mode');
    const raw = A.call(component, 'armature');
    if (!raw) throw new CocosError('CONTEXT_UNAVAILABLE', 'DragonBones armature is not initialized');
    const animation = A.object(A.object(raw).animation), name = Json.string(p.name, 'name');
    if (!Array.isArray(animation.animationNames) || !animation.animationNames.includes(name)) throw new CocosError('NOT_FOUND', 'DragonBones animation not found');
    const duration = p.duration, layer = p.layer ?? 0, playTimes = p.playTimes ?? 1, group = p.group ?? '', mode = p.fadeOutMode ?? 'sameLayerAndGroup';
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 30 || typeof layer !== 'number' || !Number.isInteger(layer) || layer < 0 || layer > 31 || typeof playTimes !== 'number' || !Number.isInteger(playTimes) || playTimes < 0 || playTimes > 100 || typeof group !== 'string' || group.length > 64 || typeof mode !== 'string' || !Creator2DragonBonesFade.modes.includes(mode)) throw new CocosError('INVALID_ARGUMENT', 'Invalid bounded DragonBones fade parameters');
    const beforeStates = this.states(animation);
    if (beforeStates.length >= 32) throw new CocosError('RESOURCE_BUSY', 'DragonBones fade is limited to fewer than 32 existing states');
    const before = beforeStates.map(state => this.summary(state));
    try {
      const selected = A.call(animation, 'fadeIn', name, duration, playTimes, layer, group, Creator2DragonBonesFade.modes.indexOf(mode));
      const afterStates = this.states(animation);
      if (!selected || !afterStates.includes(A.object(selected))) throw new Error('Native fade did not return a registered state');
      // Single 可以复用已有同动画状态，其图层/分组/时长保持原值；返回原生实际值而非伪造请求值。
      return { before, after: afterStates.map(state => this.summary(state)), selected: this.summary(A.object(selected)), reused: beforeStates.includes(A.object(selected)),
        requested: { name, duration, layer, group, playTimes, fadeOutMode: mode }, persisted: false,
        limitations: ['淡出可影响匹配规则内的业务动画；不自动恢复已经推进的时间线，也不伪造缓存模式混合'] };
    } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'DragonBones fade or readback failed', { before, cause: CocosError.from(error).message }); }
  }
}
