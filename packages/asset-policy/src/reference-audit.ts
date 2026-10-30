import { lstat, readdir } from 'fs/promises';
import { extname, join, relative, sep } from 'path';
import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import { FileSnapshots } from '../../native-adapters/src/file-snapshot.js';
import { AssetUuid } from './uuid.js';

interface Target { url: string; uuid: string; aliases: Set<string> }

/** 只读候选审查：文本命中不等于可执行引用，更不构成自动搬移/改写授权。 */
export class AssetReferenceAudit {
  constructor(private readonly projectPath: string) {}
  private readonly snapshots = new FileSnapshots();
  private readonly resourceIds = new AssetUuid();
  private async safe(paths: ProjectPaths, url: string): Promise<string> {
    const path = await paths.asset(url); let current = paths.root;
    for (const segment of relative(paths.root, path).split(sep)) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Reference audit does not follow symbolic links');
    }
    return path;
  }
  private aliases(url: string): Set<string> {
    const path = url.slice('db://assets/'.length), parts = path.split('/'), rows = new Set([url, 'assets/' + path]);
    // 短路径可能属于 resources、Bundle 或自定义解析器，只列为候选，不推断加载根。
    for (let index = 0; index < parts.length; index++) {
      const suffix = parts.slice(index).join('/'); rows.add(suffix); rows.add(suffix.slice(0, suffix.length - extname(suffix).length));
    }
    return rows;
  }
  inspect(sourceUrl: string, text: string, targets: Array<{ url: string; uuid: string }>): JsonObject {
    const candidates: Target[] = targets.map(row => ({ ...row, aliases: this.aliases(row.url) }));
    const literals = new Map<string, string[]>(), uuids = new Map<string, string[]>();
    for (const target of candidates) {
      const uuid = this.resourceIds.normalize(target.uuid);
      uuids.set(uuid, [...uuids.get(uuid) ?? [], target.url]);
      for (const alias of target.aliases) literals.set(alias, [...literals.get(alias) ?? [], target.url]);
    }
    const rows: JsonObject[] = [], issues: JsonObject[] = [], lineStarts = [0];
    let outputWeight = 0;
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    const location = (offset: number): JsonObject => {
      let low = 0, high = lineStarts.length;
      while (low + 1 < high) { const middle = (low + high) >> 1; if (lineStarts[middle]! <= offset) low = middle; else high = middle; }
      return { line: low + 1, column: offset - lineStarts[low]! + 1, offset };
    };
    const add = (row: JsonObject): void => {
      outputWeight += 1 + (Array.isArray(row.targetUrls) ? row.targetUrls.length : 0);
      if (rows.length >= 10000 || outputWeight > 20000) throw new CocosError('RESOURCE_BUSY', 'Reference audit output limit exceeded');
      rows.push({ sourceUrl, ...row, automaticRewriteAllowed: false });
    };
    const issue = (row: JsonObject): void => {
      if (issues.length >= 1000) throw new CocosError('RESOURCE_BUSY', 'Reference audit issue budget exceeded');
      issues.push(row);
    };
    const structured = ['.json', '.scene', '.fire', '.prefab', '.mtl', '.anim', '.gltf'].includes(extname(sourceUrl).toLowerCase());
    if (structured) {
      try {
        const value: unknown = JSON.parse(text); let visited = 0;
        const walk = (value: unknown, path: string, depth: number): void => {
          if (++visited > 100000 || depth > 64) throw new CocosError('RESOURCE_BUSY', 'Serialized reference scan limit exceeded');
          if (!value || typeof value !== 'object') return;
          if (Array.isArray(value)) { value.forEach((row, index) => walk(row, `${path}[${index}]`, depth + 1)); return; }
          const record = value as Record<string, unknown>;
          if (typeof record.__uuid__ === 'string') {
            const canonicalTargetUuid = this.resourceIds.normalize(record.__uuid__), matching = uuids.get(canonicalTargetUuid) ?? [];
            add({ kind: 'uuid', jsonPath: path + '.__uuid__', targetUuid: record.__uuid__, canonicalTargetUuid, targetUrls: matching,
              confidence: 'serialized-uuid-field', resolved: matching.length ? 'requested-target-meta-match' : 'unresolved',
              advice: matching.length ? '通过 AssetDB 保留 UUID，并在移动后复查引用' : '未匹配本次目标 meta；需 AssetDB 核对，不等于证明引用失效' });
          }
          for (const [key, child] of Object.entries(record)) walk(child, `${path}[${JSON.stringify(key)}]`, depth + 1);
        };
        walk(value, '$', 0);
      } catch (error) {
        if (error instanceof CocosError) throw error;
        issue({ sourceUrl, code: 'STRUCTURED_PARSE_UNAVAILABLE', advice: '保留文本候选，但不能证明结构化引用覆盖完整' });
      }
    }
    const script = /\.(?:[cm]?js|tsx?)$/i.test(sourceUrl);
    for (let i = 0; i < text.length;) {
      if (text.startsWith('//', i)) { const end = text.indexOf('\n', i + 2); i = end < 0 ? text.length : end + 1; continue; }
      if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
      const quote = text[i];
      if (quote === '"' || quote === "'" || quote === '`') {
        const start = i++; let raw = '';
        while (i < text.length && text[i] !== quote) { if (text[i] === '\\' && i + 1 < text.length) { raw += text.slice(i, i + 2); i += 2; } else raw += text[i++]; }
        const closed = i < text.length; i++;
        if (quote === '`') {
          if (script) add({ ...location(start), kind: 'dynamic-unknown', confidence: 'template-syntax-only', advice: '模板字符串及其插值需人工检查；不推断最终加载路径' });
          continue;
        }
        if (!closed) { issue({ sourceUrl, ...location(start), code: 'UNTERMINATED_STRING' }); continue; }
        let literal = raw;
        if (quote === '"') { try { literal = JSON.parse('"' + raw + '"') as string; } catch { issue({ sourceUrl, ...location(start), code: 'STRING_ESCAPE_UNRESOLVED' }); } }
        else if (raw.includes('\\')) { issue({ sourceUrl, ...location(start), code: 'STRING_ESCAPE_UNRESOLVED' }); continue; }
        const matching = literals.get(literal) ?? [];
        if (matching.length) add({ ...location(start), kind: 'literal-path', value: literal, targetUrls: matching, confidence: 'text-candidate-only',
          advice: '核对 resources/Bundle/自定义解析上下文；同名字面量可能不是资源引用，不能自动替换' });
        continue;
      }
      if (script && /[A-Za-z_$]/.test(text[i]!)) {
        const start = i++; while (i < text.length && /[\w$]/.test(text[i]!)) i++;
        const name = text.slice(start, i), rest = text.slice(i).match(/^\s*\(\s*/);
        if (['load', 'loadDir', 'loadRes', 'loadResDir', 'loadBundle'].includes(name) && rest) {
          // 即使首参是字面量，后续拼接、接收者或 Bundle 归属仍未解析，保持未知而非安全结论。
          add({ ...location(start), kind: 'dynamic-unknown', callName: name, confidence: 'unresolved-call-context', advice: '检查调用参数、别名和 Bundle 归属；未执行脚本或解析自定义加载器' });
        }
        continue;
      }
      i++;
    }
    return { rows, issues };
  }
  async audit(params: JsonObject): Promise<JsonObject> {
    const urls = params.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 2000) throw new CocosError('INVALID_ARGUMENT', 'Expected 1..2000 target URLs');
    const paths = await ProjectPaths.open(this.projectPath), targets: Array<{ url: string; uuid: string }> = [];
    let remaining = 64 * 1024 * 1024, entries = 0, files = 0, outputWeight = 0;
    const rows: JsonObject[] = [], skipped: JsonObject[] = [], issues: JsonObject[] = [], sources: JsonObject[] = [];
    const read = async (path: string, max: number) => { const value = await this.snapshots.read(path, Math.min(max, remaining), true); remaining -= value.bytes; return value; };
    const metadata: Array<{ path: string; identity: import('fs').Stats }> = [];
    for (const raw of [...new Set(urls)]) {
      const url = Json.string(raw, 'url'), path = await this.safe(paths, url);
      if (!(await lstat(path)).isFile()) throw new CocosError('INVALID_ARGUMENT', 'Reference target must be a file');
      const meta = await read(path + '.meta', 1024 * 1024);
      targets.push({ url, uuid: Json.string(JSON.parse(meta.text!).uuid, 'asset UUID') }); metadata.push({ path: path + '.meta', identity: meta.identity });
    }
    const scopeUrl = String(params.scopeUrl ?? 'db://assets/'), scope = await this.safe(paths, scopeUrl);
    if (!(await lstat(scope)).isDirectory()) throw new CocosError('INVALID_ARGUMENT', 'Reference scope must be a directory');
    const visit = async (path: string, url: string): Promise<void> => {
      await this.safe(paths, url);
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++entries > 50000) throw new CocosError('RESOURCE_BUSY', 'Reference scan entry budget exceeded; narrow scope');
        const child = join(path, entry.name), childUrl = url.replace(/\/$/, '') + '/' + entry.name;
        if (entry.isSymbolicLink()) { skipped.push({ sourceUrl: childUrl, reason: 'symbolic-link' }); continue; }
        if (entry.isDirectory()) { if (params.recursive !== false) await visit(child, childUrl); else skipped.push({ sourceUrl: childUrl, reason: 'outside-nonrecursive-scope' }); continue; }
        if (!entry.isFile() || !/\.(?:[cm]?js|tsx?|json|scene|fire|prefab|mtl|anim|gltf|effect)$/i.test(entry.name)) continue;
        if (++files > 2000) throw new CocosError('RESOURCE_BUSY', 'Reference scan source-file budget exceeded');
        await this.safe(paths, childUrl);
        const snapshot = await read(child, 8 * 1024 * 1024), result = this.inspect(childUrl, snapshot.text!, targets);
        rows.push(...result.rows as JsonObject[]); issues.push(...result.issues as JsonObject[]);
        for (const row of result.rows as JsonObject[]) outputWeight += 1 + (Array.isArray(row.targetUrls) ? row.targetUrls.length : 0);
        if (rows.length > 10000 || outputWeight > 50000 || issues.length > 1000) throw new CocosError('RESOURCE_BUSY', 'Reference audit output limit exceeded');
        sources.push({ sourceUrl: childUrl, sha256: snapshot.sha256, bytes: snapshot.bytes });
      }
    };
    await visit(scope, scopeUrl);
    for (const meta of metadata) await this.snapshots.verify(meta.path, meta.identity);
    return { rows, skipped, issues, sources, targets, scopeUrl, scanComplete: skipped.length === 0 && issues.length === 0,
      referenceCoverageComplete: false, automaticRewriteAllowed: false,
      limitations: ['扫描是逐文件快照，不是跨文件事务；移动前必须重新规划与复核', '仅覆盖列出的文本扩展名；二进制、未知 UUID 格式、自定义加载封装和运行时生成路径未解析', 'UUID 匹配保留子资源后缀，不推断任意子资源与主资源的映射', '文本词法候选不是完整 JS/TS AST；正则字面量等语法可能产生额外候选', 'Bundle/resources 中的脚本照常读取，但不推断 Bundle 名称到物理目录的映射'] };
  }
}
