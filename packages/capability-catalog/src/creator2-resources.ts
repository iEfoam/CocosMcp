import type { Capability } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';
export class Creator2ResourceCapabilities {
  list(): Capability[] {
    return ['snapshot', 'diff', 'trend'].map(action => ({ id: `runtime.resources.${action}`, title: `Creator 2 资源驻留诊断：${action}`, description: '读取资源缓存、引用计数、直接依赖及 Bundle；对比显式基线，不自动释放资源或宣称泄漏。', module: 'F20', context: 'runtime', effect: 'read', inputSchema: S.object(action === 'diff' ? { baseline: S.record() } : action === 'trend' ? { snapshotIds: { ...S.array(S.string()), minItems: 2, maxItems: 4 } } : {}, action === 'diff' ? ['baseline'] : action === 'trend' ? ['snapshotIds'] : []), outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 2.4.15'], rollback: '只读快照与比较，不改变引用计数' }));
  }
}
