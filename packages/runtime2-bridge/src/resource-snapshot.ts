import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';

export class Creator2ResourceSnapshot {
  // Features 每次调用重建；以 inspector 绑定预览实例，切场景仍保留同一运行实例身份。
  private static readonly sessions = new WeakMap<SceneInspector, { id: string; sequence: number; baselines: Map<string, string> }>();
  constructor(private readonly inspector: SceneInspector) {}
  private session() {
    let session = Creator2ResourceSnapshot.sessions.get(this.inspector);
    if (!session) {
      session = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, sequence: 0, baselines: new Map() };
      Creator2ResourceSnapshot.sessions.set(this.inspector, session);
    }
    return session;
  }
  snapshot(): JsonObject {
    const cc = this.inspector.environment.cc, manager = A.object(cc.assetManager), rows: JsonObject[] = [], bundles: JsonObject[] = [];
    let dependencies = 0;
    A.call(manager.assets, 'forEach', (raw: unknown, key: string) => {
      if (rows.length >= 10000) throw new CocosError('RESOURCE_BUSY', 'Resource snapshot exceeds 10000 cached assets');
      const asset = A.object(raw), uuid = A.uuid(asset) || String(key);
      const deps = A.call(manager.dependUtil, 'getDeps', uuid);
      if (!Array.isArray(deps) || !deps.every(value => typeof value === 'string')) throw new CocosError('VERIFICATION_FAILED', 'Unexpected native asset dependency data');
      dependencies += deps.length;
      if (dependencies > 100000) throw new CocosError('RESOURCE_BUSY', 'Resource dependency snapshot exceeds limit');
      rows.push({ key: String(key), uuid, type: this.inspector.type(asset), name: String(asset.name ?? ''), refCount: typeof asset.refCount === 'number' && Number.isFinite(asset.refCount) ? asset.refCount : null,
        valid: asset.isValid !== false, dependencies: [...new Set(deps)].sort() });
    });
    A.call(manager.bundles, 'forEach', (raw: unknown) => { const bundle = A.object(raw); if (bundles.length >= 1000) throw new CocosError('RESOURCE_BUSY', 'Bundle snapshot exceeds limit'); bundles.push({ name: String(bundle.name ?? ''), base: String(bundle.base ?? '') }); });
    rows.sort((a, b) => String(a.key).localeCompare(String(b.key))); bundles.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const session = this.session();
    const snapshot: JsonObject = { format: 'creator2-resource-snapshot-v1', runtimeId: session.id, snapshotId: `${session.id}:${++session.sequence}`, engineVersion: A.engineVersion(cc), sceneId: A.uuid(A.call(cc.director, 'getScene')), rows, bundles, complete: true,
      scope: 'assetManager-cache', retainedCount: rows.length, memoryBytes: null,
      limitations: ['引用计数不等于全部 JavaScript 引用；缓存驻留不等于泄漏', '直接依赖来自原生 dependUtil 缓存，不代表所有动态加载关系', '未测量 JS 堆或 GPU 显存'] };
    session.baselines.set(String(snapshot.snapshotId), Json.canonical(snapshot));
    // 仅短期保留完整基线以证明来源；总字符数同时受限，避免诊断本身长期持有大资源表。
    let characters = [...session.baselines.values()].reduce((total, value) => total + value.length, 0);
    while (session.baselines.size > 4 || characters > 4 * 1024 * 1024) {
      const key = session.baselines.keys().next().value!;
      characters -= session.baselines.get(key)!.length; session.baselines.delete(key);
    }
    return snapshot;
  }
  diff(p: JsonObject): JsonObject {
    const baseline = Json.object(p.baseline);
    if (baseline.format !== 'creator2-resource-snapshot-v1' || baseline.engineVersion !== '2.4.15' || baseline.complete !== true || !Array.isArray(baseline.rows) || baseline.rows.length > 10000) throw new CocosError('INVALID_ARGUMENT', 'Expected complete Creator 2.4.15 resource snapshot');
    const old = new Map<string, JsonObject>();
    let dependencies = 0;
    for (const raw of baseline.rows) {
      const row = Json.object(raw), key = Json.string(row.key, 'snapshot key');
      if (old.has(key) || typeof row.uuid !== 'string' || !Array.isArray(row.dependencies) || !row.dependencies.every(v => typeof v === 'string') || !(row.refCount === null || typeof row.refCount === 'number' && Number.isFinite(row.refCount))) throw new CocosError('INVALID_ARGUMENT', 'Invalid or duplicate resource baseline');
      dependencies += row.dependencies.length;
      if (dependencies > 100000 || typeof row.name !== 'string' || typeof row.type !== 'string' || typeof row.valid !== 'boolean') throw new CocosError('INVALID_ARGUMENT', 'Invalid or oversized resource baseline');
      // 基线是外部输入；仅比较快照定义字段，依赖顺序和重复项不构成资源变化。
      old.set(key, { key, uuid: row.uuid, type: row.type, name: row.name, refCount: row.refCount, valid: row.valid, dependencies: [...new Set(row.dependencies)].sort() });
    }
    const session = this.session();
    const sameRuntimeVerified = baseline.runtimeId === session.id && session.baselines.get(String(baseline.snapshotId)) === Json.canonical(baseline);
    const baselineVerification = sameRuntimeVerified ? 'retained-native-snapshot' : baseline.runtimeId !== session.id ? 'different-or-unknown-runtime' : 'modified-or-expired-baseline';
    const current = this.snapshot(), rows: JsonObject[] = [], currentRows = current.rows as JsonObject[];
    let unchanged = 0;
    for (const after of currentRows) {
      const before = old.get(String(after.key)); old.delete(String(after.key));
      if (!before) rows.push({ status: 'added', key: after.key!, after });
      else if (Json.canonical(before) !== Json.canonical(after)) rows.push({ status: 'changed', key: after.key!, before, after });
      else unchanged++;
    }
    for (const before of old.values()) rows.push({ status: 'removed', key: before.key!, before });
    return { rows, unchanged, beforeCount: baseline.rows.length, afterCount: currentRows.length, beforeSceneId: baseline.sceneId ?? null, afterSceneId: current.sceneId!, current,
      sameRuntimeVerified, baselineVerification, leakDetected: null, limitations: ['仅近期原样返回的本实例快照可验证来源；过期、修改或跨实例基线仅作数据比较', '切场景后的驻留需结合业务常驻资源、依赖和重复采样分析'] };
  }
  trend(p: JsonObject): JsonObject {
    const ids = p.snapshotIds;
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 4 || !ids.every(id => typeof id === 'string') || new Set(ids).size !== ids.length) throw new CocosError('INVALID_ARGUMENT', 'Provide 2..4 distinct retained snapshot IDs in capture order');
    const session = this.session(), order = [...session.baselines.keys()];
    let previous = -1;
    const snapshots = ids.map(id => {
      const index = order.indexOf(String(id)), serialized = session.baselines.get(String(id));
      if (!serialized) throw new CocosError('STALE_HANDLE', 'Resource snapshot expired or belongs to another runtime');
      if (index <= previous) throw new CocosError('INVALID_ARGUMENT', 'Resource snapshots must follow capture order');
      previous = index; return JSON.parse(serialized) as JsonObject;
    });
    const points = snapshots.map(snapshot => ({ snapshotId: snapshot.snapshotId!, sceneId: snapshot.sceneId!, retainedCount: snapshot.retainedCount!, bundleCount: (snapshot.bundles as JsonObject[]).length }));
    const tables = snapshots.map(snapshot => new Map((snapshot.rows as JsonObject[]).map(row => [String(row.key), row])));
    const keys = [...new Set(tables.flatMap(table => [...table.keys()]))].sort();
    const rows = keys.map(key => {
      const observations = tables.map(table => table.get(key));
      const first = observations[0], last = observations[observations.length - 1];
      const counts = observations.map(row => row?.refCount ?? null);
      return { key, uuid: observations.find(Boolean)!.uuid!, present: observations.map(Boolean), refCounts: counts,
        persistent: observations.every(Boolean), appeared: !first && Boolean(last), disappeared: Boolean(first) && !last,
        referenceGrowth: typeof first?.refCount === 'number' && typeof last?.refCount === 'number' ? last.refCount - first.refCount : null };
    });
    return { runtimeId: session.id, sameRuntimeVerified: true, points, rows, leakDetected: null,
      limitations: ['最多比较四份仍保留的原始快照；超大快照可能不进入来源缓存', '持续驻留或引用增长仅为观测事实；需结合业务常驻策略和重复完整生命周期判断'] };
  }
}
