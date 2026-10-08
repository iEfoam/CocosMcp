import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ProjectPaths } from '../../../packages/application/src/paths.js';
import { CocosError, Json, type JsonObject } from '../../../packages/contracts/src/index.js';
import { ImporterArtifacts } from '../../shared/importer-artifacts.js';

export class Creator3PreviewCompiler {
  constructor(private readonly project: string, private readonly version: string, private readonly ready: () => Promise<unknown>, private readonly info: (url: string) => Promise<unknown>) {}
  async compile(batch: JsonObject, cancelled: () => boolean): Promise<JsonObject> {
    if (this.version !== '3.8.8') return { status: 'unknown', errors: [], reason: 'Programming completion adapter requires native Creator 3.8.8' };
    const paths = await ProjectPaths.open(this.project), sources = batch.rows as JsonObject[], scripts = sources.filter(row => /\.(js|ts)$/i.test(String(row.url))), resources = sources.filter(row => !scripts.includes(row));
    const artifacts: JsonObject[] = [];
    if (scripts.length) {
      await this.ready();
      if (cancelled()) return { status: 'unknown', errors: [], reason: 'Cancelled after native programming completion' };
      const directory = 'temp/programming/packer-driver/targets/preview', mapPath = await paths.resolve(`${directory}/import-map.json`);
      if ((await stat(mapPath)).size > 32 * 1024 * 1024) throw new CocosError('RESOURCE_BUSY', 'Programming import map exceeds limit');
      const imports = Json.object(Json.object(JSON.parse(await readFile(mapPath, 'utf8'))).imports);
      for (const row of scripts) {
        const sourcePath = await paths.asset(String(row.url)), chunk = imports[pathToFileURL(sourcePath).href];
        if (typeof chunk !== 'string' || !/^\.\/chunks\/[a-f0-9]+\/[a-f0-9]+\.js$/.test(chunk)) return { status: 'unknown', errors: [], reason: 'Native import map does not expose this script chunk', url: row.url! };
        const chunkPath = await paths.resolve(`${directory}/${chunk}`), sourceMapPath = await paths.resolve(`${chunkPath}.map`);
        if ((await stat(sourceMapPath)).size > 32 * 1024 * 1024 || (await stat(chunkPath)).size > 16 * 1024 * 1024) throw new CocosError('RESOURCE_BUSY', 'Programming artifact exceeds verification limit');
        const content = Json.object(JSON.parse(await readFile(sourceMapPath, 'utf8'))).sourcesContent;
        // ready 只是原生完成信号，源映射仍须对应本次字节，不能把上一轮缓存当成本次编译。
        if (!Array.isArray(content) || !content.some(source => typeof source === 'string' && createHash('sha256').update(source).digest('hex') === row.sha256)) return { status: 'unknown', errors: [], reason: 'Programming source map does not match the requested revision', url: row.url! };
        artifacts.push({ url: `/scripting/x/${chunk.slice(2)}`, sha256: createHash('sha256').update(await readFile(chunkPath)).digest('hex'), kind: 'script' });
      }
    }
    let imported: JsonObject | undefined;
    if (resources.length) {
      imported = await new ImporterArtifacts(this.project, 3, this.info).compile({ ...batch, rows: resources }, cancelled);
      if (imported.status !== 'completed') return imported;
      artifacts.push(...imported.artifacts as JsonObject[]);
    }
    return { status: 'completed', sourceRevision: batch.sourceRevision!, errors: [], artifacts, rows: imported?.rows ?? [], signal: 'packer-driver-ready-and-native-importer', evidence: 'source-map-and-native-output-bytes' };
  }
}
