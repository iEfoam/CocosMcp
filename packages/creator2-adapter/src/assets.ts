import { readFile, readdir, lstat } from 'node:fs/promises';
import { AssetOrganization } from '../../asset-policy/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import type { Creator2Port } from './index.js';

export class Creator2Assets {
  readonly organization: AssetOrganization;
  constructor(private readonly port: Creator2Port) {
    this.organization = new AssetOrganization({ projectPath: port.projectPath, request: async (_channel, message, ...args) => {
      if (message === 'create-asset') return port.asset('create', args[0], args[1]);
      if (message === 'query-asset-info') return port.asset('assetInfo', args[0]);
      if (message === 'move-asset') return port.asset('move', args[0], args[1]);
      throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown organization message: ${message}`);
    } });
  }
  async copy(sourceUrl: string, targetUrl: string): Promise<JsonObject> {
    const paths = await ProjectPaths.open(this.port.projectPath), path = await paths.asset(sourceUrl);
    if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw new CocosError('INVALID_ARGUMENT', 'Copy a regular asset through AssetDB');
    // AssetDB 负责生成新 UUID 和子资源元数据；不复制 .meta，避免两个资源共享身份。
    const data = await readFile(path);
    const rows = Json.value(await this.port.asset('create', targetUrl, data));
    const source = Json.object(Json.value(await this.port.asset('assetInfo', sourceUrl)));
    const target = Json.object(Json.value(await this.port.asset('assetInfo', targetUrl)));
    if (!target.uuid || source.uuid === target.uuid) throw new CocosError('VERIFICATION_FAILED', 'Asset copy did not create a new identity');
    const sourceMeta = Json.object(Json.value(await this.port.asset('loadMeta', sourceUrl)));
    const targetMeta = Json.object(Json.value(await this.port.asset('loadMeta', targetUrl)));
    const merge = (source: JsonObject, target: JsonObject): JsonObject => {
      const result: JsonObject = { ...target };
      for (const [key,value] of Object.entries(source)) if (!['uuid', 'ver', 'importer', 'subMetas', 'rawTextureUuid', 'files', 'imported'].includes(key)) result[key] = value;
      const children = Json.object(target.subMetas ?? {}), sources = Object.values(Json.object(source.subMetas ?? {})).map(value => Json.object(value));
      result.subMetas = Object.fromEntries(Object.entries(children).map(([key, value]) => { const child = Json.object(value), candidates = sources.filter(row => row.importer === child.importer); if (candidates.length > 1) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Copy has ambiguous subasset import settings'); return [key, candidates.length ? merge(candidates[0]!, child) : child]; }));
      return result;
    };
    try { await this.port.asset('saveMeta', target.uuid, JSON.stringify(merge(sourceMeta,targetMeta))); await this.port.asset('refresh',targetUrl); }
    catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Copy created but import settings need inspection', { targetUrl, uuid: target.uuid, cause: CocosError.from(error).message }); }
    return { rows, asset: target, copiedImportSettings: true };
  }
  async references(url: string, reverse: boolean): Promise<JsonObject> {
    const paths = await ProjectPaths.open(this.port.projectPath); await paths.asset(url);
    const target = String(await this.port.asset('urlToUuid', url));
    if (!target) throw new CocosError('NOT_FOUND', 'Asset is not imported');
    const rows: JsonObject[] = [], skipped: JsonObject[] = []; let scanned = 0;
    const decode = (uuid: string): string => {
      if (!/^[a-f0-9]{2}[A-Za-z0-9+/]{20}$/.test(uuid)) return uuid;
      const hex = uuid.slice(0, 2) + Buffer.from(uuid.slice(2), 'base64').toString('hex');
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    };
    const visit = async (folder: string): Promise<void> => {
      for (const entry of await readdir(await paths.asset(folder), { withFileTypes: true })) {
        if (++scanned > 50000) throw new CocosError('INVALID_ARGUMENT', 'Reference scan exceeds 50000 entries');
        const sourceUrl = `${folder.replace(/\/$/, '')}/${entry.name}`;
        if (entry.isSymbolicLink()) { skipped.push({ url: sourceUrl, reason: 'symlink' }); continue; }
        if (entry.isDirectory()) { if (reverse) await visit(sourceUrl); continue; }
        if (entry.name.endsWith('.meta')) continue;
        if (!reverse && sourceUrl !== url) continue;
        if (!/\.(fire|prefab|anim|mtl|json)$/.test(entry.name)) { if (/\.(ts|js)$/.test(entry.name)) skipped.push({ url: sourceUrl, reason: 'dynamic-script-loads-not-resolved' }); continue; }
        const path = await paths.asset(sourceUrl);
        if ((await lstat(path)).size > 16 * 1024 * 1024) { skipped.push({ url: sourceUrl, reason: 'size-limit' }); continue; }
        let data: unknown;
        try { data = JSON.parse(await readFile(path, 'utf8')); } catch { skipped.push({ url: sourceUrl, reason: 'not-json' }); continue; }
        const refs = new Set<string>();
        const collect = (value: unknown): void => {
          if (!value || typeof value !== 'object') return;
          if (typeof (value as { __uuid__?: unknown }).__uuid__ === 'string') refs.add(decode((value as { __uuid__: string }).__uuid__));
          for (const child of Object.values(value)) collect(child);
        };
        collect(data);
        for (const uuid of refs) {
          if (uuid.length !== 36) skipped.push({ url: sourceUrl, reason: 'compressed-or-subasset-reference', uuid });
          if (!reverse || uuid === target) rows.push({ sourceUrl, uuid, url: Json.value(await this.port.asset('uuidToUrl', uuid)) });
        }
      }
    };
    await visit(reverse ? 'db://assets/' : url.slice(0, url.lastIndexOf('/')));
    return { rows, skipped, scanned, complete: false, scope: 'serialized-project-source', limitations: ['动态字符串加载、二进制资源及非标准引用未穷尽；不得据此自动删除资源'] };
  }
}
