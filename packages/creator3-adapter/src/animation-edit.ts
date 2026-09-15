import { Ajv } from 'ajv';
import { AnimationCapabilities } from '../../capability-catalog/src/animation.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import type { EditorPort } from './port.js';

export class AnimationEditService {
  constructor(private readonly port: EditorPort) {}
  private hash(content: string): string { return createHash('sha256').update(content).digest('hex'); }
  private async read(url: string): Promise<JsonObject> {
    if (!url.endsWith('.anim')) throw new CocosError('INVALID_ARGUMENT', 'Expected .anim asset URL');
    const file = await (await ProjectPaths.open(this.port.projectPath)).asset(url);
    if ((await stat(file)).size > 16 * 1024 * 1024) throw new CocosError('INVALID_ARGUMENT', 'Animation source exceeds 16 MiB');
    const content = await readFile(file, 'utf8'), asset = Json.object(await this.port.request('asset-db', 'query-asset-info', url));
    if (!asset.uuid) throw new CocosError('NOT_FOUND', 'Animation asset is not imported');
    return { url, content, sourceHash: this.hash(content), uuid: asset.uuid };
  }
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    if (this.port.version !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Animation editing requires Creator 3.8.8');
    const capability = new AnimationCapabilities().list().find(row => row.id === id);
    if (!capability || !new Ajv({ strict: true }).compile(capability.inputSchema)(p)) throw new CocosError('INVALID_ARGUMENT', 'Invalid animation edit parameters');
    const url = Json.string(p.url, 'url'), before = await this.read(url);
    if (id === 'animation.clip.read') return before;
    if (before.sourceHash !== p.expectedHash) throw new CocosError('STALE_REVISION', 'Animation source changed; read again');
    const paths = await ProjectPaths.open(this.port.projectPath);
    let content: string, backupId: string;
    if (id === 'animation.clip.patch') {
      const serialized = await this.port.scene('animation.clip.patchSource', { content: before.content!, patches: p.patches! });
      content = JSON.stringify(serialized); backupId = randomUUID();
      const directory = await paths.work('cache', 'animation-backups');
      await writeFile(join(directory, `${backupId}.json`), JSON.stringify(before), { flag: 'wx', mode: 0o600 });
    } else if (id === 'animation.clip.restore') {
      backupId = Json.string(p.backupId, 'backupId');
      if (!/^[a-f0-9-]{36}$/.test(backupId)) throw new CocosError('INVALID_ARGUMENT', 'Invalid animation backup ID');
      const backup = Json.object(JSON.parse(await readFile(await paths.resolve(`.codex-work/cache/animation-backups/${backupId}.json`), 'utf8')));
      if (backup.url !== url || backup.uuid !== before.uuid) throw new CocosError('INVALID_ARGUMENT', 'Animation backup targets a different asset');
      content = Json.string(backup.content, 'backup content');
      if (this.hash(content) !== backup.sourceHash) throw new CocosError('VERIFICATION_FAILED', 'Animation backup content is corrupt');
    } else throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown animation edit operation: ${id}`);
    const latest = await this.read(url);
    if (latest.sourceHash !== before.sourceHash || latest.uuid !== before.uuid) throw new CocosError('STALE_REVISION', 'Animation changed before write');
    try {
      const saved = await this.port.request('asset-db', 'save-asset', url, content);
      if (saved === false) throw new CocosError('EDITOR_ERROR', 'AssetDB rejected animation source');
      const after = await this.read(url);
      if (after.sourceHash !== this.hash(content) || after.uuid !== before.uuid) throw new CocosError('VERIFICATION_FAILED', 'Animation source or UUID failed readback');
      const clip = Json.value(await this.port.scene('animation.clip.inspect', { uuid: after.uuid! }));
      return { ...after, backupId, clip, saved: true, restored: id.endsWith('restore') };
    } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Animation write incomplete; inspect before retrying or restoring', { url, uuid: before.uuid!, backupId, cause: CocosError.from(error).message }); }
  }
}
