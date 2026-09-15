import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import type { SceneInspector } from './scene.js';

export class AnimationController {
  constructor(private readonly inspector: SceneInspector) {}
  private states(component: RuntimeObject): JsonObject[] {
    const clips = component.clips as Array<RuntimeObject | null>;
    if (!Array.isArray(clips) || clips.length > 128) throw new CocosError('INVALID_ARGUMENT', 'Animation clip list is unavailable or exceeds 128');
    const names = clips.filter((clip): clip is RuntimeObject => Boolean(clip)).map(clip => String(clip.name));
    if (new Set(names).size !== names.length) throw new CocosError('INVALID_ARGUMENT', 'Animation clip names are ambiguous');
    return names.map(name => {
      const state = A.call(component, 'getState', name);
      if (!state) return { name, initialized: false };
      const value = A.object(state);
      return { name, initialized: true, time: Number(value.time), duration: Number(value.duration), speed: Number(value.speed), playing: Boolean(value.isPlaying), paused: Boolean(value.isPaused), weight: Number(value.weight) };
    });
  }
  execute(id: string, p: JsonObject): JsonValue {
    const componentId = Json.string(p.componentId, 'componentId'), component = this.inspector.component(componentId), cc = this.inspector.environment.cc;
    if (typeof cc.Animation !== 'function' || !(component instanceof cc.Animation)) throw new CocosError('INVALID_ARGUMENT', 'Target must be an Animation component');
    const before = this.states(component);
    if (id === 'runtime.animation.state') return { componentId, rows: before, scope: 'native-animation-states', frameVerified: false };
    const name = Json.string(p.name, 'name');
    if (!before.some(row => row.name === name && row.initialized)) throw new CocosError('NOT_FOUND', `Animation state is unavailable: ${name}`);
    const state = A.object(A.call(component, 'getState', name));
    if (id === 'runtime.animation.seek' && (!Number.isFinite(p.time) || Number(p.time) < 0 || Number(p.time) > Number(state.duration))) throw new CocosError('INVALID_ARGUMENT', 'Seek time must be within clip duration');
    if (id === 'runtime.animation.blend' && (!Number.isFinite(p.duration) || Number(p.duration) < 0 || Number(p.duration) > 60)) throw new CocosError('INVALID_ARGUMENT', 'Blend duration must be 0..60 seconds');
    try {
      switch (id) {
        case 'runtime.animation.play': A.call(component, 'play', name); break;
        case 'runtime.animation.blend': A.call(component, 'crossFade', name, p.duration); break;
        case 'runtime.animation.pause': A.call(state, 'pause'); break;
        case 'runtime.animation.resume': A.call(state, 'resume'); break;
        case 'runtime.animation.stop': A.call(state, 'stop'); break;
        // setTime 原生会重置事件采样基线；不主动 sample，避免重复派发用户动画事件。
        case 'runtime.animation.seek': A.call(state, 'setTime', p.time); break;
        default: throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown animation control: ${id}`);
      }
      return { componentId, before, after: this.states(component), frameVerified: false, restorePolicy: '无自动回放或断线重置；参考 before 显式 pause/seek/resume/stop。历史事件和进行中的混合不能回滚。' };
    } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Animation control may have executed; query state before retrying', { componentId, before, cause: CocosError.from(error).message }); }
  }
}
