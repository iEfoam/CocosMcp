import { createHash } from 'node:crypto';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { UiDocumentModel } from '../../ui-core/src/index.js';
import { PropertyDump } from './dump.js';
import { UiProperties } from './ui-properties.js';
import type { EditorPort } from './port.js';

type Run = (id: string, p: JsonObject) => Promise<JsonValue>;
export class UiUpdateService {
  constructor(private readonly port: EditorPort, private readonly run: Run) {}
  private hash(value: unknown): string { return createHash('sha256').update(Json.canonical(Json.value(value))).digest('hex'); }
  private async snapshot(rootId: string): Promise<string> { return this.hash(await this.port.scene('ui.snapshot', { rootId })); }
  async diff(p: JsonObject): Promise<JsonObject> {
    const document = new UiDocumentModel().parse(p.document), rootId = Json.string(p.rootId, 'rootId');
    const rows = p.mapping;
    if (!Array.isArray(rows) || rows.length !== document.length) throw new CocosError('INVALID_ARGUMENT', 'Map every document key to exactly one existing node');
    const mapping = new Map<string, string>();
    for (const value of rows) { const row = Json.object(value); const key = Json.string(row.key, 'key'), id = Json.string(row.nodeId, 'nodeId');
      if (mapping.has(key) || [...mapping.values()].includes(id)) throw new CocosError('INVALID_ARGUMENT', 'Duplicate UI key or node mapping'); mapping.set(key, id); }
    if (mapping.get(document[0]!.key) !== rootId || document.some(row => !mapping.has(row.key))) throw new CocosError('INVALID_ARGUMENT', 'UI mapping does not match document root and keys');
    const startRevision = this.hash(await this.port.scene('fingerprint'));
    await this.port.scene('ui.preflight_update', p);
    const hierarchy = Json.object(await this.port.scene('hierarchy', { rootId, limit: 1000 }));
    if (Number(hierarchy.total) > 1000) throw new CocosError('INVALID_ARGUMENT', 'UI update subtree exceeds 1000 nodes');
    const actual = hierarchy.rows as JsonObject[], changes: JsonObject[] = [], blocked: JsonObject[] = [];
    const add = async (kind: 'node' | 'component', id: string, properties: JsonObject, key: string): Promise<void> => {
      const dump = Json.object(await this.port.request('scene', kind === 'node' ? 'query-node' : 'query-component', id));
      for (const [property, after] of Object.entries(properties)) {
        const field = PropertyDump.locate(dump, property); PropertyDump.assign(field, after);
        const before = PropertyDump.unwrap(field);
        if (!PropertyDump.matches(before, after)) changes.push({ key, kind, id, property, before, after });
      }
    };
    for (const row of document) {
      const id = mapping.get(row.key)!, node = actual.find(node => node.nodeId === id);
      if (!node) throw new CocosError('INVALID_ARGUMENT', `Mapped UI node is outside root: ${row.key}`);
      if (row.parentKey && node.parentId !== mapping.get(row.parentKey)) blocked.push({ key: row.key, reason: 'REPARENT_REQUIRED' });
      await add('node', id, { name: row.node.name, ...(row.node.position ? { position: row.node.position } : {}) }, row.key);
      for (const component of row.node.components ?? []) {
        const matches = (node.components as JsonObject[]).filter(c => c.type === component.type);
        if (matches.length !== 1) { blocked.push({ key: row.key, type: component.type, reason: 'COMPONENT_STRUCTURE_CHANGE_REQUIRED' }); continue; }
        const properties = await new UiProperties(this.port).resolve(component.properties ?? {}, mapping);
        await add('component', Json.string(matches[0]!.componentId, 'componentId'), properties, row.key);
      }
    }
    const snapshotHash = await this.snapshot(rootId), revision = this.hash(await this.port.scene('fingerprint'));
    if (revision !== startRevision) throw new CocosError('STALE_REVISION', 'Scene changed while calculating UI diff');
    return { rootId, rows: changes, blocked, applicable: blocked.length === 0, snapshotHash, revision,
      planHash: this.hash({ rootId, mapping: p.mapping, document: p.document, changes, blocked, snapshotHash, revision, version: this.port.version }),
      scope: 'existing-node-properties; undeclared fields, nodes and components preserved' };
  }
  async apply(p: JsonObject): Promise<JsonValue> {
    const plan = await this.diff(p);
    if (p.planHash !== plan.planHash) throw new CocosError('STALE_REVISION', 'UI diff changed; run ui.diff again');
    if (!plan.applicable) throw new CocosError('UNSUPPORTED_CAPABILITY', 'UI structural changes require a separate workflow', { blocked: plan.blocked! });
    const rootId = String(plan.rootId), completed: JsonObject[] = [], rollback: JsonObject[] = [];
    let checkpoint = String(plan.snapshotHash), pending: JsonObject | null = null;
    const update = async (change: JsonObject, restore: boolean): Promise<void> => {
      if (await this.snapshot(rootId) !== checkpoint) throw new CocosError('STALE_REVISION', 'UI subtree changed during update');
      await this.run(`${change.kind}.set`, { [change.kind === 'node' ? 'nodeId' : 'componentId']: change.id!, properties: { [String(change.property)]: restore ? change.before! : change.after! } });
      if (change.kind === 'component') await this.port.scene('ui.flush_label', { componentId: change.id! });
      checkpoint = await this.snapshot(rootId);
    };
    try {
      for (const change of plan.rows as JsonObject[]) { pending = change; await update(change, false); completed.push(change); pending = null; }
      return { rootId, rows: completed, changed: completed.length > 0, needsSave: completed.length > 0, snapshotHash: checkpoint, mapping: p.mapping! };
    } catch (error) {
      // 现有树只补偿已确认属性；结果不确定或外部改动时保留现场，不删除任何节点。
      try {
        if (await this.snapshot(rootId) !== checkpoint) rollback.push({ status: 'blocked', reason: 'SUBTREE_CHANGED' });
        else for (const change of [...completed].reverse()) { await update(change, true); rollback.push({ status: 'restored', id: change.id!, property: change.property! }); }
      } catch (failure) { rollback.push({ status: 'unknown', reason: CocosError.from(failure).message }); }
      throw new CocosError('OUTCOME_UNKNOWN', 'UI update failed; inspect completed, pending and rollback', { rootId, completed, pending, rollback, cause: CocosError.from(error).message });
    }
  }
}
