import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { AssetUuid } from '../../asset-policy/src/uuid.js';

interface Entity { key: string; index: number; kind: 'node' | 'component'; parent: string | null; order: number; fileId: string; scope: string[]; asset: JsonValue; record: JsonObject }
interface Graph { table: JsonObject[]; entities: Map<string, Entity>; byIndex: Map<number, string>; issues: JsonObject[]; root: string; propertyVisits: number; assetUuid?: string; assetReferences: JsonObject[] }

/** 按原生 fileId + 嵌套实例路径比较，绝不以名称或运行时 UUID 猜测对象对应关系。 */
export class PrefabDiff {
  private readonly uuids = new AssetUuid();
  private problem(issues: JsonObject[], value: JsonObject): void {
    if (issues.length >= 1000) throw new CocosError('RESOURCE_BUSY', 'Prefab comparison issue budget exceeded');
    issues.push(value);
  }
  private graph(input: JsonValue, side: string): Graph {
    const value: unknown = typeof input === 'string' ? JSON.parse(input) : input;
    if (!Array.isArray(value) || !value.length || value.length > 100000) throw new CocosError('VERIFICATION_FAILED', 'Expected a bounded native Prefab object table');
    const table = value.map(row => Json.object(row)), entities = new Map<string, Entity>(), byIndex = new Map<number, string>(), issues: JsonObject[] = [];
    const reference = (value: JsonValue | undefined): number | undefined => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isInteger(value.__id__)) return undefined;
      const index = Number(value.__id__); return index >= 0 && index < table.length ? index : undefined;
    };
    const object = (value: JsonValue | undefined): JsonObject => {
      const index = reference(value); return index !== undefined ? table[index]! : value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    };
    const rootIndex = table[0]!.__type__ === 'cc.Prefab' ? reference(table[0]!.data) : 0;
    if (rootIndex === undefined || table[rootIndex]?.__type__ !== 'cc.Node') throw new CocosError('VERIFICATION_FAILED', 'Prefab root is unavailable in serialized snapshot');
    const visited = new Set<number>();
    const visit = (index: number, parent: string | null, scope: string[], kind: Entity['kind'], order: number, depth: number): string => {
      if (depth > 128 || entities.size >= 10000) throw new CocosError('RESOURCE_BUSY', 'Prefab hierarchy comparison budget exceeded');
      if (visited.has(index)) { this.problem(issues, { side, code: 'DUPLICATE_OR_CYCLIC_HIERARCHY', index }); return byIndex.get(index) ?? 'unresolved'; }
      visited.add(index);
      const record = table[index]!, info = object(kind === 'node' ? record._prefab : record.__prefab);
      // 子列表与反向归属必须一致；否则不能把损坏/压缩快照解释成真实的结构变化。
      if (parent !== null) {
        const owner = reference(kind === 'node' ? record._parent : record.node ?? record._node);
        if (owner === undefined || byIndex.get(owner) !== parent) this.problem(issues, { side, code: 'HIERARCHY_OWNER_MISMATCH', index, kind });
      }
      const nested = object(info.instance), fileId = typeof info.fileId === 'string' ? info.fileId : '';
      if ((kind === 'node' ? record._prefab : record.__prefab) && !fileId) this.problem(issues, { side, code: 'BROKEN_PREFAB_ASSOCIATION', index });
      if (info.instance && !nested.fileId) this.problem(issues, { side, code: 'NESTED_INSTANCE_ID_MISSING', index });
      if (kind === 'node' && parent && info.instance && record._children === undefined) this.problem(issues, { side, code: 'NESTED_SNAPSHOT_NOT_EXPANDED', index });
      const currentScope = kind === 'node' && parent !== null && typeof nested.fileId === 'string' && nested.fileId ? [...scope, nested.fileId] : scope;
      let key = JSON.stringify([...currentScope, kind, fileId]);
      if (!fileId) {
        key = `${side}:unlinked:${index}`;
        if (side === 'source') this.problem(issues, { side, code: 'SOURCE_FILE_ID_MISSING', index });
      }
      if (entities.has(key)) { this.problem(issues, { side, code: 'AMBIGUOUS_FILE_ID', key, index }); key = `${side}:ambiguous:${index}`; }
      entities.set(key, { key, index, kind, parent, order, fileId, scope: currentScope, asset: info.asset ?? null, record }); byIndex.set(index, key);
      if (kind === 'node') for (const [field, childKind] of [['_children', 'node'], ['_components', 'component']] as const) {
        if (!(field in record)) this.problem(issues, { side, code: 'HIERARCHY_LIST_MISSING', index, field });
        const children = record[field] ?? [];
        if (!Array.isArray(children)) { this.problem(issues, { side, code: 'INVALID_HIERARCHY_LIST', index, field }); continue; }
        if (children.length > 10000) throw new CocosError('RESOURCE_BUSY', 'Prefab hierarchy list budget exceeded');
        children.forEach((value, order) => {
          const child = reference(value);
          if (child === undefined || childKind === 'node' && table[child]?.__type__ !== 'cc.Node'
            || childKind === 'component' && (typeof table[child]?.__type__ !== 'string' || table[child]?.__type__ === 'cc.Node')) { this.problem(issues, { side, code: 'BROKEN_HIERARCHY_REFERENCE', index, field, order }); return; }
          visit(child, key, currentScope, childKind, order, depth + 1);
        });
      }
      return key;
    };
    const root = visit(rootIndex, null, [], 'node', 0, 0);
    return { table, entities, byIndex, issues, root, propertyVisits: 0, assetReferences: [] };
  }
  private properties(graph: Graph, entity: Entity, side: string): JsonObject {
    let visited = 0;
    const normalize = (value: JsonValue, path: string, ancestors = new Set<number>(), depth = 0): JsonValue => {
      if (++visited > 100000 || ++graph.propertyVisits > 200000 || depth > 64) throw new CocosError('RESOURCE_BUSY', 'Prefab property comparison budget exceeded');
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map((row, index) => normalize(row, `${path}[${index}]`, ancestors, depth + 1));
      if (typeof value.__uuid__ === 'string') {
        if (graph.assetReferences.length >= 1000) throw new CocosError('RESOURCE_BUSY', 'Prefab asset reference occurrence budget exceeded');
        graph.assetReferences.push({ assetUuid: this.uuids.normalize(value.__uuid__), side, key: entity.key, path });
      }
      if ('__id__' in value) {
        const index = Number(value.__id__);
        if (!Number.isInteger(value.__id__) || index < 0 || !graph.table[index]) {
          this.problem(graph.issues, { side, key: entity.key, path, code: 'BROKEN_PROPERTY_REFERENCE' }); return { unresolvedReference: true };
        }
        const key = graph.byIndex.get(index); if (key) return { prefabObject: key };
        if (ancestors.has(index)) { this.problem(graph.issues, { side, key: entity.key, path, code: 'CYCLIC_VALUE_REFERENCE' }); return { unresolvedReference: true }; }
        const target = graph.table[index]!;
        if (target.__type__ === 'cc.Node' || 'node' in target || '_node' in target) {
          this.problem(graph.issues, { side, key: entity.key, path, code: 'EXTERNAL_OBJECT_REFERENCE' }); return { externalObject: target._id ?? null, type: target.__type__ ?? null };
        }
        return normalize(target, path, new Set([...ancestors, index]), depth + 1);
      }
      const result: JsonObject = {};
      for (const [key, row] of Object.entries(value)) Object.defineProperty(result, key, { value: key === '__uuid__' && typeof row === 'string' ? this.uuids.normalize(row) : normalize(row, `${path}.${key}`, ancestors, depth + 1), enumerable: true });
      return result;
    };
    const result: JsonObject = {};
    const excluded = new Set(['_id', '_prefab', '__prefab', '_parent', '_children', '_components', 'node', '_node', '_objFlags', '_editorExtras', '__editorExtras__']);
    for (const [key, value] of Object.entries(entity.record)) if (!excluded.has(key)) Object.defineProperty(result, key, { value: normalize(value, key), enumerable: true });
    let asset = entity.asset;
    if (asset && typeof asset === 'object' && !Array.isArray(asset) && '__id__' in asset) {
      const index = Number(asset.__id__);
      // 保存的 Prefab 以对象表自身引用资源，实例则常用 UUID；仅在已知源身份时消除表示差异。
      if (Number.isInteger(asset.__id__) && graph.table[index]?.__type__ === 'cc.Prefab' && index === 0 && graph.assetUuid) asset = { __uuid__: graph.assetUuid };
      else this.problem(graph.issues, { side, key: entity.key, code: 'UNRESOLVED_PREFAB_ASSET_REFERENCE' });
    }
    return { hierarchy: { parent: entity.parent, order: entity.order }, properties: result, ...(entity.parent && entity.kind === 'node' ? { assetAssociation: normalize(asset, 'assetAssociation') } : {}) };
  }
  compare(source: JsonValue, instance: JsonValue, observedNodeCount?: number, observedComponentCount?: number, assetUuid?: string, assetIssues: JsonObject[] = []): JsonObject {
    const left = this.graph(source, 'source'), right = this.graph(instance, 'instance');
    if (assetUuid) { left.assetUuid = assetUuid; right.assetUuid = assetUuid; }
    if (left.root !== right.root) right.issues.push({ side: 'instance', code: 'ROOT_FILE_ID_MISMATCH' });
    if (observedNodeCount !== undefined && [...right.entities.values()].filter(row => row.kind === 'node').length !== observedNodeCount) right.issues.push({ side: 'instance', code: 'SERIALIZED_HIERARCHY_INCOMPLETE', observedNodeCount });
    if (observedComponentCount !== undefined && [...right.entities.values()].filter(row => row.kind === 'component').length !== observedComponentCount) right.issues.push({ side: 'instance', code: 'SERIALIZED_COMPONENTS_INCOMPLETE', observedComponentCount });
    const before = new Map<string, JsonObject>(), after = new Map<string, JsonObject>();
    for (const entity of left.entities.values()) before.set(entity.key, this.properties(left, entity, 'source'));
    for (const entity of right.entities.values()) after.set(entity.key, this.properties(right, entity, 'instance'));
    if (assetIssues.length > 2000) throw new CocosError('RESOURCE_BUSY', 'Prefab asset issue budget exceeded');
    const issues = [...left.issues, ...right.issues, ...assetIssues], complete = issues.length === 0, rows: JsonObject[] = [], entries = new Map<string, JsonObject>();
    for (const key of new Set([...left.entities.keys(), ...right.entities.keys()])) {
      const old = left.entities.get(key), current = right.entities.get(key), entity = current ?? old!;
      const changes = old && current ? Json.diff(before.get(key)!, after.get(key)!, 10001) as JsonObject[] : [];
      if (changes.some(row => row.kind === 'truncated') || rows.length + changes.length + (!old || !current ? 1 : 0) > 10000) throw new CocosError('RESOURCE_BUSY', 'Prefab diff output budget exceeded');
      const status = !old ? complete ? 'added' : 'unverified-added' : !current ? complete ? 'removed' : 'unverified-missing' : changes.length ? complete ? 'modified' : 'unverified-modified' : 'unchanged';
      if (!old || !current) rows.push({ key, kind: entity.kind, status, fileId: entity.fileId, scope: entity.scope, sourceIndex: old?.index ?? null, instanceIndex: current?.index ?? null });
      // 压缩嵌套源缺少默认字段时，差异可能只是展开表示，不能标成已确认的用户覆盖。
      for (const change of changes) rows.push({ key, kind: entity.kind, status: complete ? 'property-override' : 'unverified-property-difference', change });
      entries.set(key, { key, kind: entity.kind, name: String(entity.record._name ?? entity.record.__type__ ?? ''), status, fileId: entity.fileId, scope: entity.scope,
        sourceId: old?.record._id ?? null, instanceId: current?.record._id ?? null, sourceAsset: old?.asset ?? null, instanceAsset: current?.asset ?? null, changes, children: [], components: [] });
    }
    const tree: JsonObject[] = [];
    for (const [key, entry] of entries) {
      const entity = right.entities.get(key) ?? left.entities.get(key)!;
      const parent = entity.parent ? entries.get(entity.parent) : undefined;
      if (parent) (parent[entity.kind === 'node' ? 'children' : 'components'] as JsonObject[]).push(entry); else tree.push(entry);
    }
    return { rows, tree, issues, assetReferences: [...left.assetReferences, ...right.assetReferences], comparisonComplete: complete, automaticRepairAllowed: false,
      excludedFields: ['_id', '_objFlags', '_editorExtras', '__editorExtras__', '_prefab', '__prefab'],
      limitations: ['fileId 和嵌套实例 fileId 为关联依据，名称和运行时 UUID 不用于匹配', 'Prefab 元数据用来定位身份，不比较私有覆盖账本和编辑器缓存字段', '自定义字段仅比较原生已序列化值，不另行调用项目 getter 或回调', '资源 UUID 统一标准与 22 字符压缩表示；AssetDB 引用身份查询不证明导入缓存或运行时加载可用', '快照缺失或外部引用导致 incomplete，不能据此自动新增、删除、apply 或 restore'] };
  }
}
