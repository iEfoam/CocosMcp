import { CocosError, Json, type JsonValue } from '../../../packages/contracts/src/index.js';

/** Creator IPC 会丢失异常的自定义字段；仅桥接自己的 dispatch 使用结构化错误，不让参数错误污染控制台。 */
export class SceneResponse {
  static async capture(run: () => Promise<JsonValue>): Promise<JsonValue> {
    try { return await run(); }
    catch (error) { return { __cocosSceneError: Json.value(CocosError.from(error, 'EDITOR_ERROR').toJSON()) }; }
  }

  static unwrap(value: unknown): unknown {
    if (value && typeof value === 'object' && '__cocosSceneError' in value) throw CocosError.from(value.__cocosSceneError, 'EDITOR_ERROR');
    return value;
  }
}
