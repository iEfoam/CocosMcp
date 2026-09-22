import type { Capability } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';
export class RuntimeAssetCapabilities {
  list(): Capability[] {
    const handle = S.object({ handle: S.string() }, ['handle']);
    const source = S.object({ uuid: S.string(), timeoutMs: { type: 'integer', minimum: 100, maximum: 30000 } }, ['uuid']);
    return [
      ['runtime.asset.load', '加载本地 UUID 资源并取得工具独有引用句柄；不自动绑定', 'runtime', source],
      ['runtime.asset.preload', '下载本地 UUID 资源；明确尚未解析或参与绘制', 'runtime', source],
      ['runtime.asset.inspect', '读取资源句柄、引用计数及有效性', 'read', handle],
      ['runtime.asset.release', '只归还工具取得的一份引用，不强制释放共享引擎缓存', 'runtime', handle],
      ['runtime.bundle.inspect', '查询当前已加载 Bundle；不卸载游戏资源', 'read', S.object({})],
    ].map(([id, title, effect, inputSchema]) => ({ id, title, description: title, effect, inputSchema, module: 'F38', context: 'runtime', outputSchema: {}, versions: [3], supportedMajors: [3], implementation: 'implemented', verification: 'unverified',
      prerequisites: ['Creator 3.8.8 开发运行时桥接'], rollback: '断线或切场景归还工具引用，挂起请求失效；引擎下载不能保证取消，不强制清空游戏缓存',
    } as Capability));
  }
}
