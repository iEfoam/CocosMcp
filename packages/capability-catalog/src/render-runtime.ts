import type { Capability, JsonSchema } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';
export class RenderRuntimeCapabilities {
  list(): Capability[] {
    const rows: Capability[] = [];
    const add = (id: string, module: string, title: string, effect: Capability['effect'], inputSchema: JsonSchema): void => {
      rows.push({ id, module, title, description: title, context: 'runtime', effect, inputSchema, outputSchema: {}, versions: [3], supportedMajors: [3], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 3.8.8 运行时桥接与对应引擎模块'], rollback: effect === 'read' ? '只读查询' : '先查询状态；清除的粒子不可恢复，不自动重试，不在断线时改变游戏组件' });
    };
    add('runtime.graphics.inspect', 'F32', '查询当前图形设备、能力、引擎内存计数；不等同于驱动总显存', 'read', S.object({}));
    add('runtime.graphics.formats', 'F32', '查询指定 gfx 格式支持的用途；不分配 GPU 资源', 'read', S.object({ formats: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]*$', maxLength: 64 } } }, ['formats']));
    for (const dimension of [2, 3]) for (const action of dimension === 2 ? ['state', 'restart', 'stop_emitting'] : ['state', 'play', 'pause', 'stop', 'stop_emitting']) {
      add(`runtime.particle${dimension}d.${action}`, 'F27', `${dimension}D 粒子原生操作 ${action}；真实绘制另行验收`, action === 'state' ? 'read' : 'runtime', S.object({ componentId: S.string() }, ['componentId']));
    }
    return rows;
  }
}
