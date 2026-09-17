import { Creator2SkeletonMixCapabilities } from './creator2-skeleton-mix.js';
import { Creator2ResourceCapabilities } from './creator2-resources.js';
import { Creator2TweenCapabilities } from './creator2-tween.js';
import { Creator2CameraCapabilities } from './creator2-camera.js';
import { Creator2PhysicsCapabilities } from './creator2-physics.js';
import type { Capability } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';

/** 2.4.15 专用能力独立登记，避免给 Creator 3 添加未经实现的同名承诺。 */
export class Creator2ExpansionCapabilities {
  list(): Capability[] {
    const str = S.string(), index = { type: 'integer', minimum: 0, maximum: 10000 };
    const operations = { type: 'array', minItems: 1, maxItems: 100, items: { oneOf: [
      S.object({ action: { const: 'create' }, key: str, parent: str, name: str, index }, ['action', 'key', 'parent', 'name']),
      S.object({ action: { const: 'move' }, node: str, parent: str, index }, ['action', 'node', 'parent']),
      S.object({ action: { const: 'remove' }, node: str }, ['action', 'node']),
      S.object({ action: { const: 'add_component' }, node: str, type: str }, ['action', 'node', 'type']),
      S.object({ action: { const: 'remove_component' }, componentId: str }, ['action', 'componentId']),
    ] } };
    const structural: Capability[] = (['plan', 'apply'] as const).map(action => ({
      id: `ui.structure.${action}`, title: action === 'plan' ? '规划 UI 节点、层级顺序与组件结构变更' : '按计划执行 UI 结构变更，保留已有节点 UUID',
      description: 'node/parent 使用已有 UUID 或本批 create 的 key；move 保留局部变换。所有对象限定在 rootId 子树内。',
      module: 'F20', context: 'editor', effect: action === 'plan' ? 'read' : 'scene',
      inputSchema: S.object({ rootId: str, rows: operations, ...(action === 'apply' ? { planHash: str } : {}) }, ['rootId', 'rows', ...(action === 'apply' ? ['planHash'] : [])]),
      outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified',
      prerequisites: ['Creator 2.4.15；apply 必须使用相同参数与最新 planHash'],
      rollback: '成功操作归入一组原生 Undo；异常返回 completed/pending，保留现场与 Undo，不盲目重试。',
    }));
    const commands = [
      ['inspect', {}],
      ['scroll', { x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } }],
      ['page', { index: S.integer() }],
      ['slider', { progress: { type: 'number', minimum: 0, maximum: 1 } }],
      ['toggle', { checked: S.boolean() }],
      ['text', { text: { type: 'string', maxLength: 10000 } }],
    ] as const;
    return [...new Creator2SkeletonMixCapabilities().list(), { id: 'runtime.spine.trace_start', title: '追踪 Creator 2 Spine 动画事件', description: '实时模式独立监听；缓存模式转发并恢复业务回调，只支持开始/完成/结束，外部改写回调则报告冲突。', module: 'F20', context: 'runtime', effect: 'read', inputSchema: S.object({ componentId: S.string(), frames: { type: 'integer', minimum: 1, maximum: 300 }, limit: { type: 'integer', minimum: 1, maximum: 5000 }, events: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { type: 'string', enum: ['start', 'interrupt', 'end', 'dispose', 'complete', 'event'] } } }, ['componentId']), outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 2.4.15'], rollback: '移除自有监听并验证原生监听列表' }, { id: 'runtime.dragonbones.trace_start', title: '追踪 Creator 2 DragonBones 动画事件', description: '独立监听原生事件，使用 task.poll/stop 查询取消；缓存模式只支持开始、循环和完成，无事件负载。', module: 'F20', context: 'runtime', effect: 'read', inputSchema: S.object({ componentId: S.string(), frames: { type: 'integer', minimum: 1, maximum: 300 }, limit: { type: 'integer', minimum: 1, maximum: 5000 }, events: { type: 'array', minItems: 1, maxItems: 9, uniqueItems: true, items: { type: 'string', enum: ['start', 'loopComplete', 'complete', 'fadeIn', 'fadeInComplete', 'fadeOut', 'fadeOutComplete', 'frameEvent', 'soundEvent'] } } }, ['componentId']), outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 2.4.15'], rollback: '移除本任务监听，不改业务监听' }, { id: 'runtime.dragonbones.details', title: '检查 Creator 2 DragonBones 骨骼插槽与动画状态', description: '实时模式返回姿态与动画状态，缓存模式仅返回结构并明确状态不可用；分页限制显式报告截断。', module: 'F20', context: 'runtime', effect: 'read', inputSchema: S.object({ componentId: S.string(), limit: { type: 'integer', minimum: 1, maximum: 1000 } }, ['componentId']), outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 2.4.15'], rollback: '只读已有骨架状态，不推进动画' }, { id: 'runtime.spine.details', title: '检查 Creator 2 Spine 骨骼插槽与轨道', description: '实时模式返回姿态与轨道，缓存模式仅返回结构并明确状态不可用；分页限制显式报告截断。', module: 'F20', context: 'runtime', effect: 'read', inputSchema: S.object({ componentId: S.string(), limit: { type: 'integer', minimum: 1, maximum: 1000 } }, ['componentId']), outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 2.4.15'], rollback: '只读已有骨架状态，不推进动画' }, ...new Creator2TweenCapabilities().list(), ...new Creator2PhysicsCapabilities().list(), ...new Creator2CameraCapabilities().list(), ...new Creator2ResourceCapabilities().list(), { id: 'asset.references.audit', description: '检查已保存场景、Prefab、动画或材质源文件中的资源 UUID，区分 AssetDB 缺失与查询失败。', title: '审计已保存资源文件的 UUID 引用', module: 'F20', context: 'editor', effect: 'read', inputSchema: S.object({ url: str }, ['url']), outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 2.4.15'], rollback: '只读扫描' }, { id: 'scene.references', description: '基于原生序列化对象表，定位显式引用；不推断空引用和字符串加载路径。', title: '审计当前场景序列化节点、组件与资源引用', module: 'F20', context: 'editor', effect: 'read', inputSchema: S.object({}), outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 2.4.15'], rollback: '只读扫描' }, ...structural, ...commands.map(([action, properties]): Capability => ({
      id: `runtime.control.${action}`, title: `Creator 2 控件状态与原生操作：${action}`,
      description: '程序化操作并读回原生状态；不模拟用户输入，不额外派发事件。Toggle 保留引擎全局事件策略和分组约束。',
      module: 'F20', context: 'runtime', effect: action === 'inspect' ? 'read' : 'runtime',
      inputSchema: S.object({ componentId: str, ...properties }, ['componentId', ...Object.keys(properties)]),
      outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified',
      prerequisites: ['Creator 2.4.15；写操作要求节点和组件已启用'],
      rollback: '返回前后状态；可显式恢复数值，业务回调的副作用不可自动撤销。',
    }))];
  }
}
