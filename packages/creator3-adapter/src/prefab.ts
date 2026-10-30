import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import type { EditorPort } from './port.js';
import { PrefabSources } from './prefab-sources.js';
import { PrefabDiff } from '../../ui-core/src/prefab-diff.js';
import { AssetUuid } from '../../asset-policy/src/uuid.js';
import { PrefabReferenceValidation } from './prefab-reference-validation.js';

export class PrefabService {
  constructor(private readonly port: EditorPort) {}

  async diff(nodeId: string): Promise<JsonObject> {
    if (this.port.version !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Prefab diff requires Creator 3.8.8');
    const reference = Json.object(await this.port.scene('prefabReference', nodeId)), uuids = new AssetUuid(), assetUuid = uuids.normalize(Json.string(reference.assetUuid, 'Prefab asset UUID'));
    const sources = new PrefabSources(this.port), source = await sources.capture(assetUuid), url = source.url;
    const snapshot = Json.object(await this.port.scene('prefab.snapshot', nodeId));
    if (snapshot.rootId !== nodeId || typeof snapshot.assetUuid !== 'string' || uuids.normalize(snapshot.assetUuid) !== assetUuid) throw new CocosError('STALE_REVISION', 'Prefab association changed during inspection');
    // 不接受字符串/缺失计数，避免隐式转换把原生协议缺失降级为普通差异。
    for (const field of ['observedNodeCount', 'observedComponentCount']) {
      const count = snapshot[field];
      if (typeof count !== 'number' || !Number.isInteger(count) || count < (field === 'observedNodeCount' ? 1 : 0) || count > 10000) {
        throw new CocosError('VERIFICATION_FAILED', 'Native Prefab snapshot count is invalid', { field });
      }
    }
    if (snapshot.serialized === undefined || snapshot.serialized === null) throw new CocosError('VERIFICATION_FAILED', 'Native Prefab serialized snapshot is missing');
    // 旧插件没有实际组件检查证据时保持不完整，不能把缺字段视为“没有失效脚本”。
    let componentIssues: JsonObject[];
    if (snapshot.componentIssues === undefined) componentIssues = [{ side: 'instance', code: 'COMPONENT_AVAILABILITY_UNVERIFIED' }];
    else {
      if (!Array.isArray(snapshot.componentIssues) || snapshot.componentIssues.length > 1000) throw new CocosError('VERIFICATION_FAILED', 'Native component inspection is invalid');
      componentIssues = snapshot.componentIssues.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.code !== 'string' || !value.code) throw new CocosError('VERIFICATION_FAILED', 'Native component issue is invalid');
        return value;
      });
    }
    const comparer = new PrefabDiff();
    let comparison = comparer.compare(source.text!, snapshot.serialized!, Number(snapshot.observedNodeCount), Number(snapshot.observedComponentCount), assetUuid, componentIssues);
    const referenceValidation = await new PrefabReferenceValidation(this.port).inspect(comparison.assetReferences as JsonObject[]);
    if (referenceValidation.issues.length) comparison = comparer.compare(source.text!, snapshot.serialized!, Number(snapshot.observedNodeCount), Number(snapshot.observedComponentCount), assetUuid, [...componentIssues, ...referenceValidation.issues]);
    await sources.verify();
    return { ...comparison, assetReferenceValidation: referenceValidation.rows, nodeId, assetUuid, url, sourceHash: source.sha256, sourceDependencies: source.dependencies, sourceGraphHash: source.graphHash,
      instanceHash: createHash('sha256').update(Json.canonical(snapshot.serialized!)).digest('hex'), nativeSource: snapshot.source ?? null };
  }

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
