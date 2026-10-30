import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { AssetUuid } from '../../asset-policy/src/uuid.js';
import type { EditorPort } from './port.js';

/** 只查询已比较子树的 UUID 引用；AssetDB 未找到不等价于证明引擎内置资源不存在。 */
export class PrefabReferenceValidation {
  constructor(private readonly port: EditorPort) {}
  async inspect(references: JsonObject[]): Promise<{ rows: JsonObject[]; issues: JsonObject[] }> {
    const uuids = new AssetUuid(), ids = [...new Set(references.map(row => uuids.normalize(Json.string(row.assetUuid, 'Asset reference UUID'))))].sort();
    if (ids.length > 500 || references.length > 2000) throw new CocosError('RESOURCE_BUSY', 'Prefab asset lookup budget exceeded');
    const results = new Map<string, JsonObject>(); let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const assetUuid = ids[next++]!;
        try {
          const value = await this.port.request('asset-db', 'query-asset-info', assetUuid);
          if (!value) { results.set(assetUuid, { assetUuid, status: 'not-found' }); continue; }
          const info = Json.object(Json.value(value));
          if (info.invalid === true || info.imported === false || info.isDirectory === true) {
            results.set(assetUuid, { assetUuid, status: 'unavailable' }); continue;
          }
          results.set(assetUuid, typeof info.uuid === 'string' && uuids.normalize(info.uuid) === assetUuid
            ? { assetUuid, status: 'resolved', url: typeof info.url === 'string' ? info.url : null, type: typeof info.type === 'string' ? info.type : null }
            : { assetUuid, status: 'identity-mismatch' });
        } catch { results.set(assetUuid, { assetUuid, status: 'lookup-failed' }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
    const rows = ids.map(id => results.get(id)!);
    const issues = references.filter(row => results.get(uuids.normalize(String(row.assetUuid)))!.status !== 'resolved')
      .map(row => ({ ...row, code: 'ASSET_REFERENCE_UNVERIFIED', reason: results.get(uuids.normalize(String(row.assetUuid)))!.status! }));
    return { rows, issues };
  }
}
