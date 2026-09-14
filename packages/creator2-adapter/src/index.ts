import { createHash } from 'crypto';
import { CocosError, Json, type EditorAdapter, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { Operations } from '../../capability-catalog/src/operations.js';

export interface Creator2Port {
  version: string;
  projectPath: string;
  scene(method: string, ...args: unknown[]): Promise<unknown>;
  asset(method: string, ...args: unknown[]): Promise<unknown>;
  selection(type: string, ids?: string[]): string[];
  ipc(panel: string, message: string, ...args: unknown[]): Promise<unknown>;
}

export class Creator2Adapter implements EditorAdapter {
  readonly major = 2 as const;
  constructor(private readonly port: Creator2Port) {}

  supportedCapabilities(): string[] {
    const excluded = new Set(['editor.message', 'editor.messages', 'view.query', 'view.set', 'view.focus', 'project.settings.get', 'project.settings.set', 'asset.users', 'asset.dependencies', 'preview.stop', 'ui.build']);
    return new Operations().list().filter(row => row.context === 'editor' && row.supportedMajors?.includes(2) && !excluded.has(row.id)).map(row => row.id);
  }

  async revision(): Promise<string> { return createHash('sha256').update(Json.canonical(Json.value(await this.port.scene('fingerprint')))).digest('hex'); }

  private async asset(method: string, ...args: unknown[]): Promise<JsonValue> { return Json.value(await this.port.asset(method, ...args)); }

  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    const str = (key: string): string => Json.string(p[key], key);
    switch (id) {
      case 'editor.status': return { editorVersion: this.port.version, creatorMajor: 2, projectPath: this.port.projectPath, scene: Json.value(await this.port.scene('sceneInfo')) };
      case 'scene.query': return { scene: Json.value(await this.port.scene('sceneInfo')) };
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
        return { saved: true, url };
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
      case 'asset.import': return { rows: await this.asset('import', [str('sourcePath')], str('targetUrl')) };
      case 'asset.move': return { rows: await this.asset('move', str('sourceUrl'), str('targetUrl')) };
      case 'asset.copy': return Json.value(await this.port.scene('copyAsset', p));
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
      case 'preview.start': await this.port.ipc('scene', 'scene:play-on-device'); return { requested: true, verification: 'unverified' };
      case 'scene.script': return Json.value(await this.port.scene('projectScript', p));
      default: throw new CocosError('UNSUPPORTED_CAPABILITY', `Creator ${this.port.version} does not expose ${id} through this adapter`);
    }
  }

  async dispose(): Promise<void> {}
}
