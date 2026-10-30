import { createHash } from 'node:crypto';
import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import type { EditorPort } from './port.js';
import { PrefabService } from './prefab.js';
import { AssetUuid } from '../../asset-policy/src/uuid.js';

export type PrefabChangeAction = 'apply' | 'restore';

/** 计划绑定源依赖图及实例快照；不完整的比较不能授权整实例覆盖。 */
export class PrefabChanges {
  constructor(private readonly port: EditorPort) {}
  async plan(nodeId: string, action: PrefabChangeAction): Promise<JsonObject> {
    if (action !== 'apply' && action !== 'restore') throw new CocosError('INVALID_ARGUMENT', 'Invalid Prefab change action');
    const diff = await new PrefabService(this.port).diff(nodeId);
    if (diff.comparisonComplete !== true) throw new CocosError('VERIFICATION_FAILED', 'Incomplete Prefab comparison cannot authorize changes', { issues: diff.issues ?? [] });
    if (action === 'apply') {
      const info = Json.object(Json.value(await this.port.request('asset-db', 'query-asset-info', diff.assetUuid)));
      if (typeof info.uuid !== 'string' || new AssetUuid().normalize(info.uuid) !== diff.assetUuid || info.url !== diff.url || info.type !== 'cc.Prefab' || info.readonly === true) throw new CocosError('INVALID_ARGUMENT', 'Expected an editable Prefab asset');
    }
    const root = (diff.tree as JsonObject[])[0];
    // 3.8.8 原生 restore 保留实例根名称；只豁免已验证的这一字段，且要求前后差异逐字一致。
    const preservedRows = action === 'restore' ? (diff.rows as JsonObject[]).filter(row => row.key === root?.key
      && row.kind === 'node' && row.status === 'property-override' && Json.object(row.change!).path === 'properties/_name') : [];
    const binding = { format: 1, projectPath: this.port.projectPath, version: this.port.version, nodeId, action,
      assetUuid: diff.assetUuid!, url: diff.url!, sourceHash: diff.sourceHash!, sourceGraphHash: diff.sourceGraphHash!, instanceHash: diff.instanceHash!, preservedRows };
    const planHash = createHash('sha256').update(Json.canonical(binding)).digest('hex');
    return { ...binding, planHash, expectedHash: diff.sourceGraphHash!, sourceDependencies: diff.sourceDependencies!, rows: diff.rows!, sceneSavedByTool: false };
  }
  async execute(nodeId: string, action: PrefabChangeAction, expectedHash: string, planHash: string): Promise<JsonObject> {
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || !/^[a-f0-9]{64}$/.test(planHash)) throw new CocosError('INVALID_ARGUMENT', 'Prefab change requires SHA-256 guards');
    const current = await this.plan(nodeId, action);
    if (current.expectedHash !== expectedHash || current.planHash !== planHash) throw new CocosError('STALE_REVISION', 'Prefab change plan is stale; inspect a fresh plan');
    // 写调用一旦发出，异常或验收失败均不能证明未执行；禁止客户端盲目重放。
    let nativeResult: JsonObject | undefined;
    try {
      nativeResult = action === 'apply'
        ? { result: Json.value(await this.port.request('scene', 'apply-prefab', nodeId)) }
        : { result: Json.value(await this.port.request('scene', 'restore-prefab', nodeId)) };
      const after = await new PrefabService(this.port).diff(nodeId);
      const dependencies = (value: JsonObject) => (value.sourceDependencies as JsonObject[]).filter(row => row.assetUuid !== value.assetUuid);
      if (after.assetUuid !== current.assetUuid || after.comparisonComplete !== true || !Array.isArray(after.rows) || Json.canonical(after.rows) !== Json.canonical(current.preservedRows!)
        || (action === 'restore' && after.sourceGraphHash !== current.sourceGraphHash)
        || Json.canonical(dependencies(after)) !== Json.canonical(dependencies(current))) {
        throw new CocosError('VERIFICATION_FAILED', 'Prefab change did not converge to the source', { after });
      }
      return { nodeId, action, assetUuid: after.assetUuid!, url: after.url!, planHash, expectedHash,
        sourceHash: after.sourceHash!, sourceGraphHash: after.sourceGraphHash!, instanceHash: after.instanceHash!,
        nativeResult, preservedRows: after.rows, verification: after.rows.length ? 'source-instance-converged-with-preserved-properties' : 'source-instance-converged', sceneSavedByTool: false };
    } catch (error) {
      throw new CocosError('OUTCOME_UNKNOWN', 'Prefab change was dispatched but verification is incomplete; inspect before retrying', {
        nodeId, action, planHash, nativeResult: nativeResult ?? null, cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
