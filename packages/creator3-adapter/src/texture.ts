import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Ajv } from 'ajv';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import { TextureCapabilities } from '../../capability-catalog/src/texture.js';
import { TwoDCapabilities } from '../../capability-catalog/src/two-d.js';
import type { EditorPort } from './port.js';

/** 原生导入设置只通过 AssetDB 保存；备份和源码指纹限定在当前工程。 */
export class TextureService {
  constructor(private readonly port: EditorPort, private readonly family: 'texture' | 'spriteframe' = 'texture') {}
  private hash(value: JsonValue): string { return createHash('sha256').update(Json.canonical(value)).digest('hex'); }
  private async read(url: string): Promise<JsonObject> {
    const paths = await ProjectPaths.open(this.port.projectPath), path = await paths.asset(url);
    if ((await stat(path)).size > 64 * 1024 * 1024) throw new CocosError('INVALID_ARGUMENT', 'Texture source exceeds 64 MiB inspection limit');
    const asset = Json.object(await this.port.request('asset-db', 'query-asset-info', url));
    const meta = Json.object(await this.port.request('asset-db', 'query-asset-meta', url));
    if (!asset.uuid || asset.uuid !== meta.uuid || !['image', 'texture'].includes(String(meta.importer))) throw new CocosError('INVALID_ARGUMENT', 'Expected a source image/texture with matching AssetDB UUID');
    const sourceHash = createHash('sha256').update(await readFile(path)).digest('hex');
    return { url, asset, meta, sourceHash, expectedHash: this.hash({ meta, sourceHash }) };
  }
  private target(meta: JsonObject, uuid?: JsonValue): JsonObject {
    const rows = [meta, ...Object.values(Json.object(meta.subMetas ?? {})).map(value => Json.object(value))].filter(row => row.importer === (this.family === 'texture' ? 'texture' : 'sprite-frame'));
    const candidates = uuid ? rows.filter(row => row.uuid === uuid) : rows;
    if (candidates.length !== 1) throw new CocosError('INVALID_ARGUMENT', 'Specify textureUuid identifying exactly one texture subresource');
    return candidates[0]!;
  }
  async plan(p: JsonObject): Promise<JsonObject> {
    const before = await this.read(Json.string(p.url, 'url')), meta = Json.object(Json.value(before.meta));
    const target = this.target(meta, p.textureUuid ?? p.spriteFrameUuid), settings = Json.object(p.settings), original = Json.object(target.userData ?? {});
    target.userData = { ...original, ...settings };
    if (this.family === 'spriteframe') {
      const data = Json.object(target.userData), width = Number(data.width), height = Number(data.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new CocosError('UNSUPPORTED_CAPABILITY', 'SpriteFrame importer dimensions are unavailable');
      if (Number(data.borderLeft ?? 0) + Number(data.borderRight ?? 0) > width || Number(data.borderTop ?? 0) + Number(data.borderBottom ?? 0) > height) throw new CocosError('INVALID_ARGUMENT', 'Nine-slice borders exceed frame dimensions');
    }
    const rows = Object.entries(settings).map(([property, value]) => ({ property, before: original[property] ?? null, after: value }));
    return { ...before, textureUuid: target.uuid!, plannedMeta: meta, rows, planHash: this.hash({ before, meta, textureUuid: target.uuid! }), requiresReimport: rows.some(row => Json.canonical(row.before) !== Json.canonical(row.after)) };
  }
  private async write(url: string, meta: JsonObject): Promise<void> {
    const saved = await this.port.request('asset-db', 'save-asset-meta', url, JSON.stringify(meta));
    if (saved === false) throw new CocosError('EDITOR_ERROR', 'AssetDB rejected texture metadata');
    const imported = await this.port.request('asset-db', 'reimport-asset', url);
    if (imported === false) throw new CocosError('EDITOR_ERROR', 'AssetDB texture reimport failed');
    // reimport-asset 返回时子资源仍可能 imported=false；等待稳定指纹后才交付恢复令牌。
    // 不修改或忽略 imported/files 字段，否则会把尚未完成的导入错误当作成功。
    let previous: JsonValue | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      const state = await this.read(url), pending = [Json.object(state.meta)]; let ready = true;
      while (pending.length) { const entry = pending.pop()!; if (entry.imported === false) ready = false; for (const child of Object.values(Json.object(entry.subMetas ?? {}))) pending.push(Json.object(child)); }
      if (ready && state.expectedHash === previous) return;
      previous = ready ? state.expectedHash : undefined;
      await delay(100);
    }
    throw new CocosError('CONTEXT_UNAVAILABLE', 'Texture subresource import did not settle within 3 seconds');
  }
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    if (this.port.version !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Texture import tools require Creator 3.8.8');
    const capability = [...new TextureCapabilities().list(), ...new TwoDCapabilities().list()].find(row => row.id === id);
    if (!capability) throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown texture tool: ${id}`);
    const valid = new Ajv({ strict: true }).compile(capability.inputSchema);
    if (!valid(p)) throw new CocosError('INVALID_ARGUMENT', 'Invalid texture parameters', { errors: JSON.stringify(valid.errors) });
    if (id === `${this.family}.inspect`) {
      const result = await this.read(Json.string(p.url, 'url'));
      return { ...result, users: Json.value(await this.port.request('asset-db', 'query-asset-users', p.url)), limitations: ['未验证目标平台压缩结果或 GPU 采样画面'] };
    }
    if (id === 'texture.plan_import' || id === 'spriteframe.plan') return this.plan(p);
    if (id === 'texture.apply_import' || id === 'spriteframe.apply') {
      const plan = await this.plan(p);
      if (p.planHash !== plan.planHash) throw new CocosError('STALE_REVISION', 'Texture import plan changed; plan again');
      if (!plan.requiresReimport) return { changed: false, expectedHash: plan.expectedHash! };
      const paths = await ProjectPaths.open(this.port.projectPath), backupId = randomUUID(), directory = await paths.work('cache', 'texture-backups');
      await writeFile(join(directory, `${backupId}.json`), JSON.stringify({ url: p.url, meta: plan.meta, sourceHash: plan.sourceHash }), { flag: 'wx' });
      // 备份写盘期间用户也可能改动资源；再次核对后才进入 AssetDB。
      if ((await this.read(String(p.url))).expectedHash !== plan.expectedHash) throw new CocosError('STALE_REVISION', 'Texture changed while backing up');
      try {
        await this.write(String(p.url), Json.object(plan.plannedMeta));
        const after = await this.read(String(p.url)), target = this.target(Json.object(after.meta), plan.textureUuid);
        if (after.sourceHash !== plan.sourceHash || Json.object(after.asset).uuid !== Json.object(plan.asset).uuid || Object.entries(Json.object(p.settings)).some(([key, value]) => Json.canonical(Json.object(target.userData)[key] ?? null) !== Json.canonical(value))) throw new CocosError('VERIFICATION_FAILED', 'Texture import readback differs from plan');
        return { changed: true, backupId, ...after, rows: plan.rows! };
      } catch (error) {
        // 导入器可能已更新元数据，不能盲目覆盖用户/导入器新状态；恢复必须带当前 expectedHash。
        throw new CocosError('OUTCOME_UNKNOWN', 'Texture import incomplete; inspect before guarded restore', { url: p.url!, backupId, cause: CocosError.from(error).message });
      }
    }
    const paths = await ProjectPaths.open(this.port.projectPath), backupId = Json.string(p.backupId, 'backupId');
    const backupPath = await paths.resolve(`.codex-work/cache/texture-backups/${backupId}.json`);
    const backup = Json.object(JSON.parse(await readFile(backupPath, 'utf8')));
    if (backup.url !== p.url) throw new CocosError('INVALID_ARGUMENT', 'Texture backup belongs to a different asset');
    const before = await this.read(String(p.url));
    if (before.expectedHash !== p.expectedHash || before.sourceHash !== backup.sourceHash || Json.object(before.meta).uuid !== Json.object(backup.meta).uuid) throw new CocosError('STALE_REVISION', 'Texture or source changed before restore');
    try {
      await this.write(String(p.url), Json.object(backup.meta));
      const after = await this.read(String(p.url));
      if (after.expectedHash !== this.hash({ meta: backup.meta!, sourceHash: backup.sourceHash! })) throw new CocosError('VERIFICATION_FAILED', 'Texture restore readback differs from backup');
      return { restored: true, backupId, ...after };
    } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Texture restore incomplete; inspect current metadata before retrying', { backupId, url: p.url!, cause: CocosError.from(error).message }); }
  }
}
