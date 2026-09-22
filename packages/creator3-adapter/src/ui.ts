import { createHash } from 'node:crypto';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { UiDocumentModel } from '../../ui-core/src/index.js';
import { UiProperties } from './ui-properties.js';
import { UiUpdateService } from './ui-update.js';
import type { EditorPort } from './port.js';

type Run = (id: string, params: JsonObject) => Promise<JsonValue>;
export class UiService {
  constructor(private readonly port: EditorPort, private readonly run: Run) {}
  private hash(value: unknown): string { return createHash('sha256').update(Json.canonical(Json.value(value))).digest('hex'); }
  private async snapshot(rootId: string): Promise<JsonValue> { return Json.value(await this.port.scene('ui.snapshot', { rootId })); }
  async plan(p: JsonObject): Promise<JsonObject> {
    const rows = new UiDocumentModel().parse(p.document);
    const parentId = Json.string(p.parentId, 'parentId');
    const environment = Json.value(await this.port.scene('ui.preflight', { parentId, document: p.document! }));
    const assets: JsonObject[] = [];
    for (const row of rows) for (const component of row.node.components ?? []) for (const [property, value] of Object.entries(component.properties ?? {})) {
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.assetUuid === 'string') {
        const info = Json.object(await this.port.request('asset-db', 'query-asset-info', value.assetUuid));
        if (!info.uuid) throw new CocosError('NOT_FOUND', `UI asset not found: ${value.assetUuid}`);
        assets.push({ key: row.key, type: component.type, property, asset: info });
      }
    }
    const revision = this.hash(await this.port.scene('fingerprint'));
    const planHash = this.hash({ document: p.document, parentId, revision, assets, environment, version: this.port.version });
    return { planHash, revision, parentId, rows: rows.map(row => ({ key: row.key, parentKey: row.parentKey, name: row.node.name, components: ['cc.UITransform', ...(row.node.components ?? []).filter(c => c.type !== 'cc.UITransform').map(c => c.type)] })), assets,
      limitations: ['只创建新树，不修改或替换已有同名节点', '不自动创建 Camera；Canvas 需要工程已有可见 UI_2D 的相机', '交互检查为静态诊断，不能替代真实点击和保存重开验收'] };
  }
  async build(p: JsonObject): Promise<JsonValue> {
    const plan = await this.plan(p);
    if (p.planHash !== plan.planHash) throw new CocosError('STALE_REVISION', 'UI plan changed; run ui.plan again');
    const rows = new UiDocumentModel().parse(p.document), mapping = new Map<string, string>(), completed: JsonObject[] = [];
    let rootId: string | undefined, checkpoint: string | undefined, pending: JsonObject | null = null;
    const step = async (id: string, params: JsonObject): Promise<JsonObject> => {
      // 每步以本次子树为界检查外部修改；失去确定性时只报告 pending，不做全局 undo。
      if (rootId && checkpoint !== this.hash(await this.snapshot(rootId))) throw new CocosError('STALE_REVISION', 'UI subtree changed during build');
      pending = { capabilityId: id, params };
      const result = Json.object(await this.run(id, params));
      if (id === 'component.add') for (const componentId of result.componentIds as string[] ?? []) await this.port.scene('ui.flush_label', { componentId });
      if (id === 'component.set') await this.port.scene('ui.flush_label', { componentId: params.componentId! });
      if (id === 'node.create' && !rootId) rootId = Json.string(result.nodeId, 'rootId');
      completed.push({ capabilityId: id, result }); pending = null;
      if (rootId) checkpoint = this.hash(await this.snapshot(rootId));
      return result;
    };
    try {
      for (const row of rows) {
        const result = await step('node.create', { name: row.node.name, parentId: row.parentKey ? mapping.get(row.parentKey)! : p.parentId! });
        const nodeId = Json.string(result.nodeId, 'nodeId'); mapping.set(row.key, nodeId);
        // Creator 的节点默认层不能保证被 UI 相机看到，显式使用原生 UI_2D 层。
        await step('node.set', { nodeId, properties: { layer: 1 << 25, ...(row.node.position ? { position: row.node.position } : {}) } });
        const wanted = [{ type: 'cc.UITransform', properties: {} }, ...(row.node.components ?? [])];
        for (const component of wanted) {
          const tree = Json.object(await this.port.scene('hierarchy', { rootId: nodeId, limit: 1 }));
          const existing = (Json.object((tree.rows as JsonValue[])[0]).components as JsonObject[]).find(c => c.type === component.type);
          if (!existing) await step('component.add', { nodeId, type: component.type });
        }
      }
      for (const row of rows) {
        const nodeId = mapping.get(row.key)!;
        // Label 的初始排版可能先改尺寸；先配置渲染组件，再应用文档显式声明的 UITransform。
        for (const component of [...(row.node.components ?? [])].sort((a, b) => Number(a.type === 'cc.UITransform') - Number(b.type === 'cc.UITransform'))) {
          const tree = Json.object(await this.port.scene('hierarchy', { rootId: nodeId, limit: 1 }));
          const actual = (Json.object((tree.rows as JsonValue[])[0]).components as JsonObject[]).find(c => c.type === component.type);
          if (!actual) throw new CocosError('VERIFICATION_FAILED', `Missing UI component: ${component.type}`);
          const properties = await new UiProperties(this.port).resolve(component.properties ?? {}, mapping);
          if (Object.keys(properties).length) await step('component.set', { componentId: actual.componentId!, properties });
        }
      }
      return { rootId: rootId!, rows: rows.map(row => ({ key: row.key, nodeId: mapping.get(row.key)! })), completed, needsSave: true,
        snapshotHash: checkpoint!, diagnostics: Json.value(await this.port.scene('ui.inspect_layout', { rootId: rootId! })) };
    } catch (error) {
      let rollback: JsonObject = { status: 'not-attempted' };
      if (rootId && checkpoint) {
        try {
          if (this.hash(await this.snapshot(rootId)) !== checkpoint) rollback = { status: 'blocked', reason: '子树与最后已确认状态不一致，请检查 pending 和当前节点；未删除任何对象' };
          else { await this.run('node.delete', { nodeId: rootId }); rollback = { status: 'removed-owned-tree', nodeId: rootId }; }
        } catch (rollbackError) { rollback = { status: 'unknown', reason: CocosError.from(rollbackError).message }; }
      }
      throw new CocosError('OUTCOME_UNKNOWN', 'UI build failed; inspect completed, pending and rollback before retrying', { cause: CocosError.from(error).message, rootId: rootId ?? null, completed, pending, rollback });
    }
  }
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    if (this.port.version !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'UI tools require Creator 3.8.8');
    if (id === 'ui.diff') return new UiUpdateService(this.port, this.run).diff(p);
    if (id === 'ui.apply') return new UiUpdateService(this.port, this.run).apply(p);
    if (id === 'ui.plan') return this.plan(p);
    if (id === 'ui.build') return this.build(p);
    if (id === 'ui.inspect_layout' || id === 'ui.validate_interaction') return Json.value(await this.port.scene(id, p));
    throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown UI capability: ${id}`);
  }
}
