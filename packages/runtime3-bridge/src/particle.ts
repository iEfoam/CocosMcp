import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import type { SceneInspector } from './scene.js';

export class ParticleController {
  constructor(private readonly inspector: SceneInspector) {}
  private snapshot(component: RuntimeObject, dimension: string): JsonObject {
    if (dimension === '2') return { active: Boolean(component.active), particleCount: Number(component.particleCount), totalParticles: Number(component.totalParticles), autoRemoveOnFinish: Boolean(component.autoRemoveOnFinish) };
    return { isPlaying: Boolean(component.isPlaying), isPaused: Boolean(component.isPaused), isStopped: Boolean(component.isStopped), isEmitting: Boolean(component.isEmitting), time: Number(component.time), particleCount: Number(A.call(component, 'getParticleCount')), capacity: Number(component.capacity) };
  }
  execute(id: string, p: JsonObject): JsonValue {
    const match = /^runtime\.particle([23])d\.(state|play|pause|stop|stop_emitting|restart)$/.exec(id);
    if (!match) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Unknown particle operation');
    const dimension = match[1]!, action = match[2]!, methods: Record<string, string> = dimension === '2' ? { restart: 'resetSystem', stop_emitting: 'stopSystem' } : { play: 'play', pause: 'pause', stop: 'stop', stop_emitting: 'stopEmitting' };
    if (action !== 'state' && !methods[action]) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Operation is not supported by this particle dimension');
    const componentId = Json.string(p.componentId, 'componentId'), component = this.inspector.component(componentId), type = this.inspector.environment.cc[dimension === '2' ? 'ParticleSystem2D' : 'ParticleSystem'];
    if (typeof type !== 'function') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Particle module unavailable');
    if (!(component instanceof type)) throw new CocosError('INVALID_ARGUMENT', 'Target has a different particle component type');
    const before = this.snapshot(component, dimension);
    if (action === 'state') return { componentId, ...before, frameVerified: false };
    // 2D 系统完成时可能销毁用户节点；不临时改配置掩盖该副作用。
    if (dimension === '2' && component.autoRemoveOnFinish) throw new CocosError('OPERATION_CONFLICT', 'autoRemoveOnFinish may destroy the node; particle control is refused');
    if (!component.enabledInHierarchy) throw new CocosError('OPERATION_CONFLICT', 'Particle component must be active and enabled');
    try { A.call(component, methods[action]!); return { componentId, before, after: this.snapshot(component, dimension), frameVerified: false, restorePolicy: '借用已有组件；不在断线时销毁或重置。stop/restart 清除的粒子和模拟时间不可恢复，不自动重试' }; }
    catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Particle action may have executed; inspect before retrying', { componentId, before, cause: CocosError.from(error).message }); }
  }
}
