import { createHash, randomBytes } from 'crypto';
import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import type { Creator2Port } from './index.js';

export class Creator2Shader {
  constructor(private readonly port: Creator2Port) {}
  private hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
  private async read(url: string): Promise<JsonObject> {
    if (!/\.(effect|chunk|mtl)$/.test(url)) throw new CocosError('INVALID_ARGUMENT', 'Expected effect, chunk or material');
    const file = await (await ProjectPaths.open(this.port.projectPath)).asset(url);
    if ((await stat(file)).size > 8 * 1024 * 1024) throw new CocosError('INVALID_ARGUMENT', 'Source exceeds 8 MiB');
    const content = await readFile(file, 'utf8');
    return { url, content, sourceHash: this.hash(content), uuid: Json.value(await this.port.asset('urlToUuid', url)) };
  }
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    if (id === 'shader.environment') return { editorVersion: this.port.version, nativeCompiler: false, sourceImporter: true, gpuValidation: 'managed-preview-only', limitations: ['不复用 Creator 3 Effect 编译器或渲染管线状态 schema'] };
    if (this.port.version !== '2.4.15') throw new CocosError('UNSUPPORTED_VERSION', 'Shader adapter requires Creator 2.4.15');
    if (['shader.read', 'material.query'].includes(id)) return this.read(Json.string(p.url, 'url'));
    if (id === 'shader.inspect') { const source = await this.read(Json.string(p.url, 'url')); return { ...source, imported: Json.value(await this.port.scene('shader.inspect', { uuid: source.uuid! })), gpuValidated: false }; }
    if (['material.properties', 'material.defines', 'material.states'].includes(id)) { const source = await this.read(Json.string(p.url, 'url')); return Json.value(await this.port.scene('material.inspect', { uuid: source.uuid! })); }
    if (id === 'material.bindings') { const source = await this.read(Json.string(p.url, 'url')); return Json.value(await this.port.scene('material.bindings', { uuid: source.uuid! })); }
    if (id === 'material.assign') return Json.value(await this.port.scene('material.assign', p));
    if (id === 'material.create') {
      const effectUuid = Json.value(await this.port.asset('urlToUuid', Json.string(p.effectUrl, 'effectUrl')));
      const content = await this.port.scene('material.serialize', { ...p, effectUuid });
      await this.port.asset('create', p.url, JSON.stringify(content)); return this.read(String(p.url));
    }
    if (id === 'shader.create') { await this.port.asset('create', p.url, p.content); return this.read(String(p.url)); }
    const paths = await ProjectPaths.open(this.port.projectPath), directory = await paths.work('cache', 'creator2-source-backups');
    let backupId: string, before: JsonObject, content: string;
    if (id === 'shader.restore') {
      backupId = Json.string(p.backupId, 'backupId'); if (!/^[a-f0-9]{32}$/.test(backupId)) throw new CocosError('INVALID_ARGUMENT', 'Invalid backup ID');
      const backup = Json.object(JSON.parse(await readFile(join(directory, `${backupId}.json`), 'utf8'))); before = await this.read(String(backup.url));
      if (backup.uuid !== before.uuid || this.hash(String(backup.content)) !== backup.sourceHash) throw new CocosError('VERIFICATION_FAILED', 'Backup UUID or checksum differs');
      content = String(backup.content);
    } else if (['shader.update','material.update','material.apply_runtime','material.migrate'].includes(id)) {
      before = await this.read(Json.string(p.url, 'url')); backupId = randomBytes(16).toString('hex');
      if (id === 'shader.update') content = Json.string(p.content, 'content');
      else {
        if (before.sourceHash !== p.expectedHash) throw new CocosError('STALE_REVISION', 'Material source changed');
        const effectUuid = p.effectUrl ? Json.value(await this.port.asset('urlToUuid', p.effectUrl)) : undefined;
        const serialized = await this.port.scene('material.serialize', { ...p, sourceUuid: before.uuid!, ...(effectUuid ? { effectUuid } : {}) });
        content = typeof serialized === 'string' ? serialized : JSON.stringify(serialized);
        if (id === 'material.migrate' && p.apply !== true) return { ...before, proposedContent: content, applied: false, requiresExpectedHash: true };
      }
      if (before.sourceHash !== p.expectedHash) throw new CocosError('STALE_REVISION', 'Shader source changed');
      await writeFile(join(directory, `${backupId}.json`), JSON.stringify(before), { flag: 'wx', mode: 0o600 });
    } else throw new CocosError('UNSUPPORTED_CAPABILITY', id);
    if ((await this.read(String(before.url))).sourceHash !== p.expectedHash) throw new CocosError('STALE_REVISION', 'Shader changed before write');
    try {
      await this.port.asset('saveExists', before.url, content); const after = await this.read(String(before.url));
      if (after.sourceHash !== this.hash(content) || after.uuid !== before.uuid) throw new CocosError('VERIFICATION_FAILED', 'Source or UUID failed readback');
      return { ...after, backupId, saved: true, restoreCapability: 'shader.restore', gpuValidated: false };
    } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Shader source update needs inspection', { backupId, url: before.url!, cause: CocosError.from(error).message }); }
  }
}
