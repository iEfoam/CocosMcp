import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import type { EditorPort } from './port.js';

/** Creator 的 query-assets 不处理 cc 类型过滤；过滤必须发生在分页之前。 */
export class AssetQuery {
  constructor(private readonly port: EditorPort) {}

  async execute(params: JsonObject): Promise<JsonValue> {
    const offset = Number(params.offset ?? 0);
    const limit = Number(params.limit ?? 100);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new CocosError('INVALID_ARGUMENT', 'Asset pagination requires a nonnegative offset and positive limit');
    }
    const result = await this.port.request('asset-db', 'query-assets', { pattern: params.pattern ?? 'db://assets/**' });
    if (!Array.isArray(result)) throw new CocosError('EDITOR_ERROR', 'AssetDB returned a non-array resource list');
    const rows = result.map(row => Json.object(Json.value(row))).filter(row => !params.type || row.type === params.type);
    return { rows: rows.slice(offset, offset + limit), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null };
  }
}
