import type { Capability } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';
export class Creator2PhysicsCapabilities {
  list(): Capability[] {
    const coordinate = { type: 'number', minimum: -1000000, maximum: 1000000 }, vector = S.object({ x: coordinate, y: coordinate }, ['x', 'y']);
    const bodies: Capability[] = ['inspect', 'force', 'impulse'].map(action => ({
      id: `runtime.rigidbody2d.${action}`, title: `Creator 2 刚体状态与施力：${action}`, description: '2.4.15 原生像素坐标与力/冲量单位；不重复做 PTM 换算，不隐式推进物理帧。',
      module: 'F20', context: 'runtime', effect: action === 'inspect' ? 'read' : 'runtime',
      inputSchema: S.object({ componentId: S.string(), ...(action === 'inspect' ? {} : { vector, point: vector, wake: S.boolean() }) }, action === 'inspect' ? ['componentId'] : ['componentId', 'vector', 'point', 'wake']),
      outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified',
      prerequisites: ['Creator 2.4.15；施力要求物理启用且动态刚体初始化完成'], rollback: '物理副作用不可用编辑器 Undo 回滚；不确定结果不得自动重试',
    }));
    const collisions: Capability[] = ['inspect', 'trace'].map(action => ({ id: `runtime.collision2d.${action}`, title: `Creator 2 普通碰撞检查：${action}`, description: '检查原生碰撞矩阵及缓存世界边界，或在有限帧内通过自有组件观察回调。', module: 'F20', context: 'runtime', effect: action === 'inspect' ? 'read' : 'runtime', inputSchema: S.object({ rootId: S.string(), ...(action === 'trace' ? { frames: { type: 'integer', minimum: 1, maximum: 300 }, limit: { type: 'integer', minimum: 1, maximum: 5000 } } : {}) }, action === 'trace' ? ['rootId', 'frames'] : ['rootId']), outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 2.4.15；trace 要求普通碰撞系统已启用'], rollback: 'finally 停止记录并销毁自有观察组件；不替换业务回调' }));
    const trace = collisions.find(capability => capability.id === 'runtime.collision2d.trace')!;
    const tasks: Capability[] = [
      { ...trace, id: 'runtime.collision2d.trace_start', title: '启动 Creator 2 碰撞采样任务', description: '立即返回任务 ID；采样期间可执行其他命令，30 秒总时限，可查询与停止。' },
      ...['poll', 'stop'].map(action => ({ ...trace, id: `runtime.task.${action}`, title: `Creator 2 采样任务：${action}`, description: '查询进度与结果，或停止并等待自有观察器清理；切场景与断线后任务 ID 失效。', effect: action === 'poll' ? 'read' as const : 'runtime' as const, inputSchema: S.object({ taskId: S.string() }, ['taskId']) })),
    ];
    return [...bodies, ...collisions, ...tasks, { ...trace, id: 'runtime.physics2d.contact_trace_start', title: '追踪 Creator 2 Box2D 接触与冲量', description: '异步任务观察 begin/end/preSolve/postSolve；复制接触点、法线和 postSolve 冲量，冲量统一为 Box2D 原生单位。使用 task.poll/stop。', prerequisites: ['Creator 2.4.15；物理已启用，目标刚体启用 enabledContactListener'], rollback: '仅清理自有观察组件，不更改接触监听开关或业务方法' }, { id: 'runtime.joint2d.inspect', title: '检查 Creator 2 关节连接、锚点与配置', description: '读取原生关节就绪状态与世界锚点，不调用重建 API。', module: 'F20', context: 'runtime', effect: 'read', inputSchema: S.object({ componentId: S.string() }, ['componentId']), outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 2.4.15'], rollback: '只读查询' }];
  }
}
