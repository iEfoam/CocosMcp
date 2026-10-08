import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { ProjectPaths } from '../../packages/application/src/paths.js';
import { CocosError, Json, type JsonObject } from '../../packages/contracts/src/index.js';

/** 只映射原生 AssetDB 返回的产物，不扫描 library 猜测导入器是否已经完成。 */
export class ImporterArtifacts {
  constructor(private readonly project: string, private readonly major: 2 | 3, private readonly info: (url: string) => Promise<unknown>) {}
  async compile(batch: JsonObject, cancelled: () => boolean): Promise<JsonObject> {
    const paths = await ProjectPaths.open(this.project), artifacts: JsonObject[] = [], rows: JsonObject[] = [];
    for (const source of batch.rows as JsonObject[]) {
      if (cancelled()) return { status: 'unknown', errors: [], reason: 'Cancelled after native import' };
      const asset = Json.object(await this.info(String(source.url))), library = Json.object(asset.library ?? {});
      const descendants = Object.values(Json.object(asset.subAssets ?? {})).filter(value => value && typeof value === 'object' && !Array.isArray(value)).map(value => Json.object(value));
      if (descendants.length > 100) throw new CocosError('RESOURCE_BUSY', 'Importer subresource manifest exceeds limit');
      const outputs = [asset, ...descendants].flatMap(row => Object.values(Json.object(row.library ?? {})).filter(value => typeof value === 'string') as string[]);
      if (!Object.keys(library).length || asset.imported === false || asset.invalid === true || !outputs.length) return { status: 'unknown', errors: [], rows, reason: 'Native importer did not expose a completed output manifest', url: source.url! };
      const imported: JsonObject[] = [];
      for (const output of [...new Set(outputs)].sort()) {
        if (cancelled()) return { status: 'unknown', errors: [], reason: 'Cancelled during native artifact inspection' };
        if (artifacts.length >= 512) throw new CocosError('RESOURCE_BUSY', 'Importer artifact manifest exceeds 512 outputs');
        const path = await paths.resolve(output), metadata = await stat(path);
        if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) throw new CocosError('RESOURCE_BUSY', 'Importer artifact is not a bounded regular file');
        const name = basename(path), uuid = name.slice(0, name.lastIndexOf('.'));
        if (!/^[a-f0-9-]{32,36}(?:@[a-zA-Z0-9_-]+)?$/.test(uuid)) return { status: 'unknown', errors: [], reason: 'Unsupported native importer output name' };
        const base = this.major === 3 ? '/assets/general' : '/assets/others';
        const scene = asset.importer === 'scene' || asset.type === 'scene';
        const url = scene && uuid === asset.uuid ? this.major === 3 ? `/scene/${name}` : '/preview-scene.json' : `${base}/${name.endsWith('.json') ? 'import' : 'native'}/${uuid.slice(0, 2)}/${name}`;
        // 2.x 的 Bundle 会改变公开 URL 前缀。产物身份取自原生 UUID 文件名，浏览器按相同身份核对实际请求与字节。
        const artifact = { url, kind: 'resource', nativeFile: name, uuid, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
        imported.push(artifact); artifacts.push(artifact);
      }
      rows.push({ url: source.url!, uuid: asset.uuid ?? null, importer: asset.importer ?? asset.type ?? null, sourceSha256: source.sha256!, artifacts: imported, dependencyCoverage: 'native-subresources', transitiveDependencies: 'unknown' });
    }
    return { status: 'completed', sourceRevision: batch.sourceRevision!, errors: [], artifacts: [...new Map(artifacts.map(row => [String(row.url), row])).values()], rows, signal: 'asset-db-import-callback-and-native-library-manifest', evidence: 'native-importer-output-bytes' };
  }
}
