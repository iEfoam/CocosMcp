import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import type { EditorPort } from './port.js';

export class PrefabService {
  constructor(private readonly port: EditorPort) {}

  async apply(nodeId: string): Promise<JsonObject> {
    const reference = Json.object(await this.port.scene('prefabReference', nodeId));
    const assetUuid = Json.string(reference.assetUuid, 'prefab asset UUID');
    const info = Json.object(Json.value(await this.port.request('asset-db', 'query-asset-info', assetUuid)));
    const url = Json.string(info.url, 'prefab URL');
    if (info.type !== 'cc.Prefab' || info.readonly === true || !url.endsWith('.prefab')) throw new CocosError('INVALID_ARGUMENT', 'Expected an editable prefab asset');
    const path = await (await ProjectPaths.open(this.port.projectPath)).asset(url);
    const before = createHash('sha256').update(await readFile(path)).digest('hex');
    const nativeResult = Json.value(await this.port.request('scene', 'apply-prefab', nodeId));
    const after = createHash('sha256').update(await readFile(path)).digest('hex');
    const resourceChanged = before !== after;
    // 3.8.8 的原生调用可能返回 false 但已经写回文件；保留原始结果，并独立报告资源证据，不能将布尔值等同于保存状态。
    if (nativeResult !== true && !resourceChanged) throw new CocosError('OUTCOME_UNKNOWN', 'Prefab apply produced no observable asset write; inspect overrides before retrying', {assetUuid, url, nativeResult, sourceHash: after});
    return {assetUuid, url, nativeResult, resourceChanged, sourceHashBefore: before, sourceHash: after,
      verification: resourceChanged ? 'asset-write-observed' : 'native-acknowledged-no-content-change'};
  }
}
