import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';
import type { FrameSession } from '../../runtime3-bridge/src/frame-session.js';

interface Step { action: string; duration: number; properties: JsonObject; easing: string; children: Step[]; keys: string[] }
export class Creator2Tween {
  private static readonly owned = new WeakSet<object>();
  constructor(private readonly inspector: SceneInspector) {}
  private prepare(p: JsonObject) {
    const node = this.inspector.node(Json.string(p.nodeId, 'nodeId'));
    let count = 0;
    const parse = (raw: unknown, depth: number): Step => {
      if (++count > 100 || depth > 4) throw new CocosError('INVALID_ARGUMENT', 'Tween composition exceeds 100 steps or depth 4');
      const row = Json.object(raw), action = String(row.action);
      if (!['to', 'by', 'delay', 'sequence', 'parallel'].includes(action)) throw new CocosError('INVALID_ARGUMENT', 'Unsupported tween action');
      if (action === 'sequence' || action === 'parallel') {
        if (!Array.isArray(row.steps) || !row.steps.length) throw new CocosError('INVALID_ARGUMENT', 'Composition requires nonempty steps');
        const children = row.steps.map(child => parse(child, depth + 1)), keys = children.flatMap(child => child.keys);
        // 并行动作写同一属性的结果依赖执行顺序，规划阶段明确拒绝。
        if (action === 'parallel' && new Set(keys).size !== keys.length) throw new CocosError('OPERATION_CONFLICT', 'Parallel tween branches write the same property');
        return { action, duration: action === 'parallel' ? Math.max(...children.map(child => child.duration)) : children.reduce((total, child) => total + child.duration, 0), properties: {}, easing: 'linear', children, keys: [...new Set(keys)] };
      }
      const duration = Number(row.duration);
      if (!Number.isFinite(duration) || duration < 0.001 || duration > 25) throw new CocosError('INVALID_ARGUMENT', 'Tween duration must be 0.001..25 seconds');
      const properties = action === 'delay' ? {} : Json.object(row.properties), keys = Object.keys(properties);
      if (action !== 'delay' && !keys.length) throw new CocosError('INVALID_ARGUMENT', 'Tween requires properties');
      for (const key of keys) {
        const value = properties[key];
        const bound = key === 'opacity' ? 255 : key === 'scaleX' || key === 'scaleY' ? 100 : 100000;
        if (!['x', 'y', 'angle', 'scaleX', 'scaleY', 'opacity'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > bound || key === 'opacity' && action === 'to' && value < 0) throw new CocosError('INVALID_ARGUMENT', `Invalid tween property: ${key}`);
      }
      const easing = String(row.easing ?? 'linear');
      if (!['linear', 'quadIn', 'quadOut', 'quadInOut', 'sineIn', 'sineOut', 'sineInOut'].includes(easing)) throw new CocosError('INVALID_ARGUMENT', 'Unsupported easing');
      return { action, duration, properties, easing, children: [], keys };
    };
    const root = parse({ action: 'sequence', steps: p.steps }, 0), repeat = Number(p.repeat ?? 1);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20 || root.duration * repeat > 25) throw new CocosError('INVALID_ARGUMENT', 'Tween repeat must be 1..20 and total duration at most 25 seconds');
    return { node, root, repeat, duration: root.duration * repeat };
  }
  plan(p: JsonObject): JsonObject {
    const { node, root, repeat, duration } = this.prepare(p);
    return { nodeId: A.uuid(node), properties: root.keys, repeat, duration, before: this.state(node, root.keys), executable: true,
      limitations: ['规划不锁定业务动画；start 时重新校验，不能保证其他业务动作不同时修改目标', '相对属性受原生节点 setter 约束；取消保留当前值，不自动回滚业务状态'] };
  }
  private state(node: RuntimeObject, keys: string[]): JsonObject { return Object.fromEntries(keys.map(key => [key, A.safeData(node[key])])); }
  async run(p: JsonObject, frames: FrameSession, progress: (value: JsonObject) => void): Promise<JsonObject> {
    const { node, root, repeat, duration } = this.prepare(p), cc = this.inspector.environment.cc;
    if (!node.activeInHierarchy || node.isValid === false) throw new CocosError('CONTEXT_UNAVAILABLE', 'Tween requires an active valid node');
    if (Creator2Tween.owned.has(node)) throw new CocosError('RESOURCE_BUSY', 'Another MCP tween owns this node');
    const build = (step: Step): RuntimeObject => {
      const tween = A.object(A.call(cc, 'tween', node));
      if (step.action === 'sequence') for (const child of step.children) A.call(tween, 'then', build(child));
      else if (step.action === 'parallel') A.call(tween, 'parallel', ...step.children.map(build));
      else if (step.action === 'delay') A.call(tween, 'delay', step.duration);
      else A.call(tween, step.action, step.duration, step.properties, { easing: step.easing });
      return tween;
    };
    const tween = build(root), before = this.state(node, root.keys), rows: JsonObject[] = [], token = frames.token();
    let completed = false, frame = 0, dropped = 0;
    A.call(tween, 'union'); if (repeat > 1) A.call(tween, 'repeat', repeat);
    A.call(tween, 'call', () => { completed = true; });
    Creator2Tween.owned.add(node);
    try {
      A.call(tween, 'start');
      while (!completed) {
        await frames.wait(token);
        if (node.isValid === false) throw new CocosError('STALE_HANDLE', 'Tween target was destroyed');
        frame++;
        if (rows.length < 600) rows.push({ frame, values: this.state(node, root.keys) }); else dropped++;
        progress({ frame, rows, dropped, completed, values: this.state(node, root.keys) });
        if (frame > 10000) throw new CocosError('RESOURCE_BUSY', 'Tween exceeded frame budget');
      }
      return { nodeId: A.uuid(node), before, after: this.state(node, root.keys), duration, rows, dropped, completed: true, ownership: 'mcp-created-tween-only' };
    } finally {
      try { A.call(tween, 'stop'); Creator2Tween.owned.delete(node); }
      catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Owned tween cleanup failed', { cause: CocosError.from(error).message }); }
    }
  }
}
