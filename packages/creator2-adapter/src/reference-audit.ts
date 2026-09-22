import { readFile, stat } from 'node:fs/promises';
import { ProjectPaths } from '../../application/src/paths.js';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import type { Creator2Port } from './index.js';

/** 存在性以 AssetDB 索引为准，文件系统存在不能证明子资源已导入成功。 */
export class Creator2AssetReferenceAudit {
  constructor(private readonly port: Creator2Port) {}
  private expand(uuid: string): string {
    if (!/^[a-f0-9]{2}[A-Za-z0-9+/]{20}$/i.test(uuid)) return uuid;
    const hex = uuid.slice(0, 2) + Buffer.from(uuid.slice(2), 'base64').toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  async resolve(audit: JsonObject): Promise<JsonObject> {
    const cache = new Map<string, JsonObject>(), rows: JsonObject[] = [], issues = [...audit.issues as JsonObject[] ?? []];
    let complete = true;
    for (const value of audit.rows as JsonObject[]) {
      if (value.kind !== 'asset') { rows.push(value); continue; }
      const reference = String(value.targetId), uuid = this.expand(reference);
      let resolution = cache.get(uuid);
      if (!resolution) {
        try {
          const asset = await this.port.asset('assetInfoByUuid', uuid);
          if (asset && typeof asset === 'object') {
            const info = Json.object(Json.value(asset));
            if (typeof info.uuid !== 'string' || this.expand(info.uuid) !== uuid) throw new CocosError('VERIFICATION_FAILED', 'AssetDB returned inconsistent resource identity');
            resolution = { uuid, resolved: true, status: 'registered', asset: info };
          } else resolution = { uuid, resolved: false, status: 'missing' };
        } catch (error) {
          // 查询失败与资源缺失不同，不能把临时桥接错误转成可自动修复的断引。
          resolution = { uuid, resolved: null, status: 'query-failed', error: CocosError.from(error).message }; complete = false;
        }
        cache.set(uuid, resolution);
      }
      rows.push({ ...value, ...resolution });
      if (resolution.status !== 'registered') issues.push({ ...value, ...resolution, code: resolution.status === 'missing' ? 'ASSET_REFERENCE_MISSING' : 'ASSET_LOOKUP_FAILED' });
    }
    return { ...audit, rows, issues, complete: audit.complete !== false && complete, assetLookupComplete: complete, uniqueAssets: cache.size,
      limitations: ['AssetDB 注册不代表资源可成功加载或渲染', '不推断 null 的历史目标，不分析动态字符串加载及脚本闭包引用'] };
  }
  async source(url: string): Promise<JsonObject> {
    if (!/\.(fire|prefab|anim|mtl)$/i.test(url)) throw new CocosError('INVALID_ARGUMENT', 'Audit a Creator 2 serialized scene, prefab, animation or material');
    const paths = await ProjectPaths.open(this.port.projectPath), path = await paths.asset(url);
    if ((await stat(path)).size > 16 * 1024 * 1024) throw new CocosError('RESOURCE_BUSY', 'Serialized asset exceeds 16 MiB');
    const data = JSON.parse(await readFile(path, 'utf8')) as JsonValue, rows: JsonObject[] = [];
    let visited = 0;
    const visit = (value: JsonValue, path: string, depth: number): void => {
      if (++visited > 100000 || depth > 64) throw new CocosError('RESOURCE_BUSY', 'Serialized asset audit exceeds traversal limit');
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1)); return; }
      if (typeof value.__uuid__ === 'string') rows.push({ sourceUrl: url, path, kind: 'asset', targetId: value.__uuid__ });
      for (const [key, entry] of Object.entries(value)) visit(entry, `${path}.${key}`, depth + 1);
    };
    visit(data, '$', 0);
    return this.resolve({ rows, issues: [], scope: 'saved-serialized-source', unsavedSceneIncluded: false });
  }
}
