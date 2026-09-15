import type { Capability, JsonSchema } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';
export class RuntimeInteractionCapabilities {
  list(): Capability[] {
    const rows: Capability[] = [];
    const add = (id: string, module: string, title: string, effect: Capability['effect'], inputSchema: JsonSchema): void => {
      rows.push({ id, module, title, description: title, context: 'runtime', effect, inputSchema, outputSchema: {}, versions: [3], supportedMajors: [3], implementation: 'implemented', verification: 'unverified',
        prerequisites: ['Creator 3.8.8 开发运行时桥接与对应引擎模块'], rollback: '物理查询不步进；媒体操作先查 before/after，业务事件不可回滚，不盲目重试' });
    };
    const n = { type: 'number', minimum: -1000000, maximum: 1000000 }, v2 = S.object({ x: n, y: n }, ['x', 'y']), v3 = S.object({ x: n, y: n, z: n }, ['x', 'y', 'z']);
    const limits = { mask: { type: 'integer', minimum: 0, maximum: 4294967295 }, limit: { type: 'integer', minimum: 1, maximum: 500 } };
    for (const dimension of [2, 3]) add(`runtime.physics${dimension}d.inspect`, dimension === 2 ? 'F33' : 'F34', `读取 ${dimension}D 物理世界开关和重力；不修改模拟`, 'read', S.object({}));
    add('runtime.physics2d.raycast', 'F33', '按世界坐标线段查询 2D 全部夹具命中；复制并排序有限结果', 'read', S.object({ start: v2, end: v2, ...limits }, ['start', 'end']));
    add('runtime.physics3d.raycast', 'F34', '按归一化方向和最大距离查询 3D 射线命中', 'read', S.object({ origin: v3, direction: v3, maxDistance: { type: 'number', exclusiveMinimum: 0, maximum: 100000 }, queryTrigger: S.boolean(), ...limits }, ['origin', 'direction']));
    for (const media of ['audio', 'video']) for (const action of ['state', 'play', 'pause', 'stop', 'seek']) {
      const properties: Record<string, JsonSchema> = { componentId: S.string() }, required = ['componentId'];
      if (action === 'seek') { properties.time = { type: 'number', minimum: 0, maximum: 86400 }; required.push('time'); }
      add(`runtime.${media}.${action}`, 'F35', `${media} 原生组件操作 ${action}；返回当前状态，真实播放进度另行验证`, action === 'state' ? 'read' : 'runtime', S.object(properties, required));
    }
    add('runtime.webview.inspect', 'F35', '只读检查 WebView 配置存在性；不导航或执行网页代码', 'read', S.object({ componentId: S.string() }, ['componentId']));
    return rows;
  }
}
