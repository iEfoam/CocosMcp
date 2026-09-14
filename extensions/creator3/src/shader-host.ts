import { createHash } from 'crypto';
import { readFileSync, readdirSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'path';
import { createRequire } from 'module';
import { runInThisContext } from 'vm';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { ShaderDiagnostics } from '../../../packages/shader-core/src/index.js';

interface Compiler { options: Record<string, unknown>; addChunk(name: string, source: string): void; buildEffect(name: string, source: string): unknown }

export class CreatorShaderHost {
  constructor(private readonly appPath: string, private readonly projectPath: string, private readonly version: string) {}
  private hash(source: string): string { return createHash('sha256').update(source).digest('hex'); }
  private files(root: string, extension: string): string[] {
    const rows: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(root, entry.name);
      if (entry.isDirectory()) rows.push(...this.files(path, extension));
      else if (entry.isFile() && entry.name.endsWith(extension)) rows.push(path);
    }
    return rows;
  }
  private engineAssets(): string { return join(dirname(this.appPath), 'resources/3d/engine/editor/assets'); }
  async execute(method: string, p: JsonObject): Promise<JsonValue> {
    if (this.version !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Native compiler is pinned to Creator 3.8.8');
    if (method === 'templates') {
      const root = join(this.engineAssets(), 'effects');
      const files = this.files(root, '.effect');
      const rows = files.filter(path => !p.name || relative(root, path) === p.name).map(path => ({
        name: relative(root, path), editorVersion: this.version, sourceHash: this.hash(readFileSync(path, 'utf8')),
        ...(p.name ? { content: readFileSync(path, 'utf8') } : {}), verification: 'engine-builtin' }));
      if (p.name && !rows.length) throw new CocosError('NOT_FOUND', 'Shader template not found');
      return { rows };
    }
    if (method !== 'compile') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Unknown compiler host operation');
    const compilerPath = join(this.appPath, 'modules/engine-extensions/extensions/engine-extends/static/effect-compiler/shdc-lib.js');
    // 每次使用独立词法作用域，避免原生编译器的全局 Chunk 缓存污染其他工程或保留旧依赖。
    // 这里只执行精确版本安装包内的可信编译器代码，不执行工程中的 JS。
    const factory = runInThisContext(`(function(require,module,exports,__filename,__dirname){${readFileSync(compilerPath, 'utf8')}\n})`, { filename: compilerPath }) as
      (require: NodeRequire, module: { exports: unknown }, exports: unknown, filename: string, directory: string) => void;
    const compilerModule = { exports: {} as unknown };
    factory(createRequire(compilerPath), compilerModule, compilerModule.exports, compilerPath, dirname(compilerPath));
    const compiler = compilerModule.exports as Compiler;
    const chunks = new Map<string, string>(); const dependencies: JsonObject[] = [];
    for (const root of [join(this.engineAssets(), 'chunks'), join(this.projectPath, 'assets')]) {
      for (const path of this.files(root, '.chunk')) {
        const name = relative(root, path).split(sep).join('/').replace(/\.chunk$/, '');
        if (chunks.has(name)) throw new CocosError('INVALID_ARGUMENT', `Ambiguous Chunk: ${name}`);
        chunks.set(name, path);
      }
    }
    compiler.options.chunkSearchFn = (name: string): { name: string; content?: string } => {
      const normalized = name.replace(/\.chunk$/, ''); const path = chunks.get(normalized);
      if (!path) return { name: normalized };
      const actual = realpathSync(path);
      const roots = [realpathSync(this.engineAssets()), realpathSync(this.projectPath)];
      if (!roots.some(root => { const rel = relative(root, actual); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); })) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Chunk escaped allowed roots');
      const content = readFileSync(actual, 'utf8');
      dependencies.push({ name: normalized, path: actual, sourceHash: this.hash(content) });
      return { name: normalized, content };
    };
    // 原生错误路径可能只输出日志；启用抛错，确保不能把失败报告为成功。
    compiler.options.throwOnWarning = true;
    compiler.options.noSource = false;
    try {
      const compiled = Json.object(Json.value(compiler.buildEffect(basename(String(p.url), '.effect'), Json.string(p.content, 'content'))));
      if (!Array.isArray(compiled.techniques) || !Array.isArray(compiled.shaders)) throw new Error('Compiler returned no techniques or shader programs');
      return { status: 'passed', stage: 'creator-compile', compiled, dependencies, rows: [],
        dependencyHash: this.hash(Json.canonical(dependencies)), warningPolicy: 'warnings-as-errors' };
    } catch (error) {
      return { status: 'failed', stage: 'creator-compile', dependencies, rows: [new ShaderDiagnostics().from(error, String(p.url))], warningPolicy: 'warnings-as-errors' };
    }
  }
}
