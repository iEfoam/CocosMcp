import { readFile, mkdir, rmdir, writeFile, unlink, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep, join } from 'node:path';
import { CocosError, Json } from '../../contracts/src/index.js';
import { AtomicJson } from '../../application/src/atomic-json.js';
import { ProjectPaths } from '../../application/src/paths.js';
import { ProjectLocator } from '../../application/src/project-locator.js';
import { ExtensionHealth } from './extension-health.js';

export interface ProjectAuthorization {
  projectPath: string; creatorMajor: 2 | 3; manifestSha256: string;
  state: 'authorized' | 'revoked'; updatedAt: string;
}

/** 信任记录放在统一客户端中；工程自己声明安装了插件不能给自己授予访问权限。 */
export class ProjectAuthorizations {
  constructor(private readonly installationRoot: string) {}
  private contains(root: string, path: string): boolean {
    const suffix = relative(root, path);
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
  }
  async rows(): Promise<ProjectAuthorization[]> {
    const installation = await ProjectPaths.open(this.installationRoot), path = await installation.resolve('authorized-projects.json');
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || (info.mode & 0o022) ||
        (process.getuid && info.uid !== process.getuid())) throw new Error('Untrusted authorization file');
      const document = Json.object(Json.value(JSON.parse(await readFile(path, 'utf8'))));
      if (document.schemaVersion !== 1 || Object.keys(document).sort().join('|') !== 'rows|schemaVersion' || !Array.isArray(document.rows) || document.rows.length > 1024) throw new Error('Invalid authorization document');
      const seen = new Set<string>();
      return document.rows.map(value => {
        const row = Json.object(value);
        if (Object.keys(row).sort().join('|') !== 'creatorMajor|manifestSha256|projectPath|state|updatedAt' ||
          typeof row.projectPath !== 'string' || !isAbsolute(row.projectPath) || row.projectPath.length > 4096 || row.projectPath.includes('\0') || seen.has(row.projectPath) ||
          (row.creatorMajor !== 2 && row.creatorMajor !== 3) || typeof row.manifestSha256 !== 'string' || !/^[a-f\d]{64}$/.test(row.manifestSha256) ||
          (row.state !== 'authorized' && row.state !== 'revoked') || typeof row.updatedAt !== 'string' || !row.updatedAt.endsWith('Z') || !Number.isFinite(Date.parse(row.updatedAt))) throw new Error('Invalid project authorization');
        seen.add(row.projectPath);
        return row as unknown as ProjectAuthorization;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new CocosError('VERIFICATION_FAILED', 'Project authorization registry is invalid; inspect it before recovery');
    }
  }
  private async identity(paths: ProjectPaths, major: 2 | 3): Promise<string> {
    if (await new ProjectLocator([paths.root]).major(paths) !== major) throw new CocosError('INVALID_ARGUMENT', 'Authorization requires a matching Creator project with assets');
    const extension = await paths.resolve(`${major === 2 ? 'packages' : 'extensions'}/cocos-mcp-creator${major}`);
    if (new ExtensionHealth().inspect(extension, major).health !== 'healthy') throw new CocosError('VERIFICATION_FAILED', 'Authorization requires a complete verified CocosMCP extension');
    return createHash('sha256').update(await readFile(join(extension, 'package.json'))).digest('hex');
  }
  async state(project: string): Promise<'authorized' | 'revoked' | 'not-authorized'> {
    const paths = await ProjectPaths.open(project), row = (await this.rows()).find(row => row.projectPath === paths.root);
    if (!row) return 'not-authorized';
    if (row.state === 'authorized' && await this.identity(paths, row.creatorMajor) !== row.manifestSha256) throw new CocosError('VERIFICATION_FAILED', 'Installed extension changed; authorize the verified installation again');
    return row.state;
  }
  async locate(input: string, allowedRoots: string[]): Promise<ProjectPaths> {
    if (!isAbsolute(input) || input.length > 4096 || input.includes('\0')) throw new CocosError('INVALID_ARGUMENT', 'projectPath must be an absolute directory path');
    const paths = await ProjectPaths.open(input);
    // 每次连接和派发都读取，新增与撤销授权不依赖重启 stdio；realpath 防止别名越界。
    const row = (await this.rows()).filter(row => this.contains(row.projectPath, paths.root)).sort((a, b) => b.projectPath.length - a.projectPath.length)[0];
    if (row) {
      if (row.state === 'revoked') throw new CocosError('PATH_OUTSIDE_PROJECT', 'This project authorization was revoked');
      const project = await new ProjectLocator([row.projectPath]).locate(input);
      if (project.root !== row.projectPath) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Nested Creator projects require their own installation authorization');
      if (await this.identity(project, row.creatorMajor) !== row.manifestSha256) throw new CocosError('VERIFICATION_FAILED', 'Installed extension changed; authorize the verified installation again');
      return project;
    }
    // 旧版显式目录策略继续兼容；新安装默认空列表，只信任安装器登记的工程。
    if (allowedRoots.length) return new ProjectLocator(allowedRoots).locate(input);
    throw new CocosError('PATH_OUTSIDE_PROJECT', 'Project is not authorized; install the CocosMCP extension or authorize this project in its control center');
  }
  async workspace(input: string, allowedRoots: string[], mappings: Array<{ workspacePath: string; projectPath: string }> = []): Promise<ProjectPaths> {
    if (!isAbsolute(input) || input.length > 4096 || input.includes('\0')) throw new CocosError('INVALID_ARGUMENT', 'workspacePath must be an absolute directory path');
    const workspace = await ProjectPaths.open(input), rows = await this.rows(), locator = new ProjectLocator(allowedRoots);
    // 已撤销或包含嵌套未授权工程时，保留 locate 的拒绝，不能退回父目录候选绕过权限。
    if (rows.some(row => locator.contains(row.projectPath, workspace.root))) return this.locate(workspace.root, allowedRoots);
    const roots = (await Promise.all(allowedRoots.map(root => locator.available(root)))).filter((root): root is ProjectPaths => root !== null);
    const defaults: string[] = [];
    for (const mapping of mappings) {
      const source = await locator.available(mapping.workspacePath);
      if (source?.root !== workspace.root) continue;
      const target = await locator.available(mapping.projectPath);
      if (!target) throw new CocosError('CONTEXT_UNAVAILABLE', 'The selected workspace mapping target no longer exists; inspect this mapping before choosing another project', {
        workspacePath: workspace.root, projectPath: mapping.projectPath });
      defaults.push(target.root);
    }
    if (new Set(defaults).size > 1) throw new CocosError('AMBIGUOUS_TARGET', 'Conflicting realpath workspace mappings', { rows: [...new Set(defaults)].sort().map(projectPath => ({ projectPath })) });
    const candidates = [...rows.filter(row => row.state === 'authorized').map(row => row.projectPath), ...roots.map(root => root.root)];
    const selected = await new ProjectLocator(roots.map(root => root.root)).workspace(workspace.root, candidates, defaults[0]);
    // 默认映射只是选择，不授予权限；候选选定后再次验证当前授权和插件身份。
    return this.locate(selected.root, allowedRoots);
  }
  async grant(project: string, major: 2 | 3): Promise<ProjectAuthorization> {
    const paths = await ProjectPaths.open(project), manifestSha256 = await this.identity(paths, major);
    return this.update(paths.root, previous => previous?.state === 'authorized' && previous.manifestSha256 === manifestSha256 && previous.creatorMajor === major ? previous :
      { projectPath: paths.root, creatorMajor: major, manifestSha256, state: 'authorized', updatedAt: new Date().toISOString() });
  }
  async revoke(project: string): Promise<ProjectAuthorization> {
    const paths = await ProjectPaths.open(project);
    return this.update(paths.root, previous => {
      if (!previous) throw new CocosError('NOT_FOUND', 'This project has no installation authorization');
      return previous.state === 'revoked' ? previous : { ...previous, state: 'revoked', updatedAt: new Date().toISOString() };
    });
  }
  private async update(project: string, change: (previous?: ProjectAuthorization) => ProjectAuthorization): Promise<ProjectAuthorization> {
    const installation = await ProjectPaths.open(this.installationRoot), lock = await installation.resolve('.project-authorization-lock');
    let locked = false;
    // 多个安装/编辑器进程可能同时登记；锁住读改写，避免后写者覆盖另一个工程。
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await mkdir(lock, { mode: 0o700 }); locked = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    if (!locked) throw new CocosError('RESOURCE_BUSY', 'Project authorization is busy; inspect the authorization lock before recovery');
    const owner = join(lock, 'owner.json');
    try {
      await writeFile(owner, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      const rows = await this.rows(), previous = rows.find(row => row.projectPath === project), next = change(previous);
      if (next !== previous) {
        if (!previous && rows.length >= 1024) throw new CocosError('RESOURCE_BUSY', 'Project authorization registry is full');
        const updated = [...rows.filter(row => row.projectPath !== project), next].sort((a, b) => a.projectPath.localeCompare(b.projectPath));
        await new AtomicJson().write(await installation.resolve('authorized-projects.json'), Json.value({ schemaVersion: 1, rows: updated }));
      }
      return next;
    } finally {
      await unlink(owner).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      await rmdir(lock);
    }
  }
}
