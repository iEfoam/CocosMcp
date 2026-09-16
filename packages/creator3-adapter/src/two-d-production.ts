import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { GameplayTemplates } from '../../gameplay2d-core/src/templates.js';
import { TwoDPlanning } from '../../gameplay2d-core/src/planning.js';
import { TwoDClipModel } from '../../animation-core/src/two-d.js';
import type { EditorPort } from './port.js';

type Run = (id: string, params: JsonObject) => Promise<JsonValue>;
export class TwoDProduction {
  constructor(private readonly port: EditorPort, private readonly run: Run) {}
  private hash(value: JsonValue): string { return createHash('sha256').update(Json.canonical(value)).digest('hex'); }
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    if (this.port.version !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', '2D production requires Creator 3.8.8');
    if (id === 'gameplay2d.templates') return { rows: Object.entries(new GameplayTemplates().rows).map(([template, spec]) => ({ template, title: spec.title, bindings: spec.bindings })) };
    if (id === 'navigation2d.find_path') return new TwoDPlanning().path(p);
    if (id.startsWith('ui.template.')) {
      const document = Json.value(new TwoDPlanning().ui(p)), params = { parentId: p.parentId!, document };
      const plan = Json.object(await this.run('ui.plan', params));
      if (id.endsWith('.plan')) return { ...plan, document, behaviorTemplate: 'ui', behaviorAttached: false };
      return { ...Json.object(await this.run('ui.build', { ...params, planHash: p.planHash! })), behaviorAttached: false, nextStep: '使用 gameplay2d.plan/apply 的 ui 模板挂载到返回 rootId；按钮发送 ui-action，不执行项目业务' };
    }
    if (id.startsWith('animation2d.')) {
      const document = Json.value(new TwoDClipModel().parse(p.document));
      const location = Json.object(await this.run('asset.location', { url: p.url! })), url = Json.string(location.url, 'asset location');
      if (!url.endsWith('.anim')) throw new CocosError('INVALID_ARGUMENT', 'Expected .anim URL');
      const snapshot = Json.value(await this.port.scene('fingerprint'));
      const content = Json.value(await this.port.scene('animation2d.serialize', { ...p, document }));
      if (Json.canonical(snapshot) !== Json.canonical(Json.value(await this.port.scene('fingerprint')))) throw new CocosError('STALE_REVISION', 'Scene changed during animation planning');
      const planHash = this.hash({ snapshot, content, url, document, rootId: p.rootId!, version: this.port.version });
      if (id.endsWith('.plan')) return { planHash, url, document, assetLocation: location, bindsAnimation: false };
      if (p.planHash !== planHash) throw new CocosError('STALE_REVISION', 'Animation plan changed');
      const created = Json.object(await this.run('asset.create', { url, content: JSON.stringify(content) }));
      try { return { ...created, clip: Json.value(await this.port.scene('animation.clip.inspect', { uuid: Json.object(created.asset).uuid! })), bindsAnimation: false }; }
      catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Animation created; inspect asset before retrying', { created, cause: CocosError.from(error).message }); }
    }
    if (id.startsWith('level2d.')) return this.level(id, p);
    if (!id.startsWith('gameplay2d.')) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Unknown production operation');
    const className = Json.string(p.className, 'className'), generated = new GameplayTemplates().source(Json.string(p.template, 'template'), className);
    const location = Json.object(await this.run('asset.location', { url: p.url! })), url = Json.string(location.url, 'location');
    if (!url.endsWith(`/${className}.ts`)) throw new CocosError('INVALID_ARGUMENT', 'Script filename must match className');
    if (location.targetExists) throw new CocosError('OPERATION_CONFLICT', 'Script asset already exists; inspect or attach it instead of regenerating');
    if (Json.object(await this.port.scene('gameplay2d.class_available', { className })).registered) throw new CocosError('OPERATION_CONFLICT', 'Generated class name is already registered');
    const snapshot = Json.value(await this.port.scene('fingerprint'));
    if (!await this.port.scene('nodeExists', p.nodeId)) throw new CocosError('NOT_FOUND', 'Script target node is absent');
    const planHash = this.hash({ source: generated.source, snapshot, nodeId: p.nodeId!, url, version: this.port.version });
    if (id.endsWith('.plan')) return { planHash, url, source: generated.source, bindings: generated.template.bindings, createsScript: true, attachesTo: p.nodeId!, existingLogicPreserved: true };
    if (p.planHash !== planHash) throw new CocosError('STALE_REVISION', 'Script plan changed');
    const created = Json.object(await this.run('asset.create', { url, content: generated.source }));
    try {
      let ready = false;
      // 只重试只读类注册查询；创建和挂载不重试，避免异步编译造成重复脚本或组件。
      for (let attempt = 0; attempt < 24; attempt++) {
        if (Json.object(await this.port.scene('gameplay2d.class_available', { className })).registered) { ready = true; break; }
        await delay(250);
      }
      if (!ready) throw new CocosError('CONTEXT_UNAVAILABLE', 'Creator has not registered the generated class within 6 seconds');
      if (Json.canonical(Json.value(await this.port.scene('fingerprint'))) !== Json.canonical(snapshot)) throw new CocosError('STALE_REVISION', 'Scene changed during script compilation');
      const attached = Json.object(await this.run('component.add', { nodeId: p.nodeId!, type: className }));
      return { ...created, attached, bindings: generated.template.bindings, configured: false, runtimeVerified: false, needsSave: true };
    } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Script exists but component attachment is incomplete; wait for Creator compilation and inspect before attaching, do not recreate', { created, nodeId: p.nodeId!, className, cause: CocosError.from(error).message }); }
  }
  private async level(id: string, p: JsonObject): Promise<JsonValue> {
    const rows = new TwoDPlanning().layout(p), snapshot = Json.value(await this.port.scene('fingerprint'));
    const asset = Json.object(await this.port.request('asset-db', 'query-asset-info', p.prefabUuid));
    if (!asset.uuid || !String(asset.url).endsWith('.prefab')) throw new CocosError('INVALID_ARGUMENT', 'Imported prefab required');
    if (!await this.port.scene('nodeExists', p.parentId)) throw new CocosError('NOT_FOUND', 'Level parent missing');
    const hierarchy = Json.object(await this.port.scene('hierarchy', { rootId: p.parentId!, limit: 1000 }));
    const names = new Set((hierarchy.rows as JsonObject[]).filter(row => row.parentId === p.parentId).map(row => row.name));
    if (rows.some(row => names.has(row.name))) throw new CocosError('OPERATION_CONFLICT', 'Generated node name already exists');
    const planHash = this.hash({ rows, snapshot, asset, parentId: p.parentId! });
    if (id.endsWith('.plan')) return { planHash, rows, prefab: asset, coordinateSpace: 'parent-local', collisionVerified: false };
    if (p.planHash !== planHash) throw new CocosError('STALE_REVISION', 'Level plan changed');
    const completed: JsonObject[] = []; let pending: JsonObject | null = null;
    try {
      for (const row of rows) {
        pending = row;
        const node = Json.object(await this.run('node.create', { parentId: p.parentId!, assetUuid: p.prefabUuid!, name: row.name! }));
        pending = { ...row, nodeId: node.nodeId! };
        await this.run('node.set', { nodeId: node.nodeId!, properties: { position: row.position! } });
        completed.push({ ...row, nodeId: node.nodeId! }); pending = null;
      }
      return { rows: completed, needsSave: true, collisionVerified: false };
    } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Partial level creation; preserve scene and inspect pending', { completed, pending, cause: CocosError.from(error).message }); }
  }
}
