import { createHash, randomBytes } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import { AtomicJsonFile } from '../../native-adapters/src/atomic-json.js';
import { FileSnapshots } from '../../native-adapters/src/file-snapshot.js';
export interface AssetOrganizationPort { projectPath: string; request(channel: string, message: string, ...args: unknown[]): Promise<unknown> }

const ROOT = 'db://assets/';
const TYPES: Record<string, { folder: string; aliases: string[]; extensions: string[] }> = {
  shader: { folder: 'Shaders', aliases: ['shaders', 'shader', 'effects', 'effect', '着色器'], extensions: ['.effect', '.chunk'] },
  material: { folder: 'Materials', aliases: ['materials', 'material', '材质'], extensions: ['.mtl'] },
  scene: { folder: 'Scenes', aliases: ['scenes', 'scene', '场景'], extensions: ['.scene', '.fire'] },
  prefab: { folder: 'Prefabs', aliases: ['prefabs', 'prefab', '预制体'], extensions: ['.prefab'] },
  texture: { folder: 'Textures', aliases: ['textures', 'texture', 'images', 'sprites', '图片', '贴图'], extensions: ['.png', '.jpg', '.jpeg', '.webp', '.tga', '.bmp', '.hdr'] },
  model: { folder: 'Models', aliases: ['models', 'model', 'meshes', 'mesh', '模型'], extensions: ['.gltf', '.glb', '.fbx', '.obj'] },
  audio: { folder: 'Audio', aliases: ['audio', 'sounds', 'sound', 'music', '音频'], extensions: ['.mp3', '.wav', '.ogg', '.m4a'] },
  animation: { folder: 'Animations', aliases: ['animations', 'animation', 'clips', '动画'], extensions: ['.anim', '.animgraph', '.animask'] },
  font: { folder: 'Fonts', aliases: ['fonts', 'font', '字体'], extensions: ['.ttf', '.otf', '.fnt'] },
  script: { folder: 'Scripts', aliases: ['scripts', 'script', '脚本'], extensions: ['.ts', '.js'] },
  data: { folder: 'Data', aliases: ['data', 'configs', 'config', '数据'], extensions: ['.json', '.txt', '.csv'] },
};

/** 所有持久化操作仍由 AssetDB 完成；扫描只读，不直接搬动文件或 .meta。 */
export class AssetOrganization {
  constructor(private readonly port: AssetOrganizationPort, private readonly checkpoints: Pick<AtomicJsonFile, 'write'> = new AtomicJsonFile(), private readonly snapshots = new FileSnapshots()) {}
  private projectPaths?: Promise<ProjectPaths>;
  private paths(): Promise<ProjectPaths> { return this.projectPaths ??= ProjectPaths.open(this.port.projectPath); }
  private type(url: string): string { return Object.keys(TYPES).find(key => TYPES[key]!.extensions.includes(extname(url).toLowerCase())) ?? 'other'; }
  private hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
  private async exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
  private async path(url: string): Promise<string> {
    const paths = await this.paths(); const target = await paths.asset(url);
    // 即便链接仍在工程内，也不允许借助别名绕过分类和范围检查。
    let current = paths.root;
    for (const part of ['assets', ...url.slice(ROOT.length).split('/').filter(Boolean)]) {
      current = join(current, part);
      if (await this.exists(current) && (await lstat(current)).isSymbolicLink()) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Asset organization does not follow symlinks');
    }
    return target;
  }
  private async metaPath(url: string): Promise<string> {
    const path = await (await this.paths()).resolve((await this.path(url)) + '.meta');
    if (await this.exists(path) && (await lstat(path)).isSymbolicLink()) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Asset metadata must not be a symlink');
    return path;
  }
  private async protected(url: string): Promise<boolean> {
    const parts = url.slice(ROOT.length).split('/');
    if (parts.some(part => ['resources', 'editor', 'plugins', 'native', 'third-party', 'thirdparty'].includes(part.toLowerCase()))) return true;
    for (let i = 1; i < parts.length; i++) {
      const meta = await this.metaPath(ROOT + parts.slice(0, i).join('/'));
      if (await this.exists(meta)) { const data = JSON.parse((await this.snapshots.read(meta, 1024 * 1024, true)).text!); if ((data.userData?.isBundle || data.isBundle)) return true; }
    }
    return false;
  }
  private async folders(type: string): Promise<string[]> {
    const aliases = TYPES[type]?.aliases;
    if (!aliases) return [];
    let level = [ROOT], count = 0;
    while (level.length) {
      const next: string[] = [], candidates: string[] = [];
      for (const url of level) {
        for (const entry of await readdir(await this.path(url), { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
          if (++count > 10000) throw new CocosError('RESOURCE_BUSY', 'Type directory discovery exceeds 10000 folders; specify an explicit asset directory');
          const child = url.replace(/\/$/, '') + '/' + entry.name;
          if (await this.protected(child + '/_')) continue;
          next.push(child);
          if (aliases.includes(entry.name.toLowerCase())) candidates.push(child);
        }
      }
      // 同层全部比较后才能按稳定路径选择，找到最浅层后不再深入无关子树。
      if (candidates.length) return candidates.sort((a, b) => a.localeCompare(b, 'en'));
      level = next;
    }
    return [];
  }
  private async files(scope: string, recursive: boolean, skipped: JsonObject[]): Promise<string[]> {
    const files: string[] = []; let count = 0;
    const visit = async (url: string): Promise<void> => {
      if (await this.protected(url.replace(/\/$/, '') + '/_')) {
        skipped.push({ url, reason: 'protected-loading-path', scope: 'directory', descendantsScanned: false }); return;
      }
      for (const entry of (await readdir(await this.path(url), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (++count > 50000) throw new CocosError('RESOURCE_BUSY', 'Requested asset scope exceeds 50000 entries; narrow scopeUrl');
        if (entry.name.startsWith('.') || entry.name.endsWith('.meta')) continue;
        const child = url.replace(/\/$/, '') + '/' + entry.name;
        if (entry.isSymbolicLink()) { skipped.push({ url: child, reason: 'symbolic-link' }); continue; }
        if (entry.isDirectory()) { if (recursive) await visit(child); }
        else if (entry.isFile()) {
          files.push(child);
          if (files.length > 2000) throw new CocosError('INVALID_ARGUMENT', 'Organize at most 2000 files per plan');
        }
      }
    };
    await visit(scope); return files;
  }
  async location(url: string, folders?: string[]): Promise<JsonObject> {
    await this.path(url);
    if (!basename(url) || url.endsWith('/') || basename(url).endsWith('.meta')) throw new CocosError('INVALID_ARGUMENT', 'Expected an asset file name, not a folder or .meta');
    const type = this.type(url); const config = TYPES[type];
    const parent = url.slice(0, url.lastIndexOf('/'));
    let folderUrl = parent;
    if (parent === ROOT.slice(0, -1)) {
      const candidates = (folders ?? await this.folders(type)).filter(folder => config?.aliases.includes(basename(folder).toLowerCase()));
      candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'en'));
      folderUrl = candidates[0] ?? `${ROOT}${config?.folder ?? 'Other'}`;
    }
    const targetUrl = `${folderUrl}/${basename(url)}`;
    return { requestedUrl: url, url: targetUrl, folderUrl, type, reuseExistingFolder: await this.exists(await this.path(folderUrl)), targetExists: await this.exists(await this.path(targetUrl)) };
  }
  private async ensure(folderUrl: string): Promise<void> {
    const parts = folderUrl.slice(ROOT.length).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const url = ROOT + parts.slice(0, i).join('/'), path = await this.path(url);
      if (!await this.exists(path)) await this.port.request('asset-db', 'create-asset', url, null, { overwrite: false });
      if (!(await lstat(path)).isDirectory()) throw new CocosError('RESOURCE_BUSY', `Asset folder is occupied by a file: ${url}`);
      const info = await this.port.request('asset-db', 'query-asset-info', url);
      if (!info) throw new CocosError('VERIFICATION_FAILED', `Folder is not imported: ${url}`);
    }
  }
  async prepare(id: string, params: JsonObject): Promise<{ params: JsonObject; location?: JsonObject }> {
    const fields: Record<string, string> = { 'asset.create': 'url', 'asset.copy': 'targetUrl', 'shader.create': 'url', 'material.create': 'url', 'material.clone': 'targetUrl', 'scene.create': 'url', 'scene.save_copy': 'url', 'prefab.create': 'url', 'geometry.create': 'url', 'animation.clip.create': 'url', 'animation2d.create': 'url' };
    let key = fields[id]; let requested = key ? Json.string(params[key], key) : '';
    if (id === 'asset.import') {
      key = 'targetUrl'; requested = Json.string(params.targetUrl, 'targetUrl');
      const target = await this.path(requested);
      if (requested.endsWith('/') || (await this.exists(target) && (await lstat(target)).isDirectory())) requested = `${requested.replace(/\/$/, '')}/${basename(Json.string(params.sourcePath, 'sourcePath'))}`;
      const source = await (await this.paths()).resolve(Json.string(params.sourcePath, 'sourcePath'));
      if (!(await lstat(source)).isFile()) throw new CocosError('INVALID_ARGUMENT', 'Import one file at a time so its resource type can be organized');
    }
    if (!key) return { params };
    const location = await this.location(requested);
    if (location.targetExists) throw new CocosError('RESOURCE_BUSY', `Creation target already exists: ${location.url}`);
    await this.ensure(String(location.folderUrl));
    return { params: { ...params, [key]: location.url! }, location };
  }
  private async fingerprint(url: string, budget = { remaining: 1024 * 1024 * 1024 }): Promise<JsonObject> {
    const path = await this.path(url);
    const metadataPath = await this.metaPath(url);
    const meta = await this.snapshots.read(metadataPath, 1024 * 1024, true);
    const uuid = Json.string(JSON.parse(meta.text!).uuid, 'asset UUID');
    const source = await this.snapshots.read(path, budget.remaining);
    budget.remaining -= source.bytes;
    await this.snapshots.verify(metadataPath, meta.identity);
    return { uuid, sourceHash: source.sha256, metaHash: meta.sha256 };
  }
  async plan(params: JsonObject): Promise<JsonObject> {
    const scope = String(params.scopeUrl ?? ROOT).replace(/\/$/, '') + '/'; await this.path(scope);
    const skipped: JsonObject[] = [], directories = new Map<string, string[]>();
    const urls = params.urls ? (params.urls as JsonValue[]).map(value => Json.string(value, 'urls')) : await this.files(scope, params.recursive === true, skipped);
    if (urls.length > 2000) throw new CocosError('INVALID_ARGUMENT', 'Organize at most 2000 files per plan');
    const rows: JsonObject[] = []; const targets = new Set<string>();
    const fingerprintBudget = { remaining: 1024 * 1024 * 1024 };
    for (const url of [...new Set(urls)].sort()) {
      await this.path(url);
      if (!url.startsWith(scope)) throw new CocosError('INVALID_ARGUMENT', 'Source outside organization scope');
      const type = this.type(url), config = TYPES[type];
      let reason = '', reviewedSourceHash: string | undefined;
      if (await this.protected(url)) reason = 'protected-loading-path';
      else if (!config || ['script', 'data'].includes(type) || ['.obj', '.fbx', '.fnt', '.chunk'].includes(extname(url).toLowerCase())) reason = 'requires-reference-review';
      else if (url.slice(ROOT.length).split('/').slice(0, -1).some(part => config.aliases.includes(part.toLowerCase()))) reason = 'already-organized';
      else if (extname(url).toLowerCase() === '.gltf') {
        if ((await lstat(await this.path(url))).size > 16 * 1024 * 1024) { skipped.push({ url, reason: 'model-reference-review-size-limit' }); continue; }
        const inspected = await this.snapshots.read(await this.path(url), 16 * 1024 * 1024, true);
        reviewedSourceHash = inspected.sha256;
        const data = JSON.parse(inspected.text!);
        if ([...(data.buffers ?? []), ...(data.images ?? [])].some(row => row.uri && !row.uri.startsWith('data:'))) reason = 'external-model-dependencies';
      }
      if (reason) { skipped.push({ url, type, reason }); continue; }
      if (!directories.has(type)) directories.set(type, await this.folders(type));
      const location = await this.location(ROOT + basename(url), directories.get(type)!);
      if (location.targetExists || targets.has(String(location.url).toLowerCase())) { skipped.push({ url, type, reason: 'target-conflict', targetUrl: location.url! }); continue; }
      targets.add(String(location.url).toLowerCase());
      const fingerprint = await this.fingerprint(url, fingerprintBudget);
      if (reviewedSourceHash && fingerprint.sourceHash !== reviewedSourceHash) throw new CocosError('STALE_REVISION', 'Model changed after dependency inspection');
      rows.push({ sourceUrl: url, targetUrl: location.url!, type, ...fingerprint });
    }
    const planHash = this.hash(Json.canonical({ scopeUrl: scope, recursive: params.recursive === true, urls: [...new Set(urls)].sort(), rows, skipped }));
    return { planHash, rows, skipped, count: rows.length, scopeUrl: scope, referenceNotice: 'UUID references are preserved; agent must review string-based load paths before apply.',
      referenceReview: { capabilityId: 'asset.references.scan', urls: rows.map(row => row.sourceUrl!), automaticRewriteAllowed: false } };
  }
  async recovery(journalId: string): Promise<JsonObject> {
    if (!/^[a-f0-9]{24}$/.test(journalId)) throw new CocosError('INVALID_ARGUMENT', 'Expected a 24-character organization journalId');
    const paths = await this.paths(), file = await paths.resolve(join('.codex-work/logs/asset-organization', journalId + '.json'));
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new CocosError('VERIFICATION_FAILED', 'Invalid organization journal file');
    let report: JsonObject;
    try { report = Json.object(JSON.parse(await readFile(file, 'utf8'))); }
    catch { throw new CocosError('VERIFICATION_FAILED', 'Organization journal is damaged; preserve it for manual recovery'); }
    if (report.journalVersion !== undefined && report.journalVersion !== 1 || !Array.isArray(report.plannedRows) || report.plannedRows.length > 2000) throw new CocosError('VERIFICATION_FAILED', 'Unsupported organization journal');
    const planned = report.plannedRows.map(value => Json.object(value));
    // 先验证整份输入再查询资产，损坏账本不能被解释为安全重试计划。
    for (const row of planned) {
      await this.path(Json.string(row.sourceUrl, 'sourceUrl')); await this.path(Json.string(row.targetUrl, 'targetUrl'));
      Json.string(row.uuid, 'uuid');
      for (const field of ['sourceHash', 'metaHash']) if (!/^[a-f0-9]{64}$/.test(String(row[field]))) throw new CocosError('VERIFICATION_FAILED', 'Invalid journal fingerprint');
    }
    const rows: JsonObject[] = [], budget = { remaining: 1024 * 1024 * 1024 };
    for (const row of planned) {
      const sourceUrl = String(row.sourceUrl), targetUrl = String(row.targetUrl);
      const inspect = async (url: string): Promise<JsonObject | null> => {
        if (!await this.exists(await this.path(url))) return null;
        const fingerprint = await this.fingerprint(url, budget);
        const asset = Json.object(Json.value(await this.port.request('asset-db', 'query-asset-info', url)));
        return { ...fingerprint, importedUuid: asset.uuid ?? null };
      };
      const matches = (value: JsonObject | null): boolean => value !== null && value.uuid === row.uuid && value.importedUuid === row.uuid && value.sourceHash === row.sourceHash && value.metaHash === row.metaHash;
      try {
        const source = await inspect(sourceUrl), target = await inspect(targetUrl);
        const state = source === null && matches(target) ? 'moved' : target === null && matches(source) ? 'not-moved' : source === null && target === null ? 'unknown' : 'conflict';
        rows.push({ sourceUrl, targetUrl, uuid: row.uuid!, state, source, target });
      } catch (error) { rows.push({ sourceUrl, targetUrl, uuid: row.uuid!, state: 'unknown', errorCode: CocosError.from(error).code }); }
    }
    return { journalId, recordedStatus: report.status ?? 'unknown', inspectedAt: new Date().toISOString(), rows,
      automaticReplayAllowed: false, limitations: ['逐项只读快照，不是跨文件事务；执行任何后续移动前必须重新规划和检查引用'] };
  }

  async apply(params: JsonObject): Promise<JsonObject> {
    const plan = await this.plan(params);
    if (plan.planHash !== params.planHash) throw new CocosError('STALE_REVISION', 'Resource plan changed; run asset.organize.plan again');
    const rows = plan.rows as JsonObject[], completed: JsonObject[] = [];
    const journal = join(await (await this.paths()).work('logs', 'asset-organization'), `${randomBytes(12).toString('hex')}.json`);
    const report: JsonObject = { journalId: basename(journal, '.json'), journalVersion: 1, sequence: 0, status: 'running', planHash: plan.planHash!, rows: completed, plannedRows: rows, skipped: plan.skipped!, journal };
    let nativeWritesStarted = false;
    const persist = async (): Promise<void> => {
      // 先原子保存移动意图再调用 AssetDB；读者不能看到 truncate 后的半份恢复记录。
      report.sequence = Number(report.sequence) + 1; report.updatedAt = new Date().toISOString();
      try { await this.checkpoints.write(journal, report); }
      catch (error) {
        const failure = CocosError.from(error);
        // 终态落盘失败不能抹掉已完成的移动；第二次日志失败也必须携带最初错误和恢复位置。
        throw new CocosError(nativeWritesStarted ? 'OUTCOME_UNKNOWN' : 'EDITOR_ERROR', 'Organization checkpoint could not be persisted; inspect the preserved journal and asset identities', {
          journalId: report.journalId!, journal, checkpointSequence: report.sequence!, requestedStatus: report.status!,
          completed: [...completed], pending: report.pending ?? null, nativeWritesStarted,
          originalError: report.error ?? null, checkpointError: Json.value(failure.toJSON()),
        });
      }
    };
    await persist();
    for (const row of rows) {
      try {
        const source = String(row.sourceUrl), target = String(row.targetUrl);
        const actual = await this.fingerprint(source);
        if (actual.uuid !== row.uuid || actual.sourceHash !== row.sourceHash || actual.metaHash !== row.metaHash || await this.exists(await this.path(target))) throw new CocosError('STALE_REVISION', 'Asset changed during organization');
        nativeWritesStarted = true;
        await this.ensure(target.slice(0, target.lastIndexOf('/')));
        // 先记意图再移动，异常退出后可根据源/目标 UUID 判定结果，不盲目重试。
        report.pending = row; await persist();
        await this.port.request('asset-db', 'move-asset', source, target, { overwrite: false });
        const info = Json.object(Json.value(await this.port.request('asset-db', 'query-asset-info', target)));
        const after = await this.fingerprint(target);
        if (info.uuid !== row.uuid || after.uuid !== row.uuid || after.sourceHash !== row.sourceHash || after.metaHash !== row.metaHash || await this.exists(await this.path(source))) throw new CocosError('VERIFICATION_FAILED', 'Moved asset UUID/content verification failed');
        completed.push({ ...row, verified: true, rollback: { sourceUrl: target, targetUrl: source } }); delete report.pending; await persist();
      } catch (error) { report.status = 'partial'; report.failed = row; report.error = CocosError.from(error).toJSON() as unknown as JsonValue; await persist(); return report; }
    }
    report.status = 'completed'; await persist(); return report;
  }
}
