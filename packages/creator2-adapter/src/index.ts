import { Creator2AssetReferenceAudit } from './reference-audit.js';
import { Creator2Shader } from './shader.js';
import { Creator2AnimationService } from './animation.js';
import { Creator2Texture } from './texture.js';
import { basename, dirname } from 'path';
import { PreviewService } from '../../creator3-adapter/src/preview.js';
import { Creator2UiService } from './ui.js';
import { createHash } from 'crypto';
import { CocosError, Json, type EditorAdapter, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { Operations } from '../../capability-catalog/src/operations.js';
import { Creator2Assets } from './assets.js';
import { Creator2Support } from './support.js';

export interface Creator2Port {
  setting?(method: string, params: JsonObject): Promise<JsonValue>;
  previewUrl?(): Promise<string>;
  environment?(): JsonObject;
  preview?(method: string, params: JsonObject): Promise<JsonValue>;
  disposePreview?(): void;
  version: string;
  projectPath: string;
  scene(method: string, ...args: unknown[]): Promise<unknown>;
  asset(method: string, ...args: unknown[]): Promise<unknown>;
  selection(type: string, ids?: string[]): string[];
  ipc(panel: string, message: string, ...args: unknown[]): Promise<unknown>;
  sceneScript?(extension: string, method: string, params: JsonObject): Promise<unknown>;
}

export class Creator2Adapter implements EditorAdapter {
  readonly major = 2 as const;
  private readonly assets: Creator2Assets;
  constructor(private readonly port: Creator2Port) { this.assets = new Creator2Assets(port); }

  supportedCapabilities(): string[] {
    const registered = new Set([...Creator2Support.base, ...(this.port.version === '2.4.15' ? Creator2Support.scene : []), ...(this.port.preview && this.port.previewUrl && this.port.version === '2.4.15' ? Creator2Support.preview : []), ...(this.port.setting ? ['project.settings.get', 'project.settings.set'] : []), ...(this.port.sceneScript ? ['scene.script'] : [])]);
    return new Operations().list().filter(row => registered.has(row.id)).map(row => row.id);
  }

  async revision(): Promise<string> { return createHash('sha256').update(Json.canonical(Json.value(await this.port.scene('fingerprint')))).digest('hex'); }

  private async asset(method: string, ...args: unknown[]): Promise<JsonValue> { return Json.value(await this.port.asset(method, ...args)); }

  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    // 规划与执行必须使用同一资源目录，否则根目录请求在创建时归类会使计划哈希失效。
    const prepared = await this.assets.organization.prepare(id === 'animation2d.plan' ? 'animation2d.create' : id, p);
    const result = await this.dispatch(id, prepared.params);
    return prepared.location ? { ...Json.object(result), assetLocation: prepared.location } : result;
  }

  private async dispatch(id: string, p: JsonObject): Promise<JsonValue> {
    if (id.startsWith('project.settings.')) { if (!this.port.setting) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Project profiles unavailable'); return this.port.setting(id.endsWith('.set') ? 'set' : 'get', p); }
    if (id.startsWith('animation')) return new Creator2AnimationService(this.port).execute(id, p);
    if (id === 'shader.preview.connect') { if (!this.port.preview) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Preview unavailable'); return this.port.preview('connect-runtime', p); }
    if (id === 'material.clone') return this.assets.copy(Json.string(p.sourceUrl, 'sourceUrl'), Json.string(p.targetUrl, 'targetUrl'));
    if (id.startsWith('shader.') || id.startsWith('material.')) return new Creator2Shader(this.port).execute(id, p);
    if (id.startsWith('texture.') || id.startsWith('spriteframe.')) return new Creator2Texture(this.port, url => this.assets.references(url, true)).execute(id, p);
    if (id.startsWith('preview.')) return new PreviewService({ version: this.port.version, scene: (...args) => this.port.scene(...args), ...(this.port.preview ? { preview: (method, params) => this.port.preview!(method, params) } : {}), request: async (channel, message) => {
      if (channel === 'scene' && message === 'query-dirty') return Json.object(Json.value(await this.port.scene('sceneInfo'))).dirty;
      if (channel === 'preview' && message === 'query-preview-url' && this.port.previewUrl) return this.port.previewUrl();
      throw new CocosError('UNSUPPORTED_CAPABILITY', `${channel}.${message}`);
    } }).execute(id, p);
    if (id.startsWith('ui.')) return new Creator2UiService(this.port).execute(id, p);
    const str = (key: string): string => Json.string(p[key], key);
    switch (id) {
      case 'editor.environment': return { ...Json.object(Json.value(await this.port.scene('environment'))), host: this.port.environment?.() ?? {} };
      case 'asset.location': return this.assets.organization.location(str('url'));
      case 'asset.organize.plan': return this.assets.organization.plan(p);
      case 'asset.organize.apply': return this.assets.organization.apply(p);
      case 'asset.dependencies': return this.assets.references(str('url'), false);
      case 'asset.users': return this.assets.references(str('url'), true);
      case 'scene.save_copy': { const saved = Json.object(await this.port.scene('serializeCurrentScene')); return { rows: await this.asset('create', str('url'), typeof saved.content === 'string' ? saved.content : JSON.stringify(saved.content)) }; }
      case 'view.query': case 'view.set': case 'view.focus': return Json.value(await this.port.scene(id, p));
      case 'editor.status': return { editorVersion: this.port.version, creatorMajor: 2, projectPath: this.port.projectPath, scene: Json.value(await this.port.scene('sceneInfo')) };
      case 'scene.references': return new Creator2AssetReferenceAudit(this.port).resolve(Json.object(Json.value(await this.port.scene('scene.references'))));
      case 'asset.references.audit': return new Creator2AssetReferenceAudit(this.port).source(str('url'));
      case 'scene.query': { const scene = Json.object(Json.value(await this.port.scene('sceneInfo'))); return { scene, dirty: scene.dirty ?? null }; }
      case 'scene.snapshot': return { snapshot: Json.value(await this.port.scene('fingerprint')) };
      case 'scene.diff': {
        const current = Json.value(await this.port.scene('fingerprint')); const baseline = Json.value(p.baseline);
        return { equal: Json.canonical(current) === Json.canonical(baseline), rows: Json.diff(baseline, current), current, baseline };
      }
      case 'scene.hierarchy': return Json.value(await this.port.scene('hierarchy', p));
      case 'node.find': return Json.value(await this.port.scene('findNodes', p));
      case 'scene.validate': return Json.value(await this.port.scene('validateScene'));
      case 'scene.open': return Json.value(await this.port.scene('openScene', p));
      case 'scene.create': {
        const data = await this.port.scene('createSceneAsset', p);
        const rows = await this.asset('create', str('url'), JSON.stringify(data)) as JsonObject[];
        const uuid = rows[0]?.uuid ?? await this.asset('urlToUuid', str('url'));
        await this.port.scene('openScene', { uuid }); return { scene: rows };
      }
      case 'scene.save': {
        const saved = Json.object(await this.port.scene('serializeCurrentScene'));
        const url = await this.asset('uuidToUrl', saved.uuid);
        if (typeof url !== 'string' || !url.startsWith('db://assets/')) throw new CocosError('RESOURCE_BUSY', 'Save the new scene in Creator before saving through MCP');
        await this.asset('saveExists', url, typeof saved.content === 'string' ? saved.content : JSON.stringify(saved.content));
        const scene = Json.object(Json.value(await this.port.scene('markSaved')));
        return { saved: true, url, dirty: scene.dirty ?? null };
      }
      case 'scene.close': return Json.value(await this.port.scene('closeScene'));
      case 'scene.undo': return Json.value(await this.port.scene('undo'));
      case 'scene.redo': return Json.value(await this.port.scene('redo'));
      case 'node.query': case 'node.create': case 'node.delete': case 'node.duplicate': case 'node.reparent': case 'node.set': case 'node.reset':
      case 'component.types': case 'component.add': case 'component.query': case 'component.delete': case 'component.set': case 'component.reset': case 'component.invoke':
      case 'prefab.instantiate': case 'prefab.apply': case 'prefab.revert': case 'prefab.unlink':
        return Json.value(await this.port.scene('mutate', { capabilityId: id, params: p }));
      case 'prefab.create': {
        const data = await this.port.scene('serializePrefab', p);
        return { prefab: await this.asset('create', str('url'), typeof data === 'string' ? data : JSON.stringify(data)) };
      }
      case 'asset.query': {
        const rows = await this.asset('queryAssets', p.pattern ?? 'db://assets/**/*', p.type ?? null) as JsonValue[];
        const offset = Number(p.offset ?? 0); const limit = Number(p.limit ?? 100);
        return { rows: rows.slice(offset, offset + limit), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null };
      }
      case 'asset.info': return { asset: await this.asset('assetInfo', str('url')) };
      case 'asset.meta': return { meta: await this.asset('loadMeta', str('url')) };
      case 'asset.create': return { rows: await this.asset('create', str('url'), p.content) };
      case 'asset.save': return { asset: await this.asset('saveExists', str('url'), p.content) };
      case 'asset.import': {
        if (basename(str('sourcePath')) !== basename(str('targetUrl'))) throw new CocosError('INVALID_ARGUMENT', 'Creator 2 import preserves the source filename; use a matching target basename');
        const rows = await this.asset('import', [str('sourcePath')], dirname(str('targetUrl')));
        const imported = await this.asset('assetInfo', str('targetUrl'));
        if (!imported) throw new CocosError('VERIFICATION_FAILED', 'Import did not create expected URL');
        return { rows, asset: imported };
      }
      case 'asset.move': return { rows: await this.asset('move', str('sourceUrl'), str('targetUrl')) };
      case 'asset.copy': return this.assets.copy(str('sourceUrl'), str('targetUrl'));
      case 'asset.delete': return { rows: await this.asset('delete', [str('url')]) };
      case 'asset.refresh': case 'asset.reimport': await this.asset('refresh', str('url')); return this.execute('asset.info', p);
      case 'asset.set_meta': {
        const uuid = await this.asset('urlToUuid', str('url'));
        const meta = Json.object(await this.asset('loadMeta', str('url')));
        // 2.x 的导入设置在 meta 根层；保留 uuid/ver/importer 等标识，禁止覆盖。
        const changes = Json.object(p.userData);
        for (const key of Object.keys(changes)) if (['uuid', 'ver', 'importer', 'subMetas'].includes(key)) throw new CocosError('INVALID_ARGUMENT', `Reserved metadata field: ${key}`);
        await this.asset('saveMeta', uuid, JSON.stringify({ ...meta, ...changes }));
        await this.asset('refresh', str('url')); return this.execute('asset.meta', p);
      }
      case 'asset.resolve': {
        const reference = str('reference');
        const uuid = reference.startsWith('db://') ? await this.asset('urlToUuid', reference) : reference;
        return { uuid, url: await this.asset('uuidToUrl', uuid), path: await this.asset('uuidToFspath', uuid) };
      }
      case 'selection.query': return { rows: this.port.selection(String(p.type ?? 'node')) };
      case 'selection.set': return { rows: this.port.selection(str('type'), p.ids as string[]) };
      case 'scene.script': {
        if (!this.port.sceneScript) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Scene script host unavailable');
        return Json.value(await this.port.sceneScript(str('extension'), str('method'), { args: p.args ?? [] }));
      }
      default: throw new CocosError('UNSUPPORTED_CAPABILITY', `Creator ${this.port.version} does not expose ${id} through this adapter`);
    }
  }

  async dispose(): Promise<void> { this.port.disposePreview?.(); }
}
