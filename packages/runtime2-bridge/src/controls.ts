import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';

/** 程序化赋值与真实输入分开：不调用私有事件派发，不修改 Toggle 全局兼容开关。 */
export class Creator2Controls {
  constructor(private readonly inspector: SceneInspector) {}
  private state(c: RuntimeObject, type: string): JsonObject {
    const common = { type, enabled: Boolean(c.enabled), active: Boolean(A.object(c.node).activeInHierarchy), interactable: c.interactable === undefined ? null : Boolean(c.interactable) };
    switch (type) {
      case 'cc.ScrollView':
        if (!c.content) throw new CocosError('CONTEXT_UNAVAILABLE', 'ScrollView content is missing');
        return { ...common, offset: A.safeData(A.call(c, 'getScrollOffset')), maxOffset: A.safeData(A.call(c, 'getMaxScrollOffset')), horizontal: Boolean(c.horizontal), vertical: Boolean(c.vertical) };
      case 'cc.PageView': return { ...common, index: Number(A.call(c, 'getCurrentPageIndex')), pages: (A.call(c, 'getPages') as unknown[]).length };
      case 'cc.Slider': return { ...common, progress: Number(c.progress) };
      case 'cc.Toggle': return { ...common, checked: Boolean(c.isChecked) };
      case 'cc.EditBox': return { ...common, text: String(c.string), maxLength: Number(c.maxLength) };
      default: throw new CocosError('INVALID_ARGUMENT', 'Expected ScrollView, PageView, Slider, Toggle or EditBox');
    }
  }
  private number(value: unknown, name: string, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new CocosError('INVALID_ARGUMENT', `${name} must be between 0 and ${max}`);
    return value;
  }
  execute(id: string, p: JsonObject): JsonObject {
    const c = this.inspector.component(Json.string(p.componentId, 'componentId')), type = this.inspector.type(c), before = this.state(c, type);
    const action = id.slice('runtime.control.'.length);
    if (action === 'inspect') return before;
    const expected: Record<string, string> = { scroll: 'cc.ScrollView', page: 'cc.PageView', slider: 'cc.Slider', toggle: 'cc.Toggle', text: 'cc.EditBox' };
    if (expected[action] !== type) throw new CocosError('INVALID_ARGUMENT', `Control action ${action} does not match ${type}`);
    if (!before.enabled || !before.active || before.interactable === false) throw new CocosError('CONTEXT_UNAVAILABLE', 'Control is disabled or inactive');
    switch (action) {
      case 'scroll': {
        const max = Json.object(before.maxOffset), x = this.number(p.x, 'x', Number(max.x)), y = this.number(p.y, 'y', Number(max.y));
        if ((!c.horizontal && x !== 0) || (!c.vertical && y !== 0)) throw new CocosError('INVALID_ARGUMENT', 'Requested scrolling axis is disabled');
        // 使用零时长原生滚动，避免把异步滚动开始误报为已到达目标。
        A.call(c, 'stopAutoScroll'); A.call(c, 'scrollToOffset', A.construct(this.inspector.environment.cc.Vec2, [x, y]), 0); break;
      }
      case 'page': {
        const index = this.number(p.index, 'index', Number(before.pages) - 1);
        if (!Number.isInteger(index)) throw new CocosError('INVALID_ARGUMENT', 'Page index must be an integer');
        A.call(c, 'scrollToPage', index, 0); break;
      }
      case 'slider': c.progress = this.number(p.progress, 'progress', 1); break;
      case 'toggle':
        if (typeof p.checked !== 'boolean') throw new CocosError('INVALID_ARGUMENT', 'checked must be boolean');
        c.isChecked = p.checked; break;
      case 'text':
        if (typeof p.text !== 'string' || p.text.length > 10000) throw new CocosError('INVALID_ARGUMENT', 'text must contain at most 10000 UTF-16 code units');
        c.string = p.text; break;
    }
    const after = this.state(c, type);
    return { before, after, requested: p, inputMode: 'programmatic', visualVerified: false,
      accepted: action === 'toggle' ? after.checked === p.checked : action === 'text' ? after.text === p.text : action === 'page' ? after.index === p.index : action === 'slider' ? after.progress === p.progress : null,
      limitations: ['原生分组约束可能拒绝切换，EditBox 可能截断文本；以 after 为准', '程序化操作不能证明点击、键盘输入或最终事件接收者'] };
  }
}
