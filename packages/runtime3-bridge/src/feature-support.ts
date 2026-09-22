import { CocosError, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';

/** 缺模块是可预期的业务结果；无效参数、目标丢失和原生执行失败不能伪装为不支持。 */
export class FeatureSupport {
  static readonly source = 'https://github.com/cocos/cocos-engine/tree/411f98df047c25902f93440d4b22925c2fb65461';
  static owns(id: string): boolean { return /^(runtime\.)?(path|debug|animation_graph|sorting|postprocess|character|probe|ik|skinning)\./.test(id); }
  static unsupported(id: string, reason: string, details: JsonObject = {}): JsonObject {
    return { supported: false, status: 'unsupported', code: 'UNSUPPORTED_CAPABILITY', capabilityId: id, reason, ...details };
  }
  static async run(id: string, version: string, action: () => JsonValue | Promise<JsonValue>): Promise<JsonValue> {
    if (version !== '3.8.8') return this.unsupported(id, '当前适配仅支持 Creator 3.8.8', { actualVersion: version, requiredVersion: '3.8.8' });
    try { return await action(); }
    catch (error) {
      if (error instanceof CocosError && ['UNSUPPORTED_CAPABILITY', 'UNSUPPORTED_VERSION'].includes(error.code)) return this.unsupported(id, error.message);
      throw error;
    }
  }
  static type(cc: RuntimeObject, path: string): unknown {
    let current: unknown = cc;
    for (const key of path.split('.')) {
      if (!current || !['object', 'function'].includes(typeof current)) return undefined;
      current = (current as RuntimeObject)[key];
    }
    return current;
  }
  static require(value: unknown, label: string): RuntimeObject {
    if (!value || !['object', 'function'].includes(typeof value)) throw new CocosError('UNSUPPORTED_CAPABILITY', `缺少引擎模块或接口：${label}`);
    return A.object(value);
  }
  static methods(value: RuntimeObject, names: string[]): void {
    for (const name of names) if (typeof value[name] !== 'function') throw new CocosError('UNSUPPORTED_CAPABILITY', `当前环境不支持接口：${name}`);
  }
}
