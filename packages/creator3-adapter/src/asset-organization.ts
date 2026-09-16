import { createHash, randomBytes } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import type { EditorPort } from './port.js';

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
  constructor(private readonly port: EditorPort) {}
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
      if (await this.exists(meta)) { const data = JSON.parse(await readFile(meta, 'utf8')); if (data.userData?.isBundle) return true; }
    }
    return false;
  }
  private async scan(): Promise<{ folders: string[]; files: string[] }> {
    const folders: string[] = [], files: string[] = []; let count = 0;
    const visit = async (url: string): Promise<void> => {
      for (const entry of (await readdir(await this.path(url), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (++count > 50000) throw new CocosError('INVALID_ARGUMENT', 'Asset scan exceeds 50000 entries; narrow the project first');
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name.endsWith('.meta')) continue;
        const child = `${url.replace(/\/$/, '')}/${entry.name}`;
        if (entry.isDirectory()) { if (!await this.protected(`${child}/_`)) folders.push(child); await visit(child); }
        else if (entry.isFile()) files.push(child);
      }
    };
    await visit(ROOT); return { folders, files };
  }
  async location(url: string, folders?: string[]): Promise<JsonObject> {
    await this.path(url);
    if (!basename(url) || url.endsWith('/') || basename(url).endsWith('.meta')) throw new CocosError('INVALID_ARGUMENT', 'Expected an asset file name, not a folder or .meta');
    const type = this.type(url); const config = TYPES[type];
    const parent = url.slice(0, url.lastIndexOf('/'));
    let folderUrl = parent;
    if (parent === ROOT.slice(0, -1)) {
      const candidates = (folders ?? (await this.scan()).folders).filter(folder => config?.aliases.includes(basename(folder).toLowerCase()));
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
    const fields: Record<string, string> = { 'asset.create': 'url', 'asset.copy': 'targetUrl', 'shader.create': 'url', 'material.create': 'url', 'material.clone': 'targetUrl', 'scene.create': 'url', 'scene.save_copy': 'url', 'prefab.create': 'url', 'geometry.create': 'url' };
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
  private async fingerprint(url: string): Promise<JsonObject> {
    const path = await this.path(url);
    if (!(await lstat(path)).isFile()) throw new CocosError('INVALID_ARGUMENT', 'Organize source must be a regular file');
    const meta = await readFile(await this.metaPath(url), 'utf8');
    const uuid = Json.string(JSON.parse(meta).uuid, 'asset UUID');
    return { uuid, sourceHash: this.hash(await readFile(path)), metaHash: this.hash(meta) };
  }
  async plan(params: JsonObject): Promise<JsonObject> {
    const inventory = await this.scan();
    const scope = String(params.scopeUrl ?? ROOT).replace(/\/$/, '') + '/'; await this.path(scope);
    const urls = params.urls ? (params.urls as JsonValue[]).map(value => Json.string(value, 'urls')) : inventory.files.filter(url => url.startsWith(scope) && (params.recursive === true || !url.slice(scope.length).includes('/')));
    if (urls.length > 2000) throw new CocosError('INVALID_ARGUMENT', 'Organize at most 2000 files per plan');
    const rows: JsonObject[] = [], skipped: JsonObject[] = []; const targets = new Set<string>();
    for (const url of [...new Set(urls)].sort()) {
      await this.path(url);
      if (!url.startsWith(scope)) throw new CocosError('INVALID_ARGUMENT', 'Source outside organization scope');
      const type = this.type(url), config = TYPES[type];
      let reason = '';
      if (await this.protected(url)) reason = 'protected-loading-path';
      else if (!config || ['script', 'data'].includes(type) || ['.obj', '.fbx', '.fnt', '.chunk'].includes(extname(url).toLowerCase())) reason = 'requires-reference-review';
      else if (url.slice(ROOT.length).split('/').slice(0, -1).some(part => config.aliases.includes(part.toLowerCase()))) reason = 'already-organized';
      else if (extname(url).toLowerCase() === '.gltf') {
        const data = JSON.parse(await readFile(await this.path(url), 'utf8'));
        if ([...(data.buffers ?? []), ...(data.images ?? [])].some(row => row.uri && !row.uri.startsWith('data:'))) reason = 'external-model-dependencies';
      }
      if (reason) { skipped.push({ url, type, reason }); continue; }
      const location = await this.location(ROOT + basename(url), inventory.folders);
      if (location.targetExists || targets.has(String(location.url).toLowerCase())) { skipped.push({ url, type, reason: 'target-conflict', targetUrl: location.url! }); continue; }
      targets.add(String(location.url).toLowerCase());
      rows.push({ sourceUrl: url, targetUrl: location.url!, type, ...await this.fingerprint(url) });
    }
    const planHash = this.hash(Json.canonical({ scopeUrl: scope, recursive: params.recursive === true, urls: [...new Set(urls)].sort(), rows, skipped }));
    return { planHash, rows, skipped, count: rows.length, scopeUrl: scope, referenceNotice: 'UUID references are preserved; agent must review string-based load paths before apply.' };
  }
  async apply(params: JsonObject): Promise<JsonObject> {
    const plan = await this.plan(params);
    if (plan.planHash !== params.planHash) throw new CocosError('STALE_REVISION', 'Resource plan changed; run asset.organize.plan again');
    const rows = plan.rows as JsonObject[], completed: JsonObject[] = [];
    const journal = join(await (await this.paths()).work('logs', 'asset-organization'), `${randomBytes(12).toString('hex')}.json`);
    const report: JsonObject = { status: 'running', planHash: plan.planHash!, rows: completed, plannedRows: rows, skipped: plan.skipped!, journal };
    const persist = (): Promise<void> => writeFile(journal, JSON.stringify(report, null, 2));
    await persist();
    for (const row of rows) {
      try {
        const source = String(row.sourceUrl), target = String(row.targetUrl);
        const actual = await this.fingerprint(source);
        if (actual.uuid !== row.uuid || actual.sourceHash !== row.sourceHash || actual.metaHash !== row.metaHash || await this.exists(await this.path(target))) throw new CocosError('STALE_REVISION', 'Asset changed during organization');
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
