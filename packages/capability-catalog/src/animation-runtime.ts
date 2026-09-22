import type { Capability, JsonSchema } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';
export class RuntimeAnimationCapabilities {
  list(): Capability[] {
    return ['state', 'play', 'pause', 'resume', 'stop', 'seek', 'blend'].map(action => {
      const properties: Record<string, JsonSchema> = { componentId: S.string() }, required = ['componentId'];
      if (action !== 'state') { properties.name = S.string(); required.push('name'); }
      if (action === 'seek') { properties.time = { type: 'number', minimum: 0, maximum: 600 }; required.push('time'); }
      if (action === 'blend') { properties.duration = { type: 'number', minimum: 0, maximum: 60 }; required.push('duration'); }
      return { id: `runtime.animation.${action}`, module: 'F24', title: `动画原生状态与播放控制：${action}`, description: '查询命名动画状态或执行明确播放操作；返回前后状态，不把命令返回当作实际帧验证', context: 'runtime', effect: action === 'state' ? 'read' : 'runtime',
        inputSchema: S.object(properties, required), outputSchema: {}, versions: [3], supportedMajors: [3], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 3.8.8 开发运行时桥接'],
        rollback: '按 before 显式 pause/seek/resume/stop；已触发业务事件与混合过渡不可自动回滚，失败先查状态' } as Capability;
    });
  }
}
