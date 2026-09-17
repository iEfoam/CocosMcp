import type { Capability } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';
export class Creator2TweenCapabilities {
  list(): Capability[] {
    return ['plan', 'start'].map(action => ({ id: `runtime.tween.${action}`, title: `Creator 2 Tween 编排：${action}`, description: 'to/by/delay/sequence/parallel 与有限重复；属性限 x/y/angle/scaleX/scaleY/opacity，缓动限 linear/quadIn/quadOut/quadInOut/sineIn/sineOut/sineInOut。start 返回可查询、停止的任务 ID。', module: 'F20', context: 'runtime', effect: action === 'plan' ? 'read' : 'runtime',
      inputSchema: S.object({ nodeId: S.string(), steps: { ...S.array(S.record()), minItems: 1, maxItems: 100 }, repeat: { type: 'integer', minimum: 1, maximum: 20 } }, ['nodeId', 'steps']), outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 2.4.15；总时长最多 25 秒；并行分支不得写同一属性'], rollback: '仅停止本工具 Tween，取消保留当前值；不调用 stopAllActions 或恢复可能被业务修改的属性' }));
  }
}
