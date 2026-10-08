import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { ProjectPaths } from '../../../packages/application/src/paths.js';
import { CocosError, Json, type JsonObject } from '../../../packages/contracts/src/index.js';
import { PreviewRedaction } from '../../shared/preview-redaction.js';
import { ImporterArtifacts } from '../../shared/importer-artifacts.js';

export interface Creator2ProjectCompiler {
  compileScripts(paths: string[]): Promise<void>;
  raw2import(path: string): string;
  raw2dest(path: string): string;
  isPlugin(uuid: string): boolean;
  errorScripts: Record<string, unknown>;
}

/** 仅适配已探测的 2.4.15 Promise 完成接口；源映射用于拒绝旧导入产物。 */
export class Creator2PreviewCompiler {
  constructor(private readonly projectPath: string, private readonly version: string, private readonly compiler: () => Creator2ProjectCompiler | undefined, private readonly uuid: (url: string) => string, private readonly assetUrl: (uuid: string) => string, private readonly info?: (url: string) => Promise<unknown>) {}
  private errors(native: Creator2ProjectCompiler): JsonObject[] {
    const redact = new PreviewRedaction();
    return Object.entries(native.errorScripts ?? {}).flatMap(([uuid, errors]) => (Array.isArray(errors) ? errors : [errors]).map(error => {
      const message = redact.text(error), location = message.match(/\((\d+):(\d+)\)/);
      return { uuid, url: this.assetUrl(uuid) || null, message, line: location ? Number(location[1]) : null, column: location ? Number(location[2]) : null };
    }));
  }
  private async modulesReady(native: Creator2ProjectCompiler, paths: ProjectPaths, scripts: string[], rows: JsonObject[], cancelled: () => boolean): Promise<boolean> {
    let previous = '', stableSince = 0;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !cancelled()) {
      let ready = true; const hashes: string[] = [];
      for (let index = 0; index < scripts.length; index++) {
        const path = await paths.resolve(native.raw2dest(scripts[index]!)), info = await stat(path);
        if (!info.isFile() || info.size > 16 * 1024 * 1024) return false;
        const bytes = await readFile(path), url = /\/\/# sourceMappingURL=data:application\/json(?:;charset=[^;,]+)?;base64,([^\r\n]+)/.exec(bytes.toString())?.[1];
        let map: { sourcesContent?: unknown[] } = {};
        try { if (url) map = JSON.parse(Buffer.from(url, 'base64').toString()); } catch { /* 原生写入尚未结束时继续等待完整映射。 */ }
        ready &&= Array.isArray(map.sourcesContent) && map.sourcesContent.some(source => typeof source === 'string' && createHash('sha256').update(source).digest('hex') === rows[index]!.sha256);
        hashes.push(createHash('sha256').update(bytes).digest('hex'));
      }
      for (const name of ['__qc_bundle__.js', '__quick_compile__.js']) {
        const path = await paths.resolve(`temp/quick-scripts/dst/${name}`), info = await stat(path);
        if (!info.isFile() || info.size > 16 * 1024 * 1024) return false;
        hashes.push(createHash('sha256').update(await readFile(path)).digest('hex'));
      }
      const fingerprint = hashes.join(':');
      if (!ready || fingerprint !== previous) { previous = fingerprint; stableSince = Date.now(); }
      // 原生 Promise 与 AssetDB 自动编译可能交错；必须核对目标 JS 内嵌源码映射及实际产物稳定性，不能只检查独立 .map。
      else if (Date.now() - stableSince >= 500) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }
  async compile(batch: JsonObject, cancelled: () => boolean): Promise<JsonObject> {
    const native = this.compiler();
    const unknown = (reason: string): JsonObject => ({ status: 'unknown', errors: [], reason });
    if (this.version !== '2.4.15' || !native || typeof native.compileScripts !== 'function' || typeof native.raw2import !== 'function' || typeof native.raw2dest !== 'function' || typeof native.isPlugin !== 'function') return unknown('Creator 2.4.15 native compiler APIs unavailable');
    // 原生 compileScripts 会先清除 errorScripts，必须先保留本次导入的语法错误，避免复制旧 JS 后误报成功。
    const importErrors = this.errors(native);
    if (importErrors.length) return { status: 'failed', errors: importErrors, signal: 'ProjectCompiler.errorScripts' };
    const sourceRows = batch.rows as JsonObject[], rows = sourceRows.filter(row => /\.(?:js|ts)$/i.test(String(row.url))), resources = sourceRows.filter(row => !rows.includes(row));
    let imported: JsonObject | undefined;
    if (resources.length) {
      if (!this.info) return unknown('Native importer output manifest adapter is unavailable');
      imported = await new ImporterArtifacts(this.projectPath, 2, this.info).compile({ ...batch, rows: resources }, cancelled);
      if (imported.status !== 'completed' || !rows.length) return imported;
    }
    const paths = await ProjectPaths.open(this.projectPath), scripts: string[] = [];
    const compiledModules: JsonObject[] = [];
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
    if (!await this.modulesReady(native, paths, scripts, rows, cancelled)) return unknown('Native compiled modules do not yet match the requested inline source maps or stable artifact bytes');
    for (let index = 0; index < scripts.length; index++) {
      const source = await readFile(scripts[index]!);
      if (createHash('sha256').update(source).digest('hex') !== rows[index]!.sha256) throw new CocosError('STALE_REVISION', 'Source changed during native compilation', { url: rows[index]!.url! });
      const mapPath = await paths.resolve(`${native.raw2import(scripts[index]!)}.map`);
      if ((await stat(mapPath)).size > 32 * 1024 * 1024) return unknown('Source map exceeds verification limit');
      const map = JSON.parse(await readFile(mapPath, 'utf8')) as { sourcesContent?: unknown[] };
      if (!Array.isArray(map.sourcesContent) || !map.sourcesContent.some(content => typeof content === 'string' && createHash('sha256').update(content).digest('hex') === rows[index]!.sha256)) return unknown('Imported source map does not match the requested source content');
      // 路径转换属于原生接口；符号链接和工程边界仍由统一策略检查。
      const compiledPath = await paths.resolve(native.raw2dest(scripts[index]!)), compiledInfo = await stat(compiledPath);
      if (!compiledInfo.isFile() || compiledInfo.size > 16 * 1024 * 1024) return unknown('Compiled module exceeds verification limit');
      const compiled = await readFile(compiledPath), mapUrl = /\/\/# sourceMappingURL=(data:[^\r\n]+)/.exec(compiled.toString())?.[1];
      if (!mapUrl) return unknown('Native compiled module does not expose an inline source map');
      const modulePath = relative(await paths.resolve('temp/quick-scripts/dst'), compiledPath).replaceAll('\\', '/');
      if (modulePath.startsWith('../')) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Native compiled module escapes preview script directory');
      // 2.4.15 以匿名 eval 执行 bundle 分段；只读取 source map 摘要匹配本次目标的 VM 脚本。
      compiledModules.push({ url: `/preview-scripts/${modulePath}`, sha256: createHash('sha256').update(compiled).digest('hex'), sourceMapSha256: createHash('sha256').update(mapUrl).digest('hex') });
    }
    const artifacts: JsonObject[] = imported?.artifacts as JsonObject[] ?? [];
    for (const name of ['__qc_bundle__.js', '__quick_compile__.js']) {
      const path = await paths.resolve(`temp/quick-scripts/dst/${name}`);
      if ((await stat(path)).size > 64 * 1024 * 1024) return unknown('Compiled preview artifact exceeds verification limit');
      artifacts.push({ url: `/preview-scripts/${name}`, ...(name === '__qc_bundle__.js' ? { kind: 'resource', resourceType: 'script-bundle' } : {}), sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    }
    artifacts.push(...compiledModules);
    return { status: 'completed', sourceRevision: batch.sourceRevision!, artifacts, errors: [], signal: 'ProjectCompiler.compileScripts Promise', evidence: 'native-completion-and-import-source-map' };
  }
}
