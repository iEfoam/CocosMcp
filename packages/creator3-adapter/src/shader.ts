import { createHash, randomBytes } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import { ShaderDiagnostics, ShaderVariants } from '../../shader-core/src/index.js';
import { PropertyDump } from './dump.js';
import type { EditorPort } from './port.js';

export class ShaderService {
  private projectPaths: Promise<ProjectPaths> | undefined;
  constructor(private readonly port: EditorPort) {}
  private paths(): Promise<ProjectPaths> { return this.projectPaths ??= ProjectPaths.open(this.port.projectPath); }
  private hash(source: string): string { return createHash('sha256').update(source).digest('hex'); }
  private async native(method: string, p: JsonObject): Promise<JsonObject> {
    if (!this.port.shader) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Shader host is not available');
    if (this.port.version !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Native shader adapter requires Creator 3.8.8');
    return Json.object(await this.port.shader(method, p));
  }
  private async read(url: string): Promise<JsonObject> {
    if (!/\.(effect|chunk|mtl)$/.test(url)) throw new CocosError('INVALID_ARGUMENT', 'Expected Effect, Chunk or Material resource');
    const path = await (await this.paths()).asset(url); const content = await readFile(path, 'utf8');
    return { url, content, sourceHash: this.hash(content) };
  }
  private async save(url: string, content: string, expectedHash?: string): Promise<JsonObject> {
    await (await this.paths()).asset(url);
    if (!/\.(effect|chunk|mtl)$/.test(url)) throw new CocosError('INVALID_ARGUMENT', 'Invalid resource extension');
    let backupId: string | null = null;
    if (expectedHash !== undefined) {
      const before = await this.read(url);
      if (before.sourceHash !== expectedHash) throw new CocosError('OPERATION_CONFLICT', 'Resource changed since it was read');
      backupId = randomBytes(16).toString('hex');
      const directory = await (await this.paths()).work('cache', 'shader/backups');
      await writeFile(join(directory, `${backupId}.json`), JSON.stringify(before), { flag: 'wx', mode: 0o600 });
      // 备份完成后再次检查，避免较慢的磁盘写入扩大并发窗口。
      if ((await this.read(url)).sourceHash !== expectedHash) throw new CocosError('OPERATION_CONFLICT', 'Resource changed while preparing backup');
    } else if (await this.port.request('asset-db', 'query-asset-info', url)) throw new CocosError('RESOURCE_BUSY', 'Target resource already exists');
    const asset = Json.value(await this.port.request('asset-db', expectedHash === undefined ? 'create-asset' : 'save-asset', url, content));
    const after = await this.read(url);
    if (after.sourceHash !== this.hash(content)) throw new CocosError('VERIFICATION_FAILED', 'AssetDB write does not match requested source', { backupId });
    return { ...after, backupId, saved: true, asset, importStatus: asset && typeof asset === 'object' && !Array.isArray(asset) && typeof asset.invalid === 'boolean' ? asset.invalid ? 'failed' : 'passed' : 'unverified', gpuValidation: 'not-run' };
  }
  private async compile(url: string, includeSource: boolean): Promise<JsonObject> {
    const before = await this.read(url); const taskId = randomBytes(16).toString('hex');
    let result: JsonObject;
    try { result = await this.native('compile', { url, content: before.content! }); }
    catch (error) {
      if (error instanceof CocosError && ['UNSUPPORTED_CAPABILITY', 'UNSUPPORTED_VERSION'].includes(error.code)) throw error;
      result = { status: 'failed', rows: [new ShaderDiagnostics().from(error, url)] };
    }
    const after = await this.read(url);
    const task: JsonObject = { ...result, taskId, url, sourceHash: before.sourceHash!, editorVersion: this.port.version,
      stale: before.sourceHash !== after.sourceHash, gpuValidation: 'not-run', execution: 'synchronous' };
    const directory = await (await this.paths()).work('cache', 'shader/tasks');
    await writeFile(join(directory, `${taskId}.json`), JSON.stringify(task), { flag: 'wx', mode: 0o600 });
    if (!includeSource) delete task.compiled;
    return task;
  }
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    if (id !== 'shader.environment' && this.port.version !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Shader tools require Creator 3.8.8');
    const str = (key: string): string => Json.string(p[key], key);
    switch (id) {
      case 'shader.environment': return { editorVersion: this.port.version, nativeCompiler: this.port.version === '3.8.8' && Boolean(this.port.shader),
        runtimeRequired: ['GPU compilation', 'preview', 'profiling'], supportedMajors: [3], verifiedPlatforms: [],
        compilerExecution: 'synchronous', cancellation: 'not-supported-during-native-call' };
      case 'shader.templates': return this.native('templates', p);
      case 'shader.preview.connect': {
        if (!this.port.preview) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Managed preview host unavailable');
        return Json.value(await this.port.preview('connect-runtime', p));
      }
      case 'shader.read': case 'material.query': return this.read(str('url'));
      case 'shader.create': return this.save(str('url'), str('content'));
      case 'shader.update': return this.save(str('url'), str('content'), str('expectedHash'));
      case 'shader.compile': return this.compile(str('url'), p.includeSource === true);
      case 'shader.validate': case 'shader.inspect': return this.compile(str('url'), id === 'shader.inspect');
      case 'shader.dependencies': {
        const compiled = await this.compile(str('url'), false);
        return { rows: compiled.dependencies ?? [], status: compiled.status!, sourceHash: compiled.sourceHash!, diagnostics: compiled.rows ?? [] };
      }
      case 'shader.diagnostics': {
        const taskId = str('taskId'); if (!/^[a-f0-9]{32}$/.test(taskId)) throw new CocosError('INVALID_ARGUMENT', 'Invalid task ID');
        const directory = await (await this.paths()).work('cache', 'shader/tasks');
        const task = Json.object(JSON.parse(await readFile(join(directory, `${taskId}.json`), 'utf8')));
        task.stale = (await this.read(Json.string(task.url, 'url'))).sourceHash !== task.sourceHash;
        for (const dependency of task.dependencies as JsonObject[] ?? []) {
          if (typeof dependency.path !== 'string' || typeof dependency.sourceHash !== 'string') continue;
          try { if (this.hash(await readFile(dependency.path, 'utf8')) !== dependency.sourceHash) task.stale = true; }
          catch { task.stale = true; }
        }
        delete task.compiled; return task;
      }
      case 'shader.variants.plan': return new ShaderVariants().plan(Json.object(p.axes), Number(p.limit ?? 64));
      case 'shader.restore': {
        const backupId = str('backupId'); if (!/^[a-f0-9]{32}$/.test(backupId)) throw new CocosError('INVALID_ARGUMENT', 'Invalid backup ID');
        const directory = await (await this.paths()).work('cache', 'shader/backups');
        const backup = Json.object(JSON.parse(await readFile(join(directory, `${backupId}.json`), 'utf8')));
        return this.save(Json.string(backup.url, 'url'), Json.string(backup.content, 'content'), str('expectedHash'));
      }
      case 'material.clone': {
        const source = await this.read(str('sourceUrl'));
        return this.save(str('targetUrl'), Json.string(source.content, 'content'));
      }
      case 'material.create': case 'material.update': case 'material.apply_runtime': case 'material.migrate': {
        const url = str('url'); if (!url.endsWith('.mtl')) throw new CocosError('INVALID_ARGUMENT', 'Material URL must end in .mtl');
        const before = id === 'material.create' ? null : await this.read(url);
        if (before && before.sourceHash !== str('expectedHash')) throw new CocosError('OPERATION_CONFLICT', 'Material changed since it was read');
        const effectUuid = p.effectUrl ? await this.port.request('asset-db', 'query-uuid', str('effectUrl')) : undefined;
        if (p.effectUrl && !effectUuid) throw new CocosError('NOT_FOUND', 'Effect resource not found');
        const result = Json.object(await this.port.scene('shader.material', { ...p, action: id,
          ...(effectUuid ? { effectUuid } : {}), ...(before ? { serialized: JSON.parse(String(before.content)) } : {}) }));
        if (id === 'material.migrate' && p.apply !== true) return { ...result, applied: false };
        const content = JSON.stringify(result.serialized, null, 2);
        return { ...await this.save(url, content, before ? str('expectedHash') : undefined), migration: result.migration ?? null };
      }
      case 'material.properties': case 'material.defines': case 'material.states': {
        const material = await this.read(str('url'));
        return Json.value(await this.port.scene('shader.material', { action: 'inspect', serialized: JSON.parse(String(material.content)) }));
      }
      case 'material.bindings': {
        const uuid = await this.port.request('asset-db', 'query-uuid', str('url'));
        if (!uuid) throw new CocosError('NOT_FOUND', 'Material resource not found');
        return { rows: Json.value(await this.port.scene('shader.bindings', uuid)), resourceUsers: Json.value(await this.port.request('asset-db', 'query-asset-users', str('url'))) };
      }
      case 'material.assign': return this.assign(p);
      default: throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown shader operation: ${id}`);
    }
  }
  private async assign(p: JsonObject): Promise<JsonObject> {
    // 绑定必须走编辑器属性记录，直接改引擎对象无法保证场景持久化和撤销。
    const binding = Json.object(await this.port.scene('shader.binding', p));
    if (binding.materialUuid !== p.expectedMaterialUuid) throw new CocosError('OPERATION_CONFLICT', 'Material slot changed since inspection');
    await this.port.scene('shader.checkMaterial', p.materialUuid);
    const nodeId = Json.string(binding.nodeId, 'owner'); const path = Json.string(binding.path, 'path');
    const before = Json.object(Json.value(await this.port.request('scene', 'query-component', p.componentId)));
    const dump = PropertyDump.assign(PropertyDump.locate(before, Json.string(binding.componentPath, 'componentPath')), { uuid: p.materialUuid! });
    const record = await this.port.request('scene', 'begin-recording', nodeId);
    try {
      await this.port.request('scene', 'set-property', { uuid: nodeId, path, dump });
      const after = Json.object(await this.port.scene('shader.binding', p));
      if (after.materialUuid !== p.materialUuid) throw new CocosError('VERIFICATION_FAILED', 'Material binding was not applied');
      await this.port.request('scene', 'end-recording', record); return after;
    } catch (error) {
      try { await this.port.request('scene', 'cancel-recording', record); }
      catch { throw new CocosError('OUTCOME_UNKNOWN', 'Material assignment and recording cancellation failed'); }
      throw error;
    }
  }
}
