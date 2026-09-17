import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';

export class Creator2SpineMix {
  constructor(private readonly inspector: SceneInspector) {}
  execute(p: JsonObject, update: boolean): JsonObject {
    const component = this.inspector.component(Json.string(p.componentId, 'componentId'));
    if (this.inspector.type(component) !== 'sp.Skeleton') throw new CocosError('INVALID_ARGUMENT', 'Expected sp.Skeleton');
    if (A.call(component, 'isAnimationCached')) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Spine animation mixing requires realtime mode');
    const raw = A.call(component, 'getState');
    if (!raw) throw new CocosError('CONTEXT_UNAVAILABLE', 'Spine animation state is not initialized');
    const data = A.object(A.object(raw).data), skeleton = A.object(data.skeletonData), table = A.object(data.animationToMixTime);
    const from = Json.string(p.from, 'from'), to = Json.string(p.to, 'to'), key = `${from}.${to}`;
    const fromAnimation = A.call(skeleton, 'findAnimation', from), toAnimation = A.call(skeleton, 'findAnimation', to);
    if (!fromAnimation || !toAnimation) throw new CocosError('NOT_FOUND', 'Spine mix animation not found');
    if (!Array.isArray(skeleton.animations) || skeleton.animations.length > 10000) throw new CocosError('VERIFICATION_FAILED', 'Unexpected Spine animation list');
    const names = (skeleton.animations as RuntimeObject[]).map(animation => String(animation.name)), unique = new Set(names);
    // 2.4.15 以 from + '.' + to 作为键；动画名本身带点可能使不同动画对映射到同一配置。
    if (unique.size !== names.length || names.filter(name => key.startsWith(`${name}.`) && unique.has(key.slice(name.length + 1))).length !== 1) throw new CocosError('OPERATION_CONFLICT', 'Spine native mix key is ambiguous');
    const read = (): JsonObject => {
      const duration = A.call(data, 'getMix', fromAnimation, toAnimation), defaultDuration = data.defaultMix;
      const overrideDuration = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
      if (![duration, defaultDuration, ...(overrideDuration === null ? [] : [overrideDuration])].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) throw new CocosError('VERIFICATION_FAILED', 'Spine mix contains invalid duration');
      return { duration: Number(duration), defaultDuration: Number(defaultDuration), overrideDuration: overrideDuration === null ? null : Number(overrideDuration) };
    };
    const before = read();
    if (!update) return { from, to, ...before, scope: 'runtime-animation-state', affectsExistingTracks: false };
    if (p.duration !== null && (typeof p.duration !== 'number' || !Number.isFinite(p.duration) || p.duration < 0 || p.duration > 30)) throw new CocosError('INVALID_ARGUMENT', 'duration must be null or 0..30 seconds');
    if (Json.canonical(Json.object(p.expected)) !== Json.canonical(before)) throw new CocosError('OPERATION_CONFLICT', 'Spine mix changed since inspection', { current: before });
    try {
      if (p.duration === null) {
        // 移除显式覆盖才能恢复继承 defaultMix；写回当前默认值会永久冻结该动画对的默认行为。
        if (!Reflect.deleteProperty(table, key)) throw new Error('Mix override could not be removed');
      } else A.call(component, 'setMix', from, to, p.duration);
      const after = read();
      if (A.call(component, 'getState') !== raw || after.overrideDuration !== p.duration || after.duration !== (p.duration ?? before.defaultDuration)) throw new Error('Native mix readback differs');
      return { from, to, before, after, scope: 'runtime-animation-state', affectsExistingTracks: false, persisted: false };
    } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Spine mix update or verification failed', { before, cause: CocosError.from(error).message }); }
  }
}
