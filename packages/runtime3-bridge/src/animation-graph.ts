import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import { FeatureSupport as F } from './feature-support.js';
import { FrameSession } from './frame-session.js';
import type { SceneInspector } from './scene.js';

export class AnimationGraphObserver {
  constructor(private readonly inspector: SceneInspector, private readonly frames: FrameSession) {}
  private state(value: unknown): JsonValue {
    if (!value) return null;
    const state = A.object(value);
    return { progress: A.safeData(state.progress), stateId: typeof state.__DEBUG_ID__ === 'string' ? state.__DEBUG_ID__ : null };
  }
  private component(p: JsonObject): RuntimeObject {
    const type = F.require(F.type(this.inspector.environment.cc, 'animation.AnimationController'), 'animation.AnimationController');
    const component = this.inspector.component(Json.string(p.componentId, 'componentId'));
    if (typeof type !== 'function' || !(component instanceof type)) throw new CocosError('INVALID_ARGUMENT', '目标不是 AnimationController');
    F.methods(component, ['getVariables', 'getValue', 'getCurrentStateStatus', 'getCurrentTransition', 'getCurrentClipStatuses', 'getNextStateStatus', 'getLayerWeight']);
    if (!component.graph) throw new CocosError('UNSUPPORTED_CAPABILITY', 'AnimationController 未配置动画图');
    if (!component.enabledInHierarchy) throw new CocosError('CONTEXT_UNAVAILABLE', '动画控制器未激活');
    // 3.8.8 的所有状态读取都会直接断言求值器存在；资源加载失败或尚未初始化时提前降级。
    if ('_graphEval' in component && !component._graphEval) throw new CocosError('UNSUPPORTED_CAPABILITY', '当前动画图尚未建立可用的运行时求值器');
    return component;
  }
  private snapshot(component: RuntimeObject, layer: number): JsonObject {
    if (component.isValid === false) throw new CocosError('STALE_HANDLE', '动画控制器已销毁');
    const graph = A.object(component.graph), layers = graph.layers;
    if (!Array.isArray(layers)) throw new CocosError('UNSUPPORTED_CAPABILITY', '当前动画图不提供可验证的层列表');
    if (!Number.isInteger(layer) || layer < 0 || layer >= layers.length) throw new CocosError('INVALID_ARGUMENT', '动画层索引越界');
    const variables = Array.from(A.call(component, 'getVariables') as Iterable<[string, unknown]>);
    if (variables.length > 256) throw new CocosError('RESOURCE_BUSY', '动画变量超过 256 项');
    return { layer, variables: variables.map(([name, spec]) => ({ name, definition: A.safeData(spec), value: A.safeData(A.call(component, typeof component.getValue_experimental === 'function' ? 'getValue_experimental' : 'getValue', name)) })),
      current: this.state(A.call(component, 'getCurrentStateStatus', layer)), next: this.state(A.call(component, 'getNextStateStatus', layer)),
      transition: A.safeData(A.call(component, 'getCurrentTransition', layer)), weight: A.safeData(A.call(component, 'getLayerWeight', layer)),
      clips: Array.from(A.call(component, 'getCurrentClipStatuses', layer) as Iterable<RuntimeObject>).slice(0,64).map(row => ({ uuid: row.clip ? A.uuid(row.clip) : null, weight: A.safeData(row.weight) })) };
  }
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    const component = this.component(p), layer = Number(p.layer ?? 0), before = this.snapshot(component, layer);
    if (id.endsWith('.inspect')) return { supported: true, ...before };
    if (id.endsWith('.set_parameter')) {
      F.methods(component, ['setValue']); const name = Json.string(p.name, 'name');
      const row = (before.variables as JsonObject[]).find(row => row.name === name);
      if (!row) throw new CocosError('INVALID_ARGUMENT', '动画变量不存在');
      if (typeof p.value !== typeof row.value || !['number', 'boolean'].includes(typeof p.value) || (typeof p.value === 'number' && !Number.isFinite(p.value))) throw new CocosError('INVALID_ARGUMENT', '动画参数类型不匹配');
      const integerType = F.type(this.inspector.environment.cc, 'animation.VariableType.INTEGER');
      if (integerType !== undefined && Json.object(row.definition).type === integerType && !Number.isInteger(p.value)) throw new CocosError('INVALID_ARGUMENT', '整数动画参数不能接受小数');
      try { A.call(component, 'setValue', name, p.value); return { supported: true, before, after: this.snapshot(component, layer), eventsReversible: false }; }
      catch (error) { throw new CocosError('OUTCOME_UNKNOWN', '动画参数可能已修改，请查询状态后再操作', { cause: CocosError.from(error).message }); }
    }
    const count = Number(p.frames ?? 60), token = this.frames.token(), rows: JsonObject[] = [], started = performance.now();
    if (!Number.isInteger(count) || count < 1 || count > 300) throw new CocosError('INVALID_ARGUMENT', 'frames 必须为 1..300');
    for (let frame = 0; frame < count; frame++) {
      if (performance.now() - started > 15000) throw new CocosError('CONTEXT_UNAVAILABLE', '动画采样超过 15 秒');
      await this.frames.wait(token); const snapshot = this.snapshot(component, layer); rows.push({ frame, ...snapshot });
      if (id.endsWith('.assert') && snapshot.current) {
        if (Json.object(snapshot.current).stateId === null) throw new CocosError('UNSUPPORTED_CAPABILITY', '当前构建未提供状态调试标识，无法按名称断言');
        if (Json.object(snapshot.current).stateId === p.stateId) return { supported: true, matched: true, rows };
      }
    }
    return { supported: true, rows, ...(id.endsWith('.assert') ? { matched: false, reason: '目标状态未在限定帧内出现；状态标识依赖引擎调试信息' } : {}) };
  }
}
