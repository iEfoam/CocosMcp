import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { ProjectPaths } from '../../../packages/application/src/paths.js';
import { CocosError, Json, type JsonObject } from '../../../packages/contracts/src/index.js';
import { PreviewRedaction } from '../../shared/preview-redaction.js';

export interface Creator2ProjectCompiler {
  compileScripts(paths: string[]): Promise<void>;
  raw2import(path: string): string;
  raw2dest(path: string): string;
  isPlugin(uuid: string): boolean;
  errorScripts: Record<string, unknown>;
}

/** 仅适配已探测的 2.4.15 Promise 完成接口；源映射用于拒绝旧导入产物。 */
export class Creator2PreviewCompiler {
  constructor(private readonly projectPath: string, private readonly version: string, private readonly compiler: () => Creator2ProjectCompiler | undefined, private readonly uuid: (url: string) => string, private readonly assetUrl: (uuid: string) => string) {}
  private errors(native: Creator2ProjectCompiler): JsonObject[] {
    const redact = new PreviewRedaction();
    return Object.entries(native.errorScripts ?? {}).flatMap(([uuid, errors]) => (Array.isArray(errors) ? errors : [errors]).map(error => {
      const message = redact.text(error), location = message.match(/\((\d+):(\d+)\)/);
      return { uuid, url: this.assetUrl(uuid) || null, message, line: location ? Number(location[1]) : null, column: location ? Number(location[2]) : null };
    }));
  }
  async compile(batch: JsonObject, cancelled: () => boolean): Promise<JsonObject> {
    const native = this.compiler();
    const unknown = (reason: string): JsonObject => ({ status: 'unknown', errors: [], reason });
    if (this.version !== '2.4.15' || !native || typeof native.compileScripts !== 'function' || typeof native.raw2import !== 'function' || typeof native.raw2dest !== 'function' || typeof native.isPlugin !== 'function') return unknown('Creator 2.4.15 native compiler APIs unavailable');
    // 原生 compileScripts 会先清除 errorScripts，必须先保留本次导入的语法错误，避免复制旧 JS 后误报成功。
    const importErrors = this.errors(native);
    if (importErrors.length) return { status: 'failed', errors: importErrors, signal: 'ProjectCompiler.errorScripts' };
    const rows = (batch.rows as JsonObject[]), paths = await ProjectPaths.open(this.projectPath), scripts: string[] = [];
    if (rows.some(row => !/\.(?:js|ts)$/i.test(String(row.url)))) return unknown('This adapter verifies ordinary JS/TS scripts only; other importer output manifests are not yet mapped');
    for (const row of rows) {
      const url = Json.string(row.url, 'url');
      if (native.isPlugin(this.uuid(url))) return unknown('Plugin script compilation is not adapted');
      scripts.push(await paths.asset(url));
    }
    if (cancelled()) return unknown('Cancelled before native compilation');
    try { await native.compileScripts(scripts); }
    catch (error) { return { status: 'failed', errors: [...this.errors(native), { message: new PreviewRedaction().text(CocosError.from(error).message) }], signal: 'ProjectCompiler.compileScripts rejected' }; }
    const errors = this.errors(native);
    if (errors.length) return { status: 'failed', errors, signal: 'ProjectCompiler.errorScripts' };
    if (cancelled()) return unknown('Cancelled after native compilation');
    for (let index = 0; index < scripts.length; index++) {
      const source = await readFile(scripts[index]!);
      if (createHash('sha256').update(source).digest('hex') !== rows[index]!.sha256) throw new CocosError('STALE_REVISION', 'Source changed during native compilation', { url: rows[index]!.url! });
      const mapPath = await paths.resolve(`${native.raw2import(scripts[index]!)}.map`);
      if ((await stat(mapPath)).size > 32 * 1024 * 1024) return unknown('Source map exceeds verification limit');
      const map = JSON.parse(await readFile(mapPath, 'utf8')) as { sourcesContent?: unknown[] };
      if (!Array.isArray(map.sourcesContent) || !map.sourcesContent.some(content => typeof content === 'string' && createHash('sha256').update(content).digest('hex') === rows[index]!.sha256)) return unknown('Imported source map does not match the requested source content');
      // 路径转换属于原生接口；符号链接和工程边界仍由统一策略检查。
      await paths.resolve(native.raw2dest(scripts[index]!));
    }
    const artifacts: JsonObject[] = [];
    for (const name of ['__qc_bundle__.js', '__quick_compile__.js']) {
      const path = await paths.resolve(`temp/quick-scripts/dst/${name}`);
      if ((await stat(path)).size > 64 * 1024 * 1024) return unknown('Compiled preview artifact exceeds verification limit');
      artifacts.push({ url: `/preview-scripts/${name}`, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    }
    return { status: 'completed', sourceRevision: batch.sourceRevision!, artifacts, errors: [], signal: 'ProjectCompiler.compileScripts Promise', evidence: 'native-completion-and-import-source-map' };
  }
}
