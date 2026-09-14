import { createHash } from 'crypto';
import { CocosError, Json, type EditorAdapter, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { Operations } from '../../capability-catalog/src/operations.js';
import { PropertyDump } from './dump.js';
import type { EditorPort } from './port.js';
import { ShaderService } from './shader.js';
import { AssetQuery } from './asset-query.js';
import { PreviewService } from './preview.js';
import { GeometryService } from './geometry.js';
import { RenderingService } from './rendering.js';

export class Creator3Adapter implements EditorAdapter {
  readonly major = 3 as const;
  private readonly shaders: ShaderService;
  constructor(private readonly port: EditorPort) { this.shaders = new ShaderService(port); }

  supportedCapabilities(): string[] {
    const excluded = new Set(['ui.build']);
    if (!this.port.preview || this.port.version !== '3.8.8') for (const id of ['preview.start', 'preview.stop', 'preview.status', 'preview.capture']) excluded.add(id);
    return new Operations().list().filter(row => row.context === 'editor' && row.supportedMajors?.includes(3) && !excluded.has(row.id)
      && (row.module !== 'F22' || row.id === 'shader.environment' || this.port.version === '3.8.8')).map(row => row.id);
  }

  async revision(): Promise<string> {
    const snapshot = Json.value(await this.port.scene('fingerprint'));
    return createHash('sha256').update(Json.canonical(snapshot)).digest('hex');
  }

  private async scene(message: string, ...args: unknown[]): Promise<JsonValue> {
    return Json.value(await this.port.request('scene', message, ...args));
  }

  private async asset(message: string, ...args: unknown[]): Promise<JsonValue> {
    return Json.value(await this.port.request('asset-db', message, ...args));
  }

  private async ensureSaved(): Promise<void> {
    if (await this.scene('query-dirty')) throw new CocosError('RESOURCE_BUSY', 'Save the current scene before switching or closing it');
  }

  private async setProperties(uuid: string, properties: JsonObject, component: boolean): Promise<JsonValue> {
    const query = component ? 'query-component' : 'query-node';
    const before = Json.object(await this.scene(query, uuid));
    const prepared = Object.entries(properties).map(([path, value]) => ({ path, value, dump: PropertyDump.assign(PropertyDump.locate(before, path), value) }));
    const location = component ? Json.object(await this.port.scene('componentLocation', uuid)) : null;
    const ownerId = location ? Json.string(location.nodeId, 'component owner') : uuid;
    const undoId = await this.scene('begin-recording', ownerId);
    try {
      for (const patch of prepared) {
        const result = await this.scene('set-property', { uuid: ownerId, path: location ? `__comps__.${Number(location.index)}.${patch.path}` : patch.path, dump: patch.dump });
        if (result === false) throw new CocosError('EDITOR_ERROR', `Editor rejected property: ${patch.path}`);
      }
      const after = Json.object(await this.scene(query, uuid));
      for (const patch of prepared) {
        if (!PropertyDump.matches(PropertyDump.unwrap(PropertyDump.locate(after, patch.path)), patch.value)) {
          throw new CocosError('VERIFICATION_FAILED', `Property did not match after writing: ${patch.path}`);
        }
      }
      await this.scene('end-recording', undoId);
      return { [component ? 'component' : 'node']: after };
    } catch (error) {
      // 只取消本次记录，不能用全局 undo 回退，避免撤销用户插入的编辑。
      try { await this.scene('cancel-recording', undoId); }
      catch (rollbackError) { throw new CocosError('OUTCOME_UNKNOWN', 'Property update failed and its recording could not be cancelled', { cause: CocosError.from(error).message, rollback: CocosError.from(rollbackError).message }); }
      throw error;
    }
  }

  private async createNode(params: JsonObject): Promise<JsonValue> {
    const info = Json.object(await this.port.scene('sceneInfo'));
    const parent = Json.string(params.parentId ?? info.sceneId, 'parentId');
    if (!await this.port.scene('nodeExists', parent)) throw new CocosError('NOT_FOUND', 'Parent is not in the active scene');
    const options: JsonObject = { name: params.name ?? 'Node', parent };
    if (params.assetUuid) options.assetUuid = params.assetUuid;
    const uuid = Json.string(await this.scene('create-node', options), 'created node UUID');
    if (!await this.port.scene('nodeExists', uuid)) throw new CocosError('VERIFICATION_FAILED', 'Created node was not attached to the active scene', { nodeId: uuid });
    // 预制体实例化可能忽略原生接口的 name 参数，显式设置并读回验证。
    await this.setProperties(uuid, { name: options.name! }, false);
    const node = await this.scene('query-node', uuid);
    const tree = Json.object(await this.port.scene('hierarchy', { rootId: uuid, limit: 1, includeComponents: false }));
    const root = Json.object((tree.rows as JsonValue[])[0]);
    if (root.parentId !== parent || root.name !== options.name) throw new CocosError('VERIFICATION_FAILED', 'Created node parent or name differs from request', { nodeId: uuid });
    return { node, nodeId: uuid };
  }

  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    if (id === 'geometry.create') return new GeometryService(this.port, (id, params) => this.execute(id, params)).create(p);
    if (id === 'geometry.array') return new GeometryService(this.port, (id, params) => this.execute(id, params)).array(p);
    if (id.startsWith('rendering.')) {
      if (this.port.version !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Rendering settings require Creator 3.8.8');
      const rendering = new RenderingService(this.port, (id, params) => this.execute(id, params));
      if (id === 'rendering.query') return rendering.query(p);
      if (id === 'rendering.configure') return rendering.configure(p);
      if (id === 'rendering.planar_reflection') return rendering.planarReflection(p);
    }
    if (id.startsWith('preview.')) return new PreviewService(this.port).execute(id, p);
    if (id.startsWith('shader.') || id.startsWith('material.')) return this.shaders.execute(id, p);
    const str = (key: string): string => Json.string(p[key], key);
    switch (id) {
      case 'editor.status': return { editorVersion: this.port.version, creatorMajor: 3, projectPath: this.port.projectPath, ready: await this.scene('query-is-ready') };
      case 'scene.query': return { scene: Json.value(await this.port.scene('sceneInfo')), dirty: await this.scene('query-dirty') };
      case 'scene.snapshot': return { snapshot: Json.value(await this.port.scene('fingerprint')) };
      case 'scene.diff': {
        const current = Json.value(await this.port.scene('fingerprint')); const baseline = Json.value(p.baseline);
        return { equal: Json.canonical(current) === Json.canonical(baseline), rows: Json.diff(baseline, current), current, baseline };
      }
      case 'scene.hierarchy': return Json.value(await this.port.scene('hierarchy', p));
      case 'scene.open': await this.ensureSaved(); await this.scene('open-scene', str('uuid')); return this.execute('scene.query', {});
      case 'scene.close': await this.ensureSaved(); return { closed: await this.scene('close-scene') };
      case 'scene.save': {
        const uuid = await this.scene('save-scene');
        if (!uuid) throw new CocosError('VERIFICATION_FAILED', 'Scene save was cancelled or did not return an asset UUID');
        if (await this.scene('query-dirty')) throw new CocosError('VERIFICATION_FAILED', 'Scene remains dirty after save');
        return { sceneUuid: uuid, saved: true };
      }
      case 'scene.save_copy': {
        const url = str('url');
        if (!url.endsWith('.scene')) throw new CocosError('INVALID_ARGUMENT', 'Scene copy URL must end in .scene');
        if (await this.asset('query-asset-info', url)) throw new CocosError('RESOURCE_BUSY', 'Scene copy target already exists');
        const data = await this.port.scene('serializeCurrentScene');
        const asset = Json.object(await this.asset('create-asset', url, JSON.stringify(data)));
        if (!asset.uuid) throw new CocosError('VERIFICATION_FAILED', 'Scene copy did not return an asset UUID');
        return { asset, currentSceneUnchanged: true, dirty: await this.scene('query-dirty') };
      }
      case 'scene.create': {
        await this.ensureSaved();
        const data = await this.port.scene('createSceneAsset', p);
        const asset = Json.object(await this.asset('create-asset', str('url'), JSON.stringify(data)));
        await this.scene('open-scene', Json.string(asset.uuid, 'scene UUID'));
        return { scene: asset };
      }
      case 'scene.undo': await this.scene('undo'); return this.execute('scene.query', {});
      case 'scene.redo': await this.scene('redo'); return this.execute('scene.query', {});
      case 'node.query': return { node: await this.scene('query-node', str('nodeId')) };
      case 'node.find': return Json.value(await this.port.scene('findNodes', p));
      case 'node.create': return this.createNode(p);
      case 'node.delete': {
        const uuid = str('nodeId'); await this.scene('remove-node', { uuid });
        const remaining = await this.port.scene('nodeExists', uuid);
        if (remaining) throw new CocosError('VERIFICATION_FAILED', 'Deleted node still exists');
        return { deletedNodeId: uuid };
      }
      case 'node.duplicate': return { nodeIds: await this.scene('duplicate-node', str('nodeId')) };
      case 'node.reparent': await this.scene('set-parent', { uuids: [str('nodeId')], parent: str('parentId'), keepWorldTransform: p.keepWorldTransform ?? true }); return this.execute('node.query', p);
      case 'node.set': return this.setProperties(str('nodeId'), Json.object(p.properties), false);
      case 'node.reset': await this.scene('reset-node', { uuid: str('nodeId') }); return this.execute('node.query', p);
      case 'component.types': return { rows: await this.scene('query-components') };
      case 'component.add': {
        const before = Json.value(await this.port.scene('componentIds', str('nodeId')));
        await this.scene('create-component', { uuid: str('nodeId'), component: str('type') });
        const after = await this.port.scene('componentIds', str('nodeId')) as string[];
        const added = after.filter(uuid => !Array.isArray(before) || !before.includes(uuid));
        if (!added.length) throw new CocosError('VERIFICATION_FAILED', 'No new component appeared');
        return { componentIds: added, node: await this.scene('query-node', str('nodeId')) };
      }
      case 'component.query': return { component: await this.scene('query-component', str('componentId')) };
      case 'component.delete': await this.scene('remove-component', { uuid: str('componentId') }); return { deletedComponentId: str('componentId') };
      case 'component.set': return this.setProperties(str('componentId'), Json.object(p.properties), true);
      case 'component.reset': await this.scene('reset-component', { uuid: str('componentId') }); return this.execute('component.query', p);
      case 'component.invoke': Json.safePath(str('method')); return this.scene('execute-component-method', { uuid: str('componentId'), name: str('method'), args: p.args ?? [] });
      case 'asset.query': {
        return new AssetQuery(this.port).execute(p);
      }
      case 'asset.info': return { asset: await this.asset('query-asset-info', str('url')) };
      case 'asset.meta': return { meta: await this.asset('query-asset-meta', str('url')) };
      case 'asset.dependencies': return { rows: await this.asset('query-asset-dependencies', str('url')) };
      case 'asset.users': return { rows: await this.asset('query-asset-users', str('url')) };
      case 'asset.create': return { asset: await this.asset('create-asset', str('url'), p.content) };
      case 'asset.save': return { asset: await this.asset('save-asset', str('url'), p.content) };
      case 'asset.import': return { asset: await this.asset('import-asset', str('sourcePath'), str('targetUrl')) };
      case 'asset.copy': return { asset: await this.asset('copy-asset', str('sourceUrl'), str('targetUrl')) };
      case 'asset.move': return { asset: await this.asset('move-asset', str('sourceUrl'), str('targetUrl')) };
      case 'asset.delete': await this.asset('delete-asset', str('url')); return { deletedUrl: str('url') };
      case 'asset.refresh': await this.asset('refresh-asset', str('url')); return this.execute('asset.info', p);
      case 'asset.reimport': await this.asset('reimport-asset', str('url')); return this.execute('asset.info', p);
      case 'asset.set_meta': {
        const meta = Json.object(await this.asset('query-asset-meta', str('url')));
        meta.userData = { ...(meta.userData && typeof meta.userData === 'object' && !Array.isArray(meta.userData) ? meta.userData : {}), ...Json.object(p.userData) };
        await this.asset('save-asset-meta', str('url'), JSON.stringify(meta));
        await this.asset('reimport-asset', str('url')); return this.execute('asset.meta', p);
      }
      case 'asset.resolve': return { uuid: await this.asset('query-uuid', str('reference')), url: await this.asset('query-url', str('reference')), path: await this.asset('query-path', str('reference')) };
      case 'prefab.instantiate': return this.createNode({ assetUuid: str('uuid'), ...(p.parentId ? { parentId: p.parentId } : {}), name: p.name ?? 'Prefab' });
      case 'prefab.create': {
        const before = Json.object(await this.port.scene('subtreeIdentity', str('nodeId')));
        if (!before.parentId) throw new CocosError('INVALID_ARGUMENT', 'The scene root cannot become a prefab');
        const assetUuid = await this.scene('create-prefab', str('nodeId'), str('url'));
        const rootId = Json.string(Json.value(await this.port.scene('childAt', before.parentId, before.index)), 'prefab root');
        const after = Json.object(await this.port.scene('subtreeIdentity', rootId));
        const oldRows = before.rows as JsonObject[]; const newRows = after.rows as JsonObject[];
        // 原生转换重建节点 UUID；只在结构和名字完整对应时返回映射，不能按同名节点猜测。
        if (!assetUuid || oldRows.length !== newRows.length || oldRows.some((row, index) => row.path !== newRows[index]!.path || row.name !== newRows[index]!.name)) {
          throw new CocosError('OUTCOME_UNKNOWN', 'Prefab conversion changed subtree structure; query the scene before continuing', { assetUuid, rootId });
        }
        return { assetUuid, rootId, rows: oldRows.map((row, index) => ({ path: row.path!, previousNodeId: row.nodeId!, nodeId: newRows[index]!.nodeId! })) };
      }
      case 'prefab.apply': return this.scene('apply-prefab', str('nodeId'));
      case 'prefab.revert': return this.scene('restore-prefab', str('nodeId'));
      case 'prefab.unlink': return this.scene('unlink-prefab', str('nodeId'));
      case 'view.query': return { is2D: await this.scene('query-is2D'), grid: await this.scene('query-is-grid-visible'), tool: await this.scene('query-gizmo-tool-name'), coordinate: await this.scene('query-gizmo-coordinate'), pivot: await this.scene('query-gizmo-pivot') };
      case 'view.set': {
        const messages: Record<string, string> = { is2D: 'change-is2D', grid: 'set-grid-visible', tool: 'change-gizmo-tool', coordinate: 'change-gizmo-coordinate', pivot: 'change-gizmo-pivot' };
        for (const [key, value] of Object.entries(p)) await this.scene(messages[key]!, value);
        return this.execute('view.query', {});
      }
      case 'view.focus': await this.scene('focus-camera', p.nodeIds); return { focusedNodeIds: p.nodeIds! };
      case 'selection.query': return { rows: this.port.selection(String(p.type ?? 'node')) };
      case 'selection.set': return { rows: this.port.selection(str('type'), p.ids as string[]) };
      case 'project.settings.get': return { settings: Json.value(await this.port.getSetting(str('name'), p.key as string | undefined)) };
      case 'project.settings.set': await this.port.setSetting(str('name'), str('key'), p.value!); return this.execute('project.settings.get', p);
      case 'editor.messages': return { rows: Json.value(this.port.messages(p.package as string | undefined).filter(row => !p.publicOnly || row.public)) };
      case 'editor.message': {
        if (str('editorVersion') !== this.port.version) throw new CocosError('UNSUPPORTED_VERSION', 'Message calls require the exact running editor version');
        const entry = this.port.messages(str('package')).find(row => row.message === str('message'));
        if (!entry) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Message was not discovered in the running editor');
        return Json.value(await this.port.request(entry.package, entry.message, ...(p.args as JsonValue[] ?? [])));
      }
      case 'scene.script': return this.scene('execute-scene-script', { name: str('extension'), method: str('method'), args: p.args ?? [] });
      case 'scene.validate': return Json.value(await this.port.scene('validateScene'));
      default: throw new CocosError('UNSUPPORTED_CAPABILITY', `No Creator 3 adapter for ${id}`);
    }
  }

  async dispose(): Promise<void> { this.port.disposePreview?.(); }
}

export type { EditorPort } from './port.js';
