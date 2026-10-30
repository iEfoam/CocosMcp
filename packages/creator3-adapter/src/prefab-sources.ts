import { createHash } from 'node:crypto';
import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import { FileSnapshots, type FileSnapshot } from '../../native-adapters/src/file-snapshot.js';
import type { EditorPort } from './port.js';
import { AssetUuid } from '../../asset-policy/src/uuid.js';

interface Source { uuid: string; url: string; path: string; snapshot: FileSnapshot }

/** 根与嵌套源共同构成比较证据；只读，绝不以缓存中的 Prefab 数据代替当前文件身份。 */
export class PrefabSources {
  private readonly sources = new Map<string, Source>();
  private readonly reader = new FileSnapshots();
  private bytes = 0;
  private started = false;
  private readonly uuids = new AssetUuid();
  constructor(private readonly port: EditorPort) {}
  async capture(uuid: string): Promise<{ url: string; text: string; sha256: string; dependencies: JsonObject[]; graphHash: string }> {
    if (this.started) throw new CocosError('OPERATION_CONFLICT', 'Prefab source capture is single-use; create a fresh inspection');
    this.started = true;
    uuid = this.uuids.normalize(uuid);
    const paths = await ProjectPaths.open(this.port.projectPath);
    const read = async (id: string, ancestors: Set<string>): Promise<void> => {
      id = this.uuids.normalize(id);
      if (ancestors.has(id)) throw new CocosError('VERIFICATION_FAILED', 'Cyclic nested Prefab dependency', { assetUuid: id });
      if (this.sources.has(id)) return;
      if (ancestors.size >= 16 || this.sources.size >= 100) throw new CocosError('RESOURCE_BUSY', 'Prefab dependency graph budget exceeded');
      const info = Json.object(Json.value(await this.port.request('asset-db', 'query-asset-info', id)));
      const url = Json.string(info.url, 'Prefab URL');
      if (typeof info.uuid !== 'string' || this.uuids.normalize(info.uuid) !== id || info.type !== 'cc.Prefab' || !url.endsWith('.prefab')) throw new CocosError('VERIFICATION_FAILED', 'Prefab source identity does not match AssetDB', { assetUuid: id });
      const path = await paths.asset(url), snapshot = await this.reader.read(path, Math.min(16 * 1024 * 1024, 64 * 1024 * 1024 - this.bytes), true);
      this.bytes += snapshot.bytes;
      let table: unknown;
      try { table = JSON.parse(snapshot.text!); } catch { throw new CocosError('VERIFICATION_FAILED', 'Invalid Prefab source JSON', { url }); }
      if (!Array.isArray(table) || table.length > 100000) throw new CocosError('VERIFICATION_FAILED', 'Invalid Prefab source table', { url });
      this.sources.set(id, { uuid: id, url, path, snapshot });
      const next = new Set([...ancestors, id]);
      for (const value of table) {
        if (!value || typeof value !== 'object' || value.__type__ !== 'cc.PrefabInfo') continue;
        const dependency = typeof value.asset?.__uuid__ === 'string' ? this.uuids.normalize(value.asset.__uuid__) : undefined;
        if (typeof dependency !== 'string' || dependency === id && !value.instance) continue;
        await read(dependency, next);
      }
    };
    await read(uuid, new Set());
    const source = this.sources.get(uuid)!;
    const dependencies = [...this.sources.values()].map(row => ({ assetUuid: row.uuid, url: row.url, sha256: row.snapshot.sha256, bytes: row.snapshot.bytes })).sort((a, b) => a.assetUuid.localeCompare(b.assetUuid));
    return { url: source.url, text: source.snapshot.text!, sha256: source.snapshot.sha256, dependencies,
      graphHash: createHash('sha256').update(Json.canonical(dependencies)).digest('hex') };
  }
  async verify(): Promise<void> {
    const paths = await ProjectPaths.open(this.port.projectPath);
    for (const source of this.sources.values()) {
      const info = Json.object(Json.value(await this.port.request('asset-db', 'query-asset-info', source.uuid)));
      if (typeof info.uuid !== 'string' || this.uuids.normalize(info.uuid) !== source.uuid || info.url !== source.url || info.type !== 'cc.Prefab' || await paths.asset(source.url) !== source.path) {
        throw new CocosError('STALE_REVISION', 'Prefab dependency identity changed during inspection', { assetUuid: source.uuid });
      }
      await this.reader.verify(source.path, source.snapshot.identity);
    }
  }
}
