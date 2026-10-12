import { readFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { CocosError, Json } from '../../contracts/src/index.js';
import { ProjectPaths } from './paths.js';

/** 只在获准的父目录内向上定位真实工程；不能靠 assets 目录或已打开窗口猜测目标。 */
export class ProjectLocator {
  constructor(private readonly allowedRoots: string[]) {}
  contains(root: string, path: string): boolean {
    const suffix = relative(root, path);
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
  }
  async available(input: string): Promise<ProjectPaths | null> {
    try { return await ProjectPaths.open(input); }
    catch (error) {
      // 历史白名单和候选可能已删除；仅忽略不存在的目录，权限错误或身份漂移不能掩盖。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  /** 父工作区只检查调用方提供的授权根，不递归扫描磁盘；名称和 project.json id 不参与选择。 */
  async workspace(input: string, candidates: string[], preferred?: string): Promise<ProjectPaths> {
    if (!isAbsolute(input) || input.length > 4096 || input.includes('\0')) throw new CocosError('INVALID_ARGUMENT', 'workspacePath must be an absolute directory path');
    const workspace = await ProjectPaths.open(input);
    // 工程内工作区优先最近工程，即使父工作区另有默认映射，也不能把子工程派发到兄弟工程。
    if (candidates.some(root => this.contains(root, workspace.root))) {
      try { return await this.locate(workspace.root); }
      catch (error) { if (CocosError.from(error).code !== 'INVALID_ARGUMENT') throw error; }
    }
    const rows: ProjectPaths[] = [];
    for (const root of [...new Set(candidates)].sort()) {
      if (!this.contains(workspace.root, root)) continue;
      const paths = await this.available(root);
      if (!paths) continue;
      if (paths.root !== root) throw new CocosError('VERIFICATION_FAILED', 'An authorized project path changed its realpath');
      if (await this.major(paths)) rows.push(paths);
    }
    if (preferred) {
      const target = (await ProjectPaths.open(preferred)).root, match = rows.find(row => row.root === target);
      if (!match) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Workspace mapping must select an authorized project inside this workspace');
      return match;
    }
    if (!rows.length) throw new CocosError('PATH_OUTSIDE_PROJECT', 'No authorized Creator project matches workspacePath; provide an authorized projectPath');
    if (rows.length > 1) throw new CocosError('AMBIGUOUS_TARGET', 'Multiple authorized projects match workspacePath; select projectPath explicitly or configure a workspace mapping', {
      workspacePath: workspace.root, rows: rows.map(row => ({ projectPath: row.root })) });
    return rows[0]!;
  }
  async locate(input: string): Promise<ProjectPaths> {
    if (!isAbsolute(input) || input.length > 4096 || input.includes('\0')) throw new CocosError('INVALID_ARGUMENT', 'projectPath must be an absolute directory path');
    let paths = await ProjectPaths.open(input);
    const roots = (await Promise.all(this.allowedRoots.map(root => this.available(root)))).filter((root): root is ProjectPaths => root !== null);
    const permitted = roots.filter(root => this.contains(root.root, paths.root)).sort((a, b) => b.root.length - a.root.length)[0];
    if (!permitted) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Project is outside the client allowedRoots');
    for (let depth = 0; depth < 64; depth++) {
      if (await this.major(paths)) return paths;
      const parent = dirname(paths.root);
      if (parent === paths.root || !this.contains(permitted.root, parent)) break;
      paths = await ProjectPaths.open(parent);
    }
    throw new CocosError('INVALID_ARGUMENT', 'No Creator 2/3 project metadata found within allowedRoots');
  }
  private async metadata(paths: ProjectPaths, name: string): Promise<ReturnType<typeof Json.object> | null> {
    try {
      const path = await paths.resolve(name), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new CocosError('VERIFICATION_FAILED', 'Invalid Creator project metadata');
      return Json.object(Json.value(JSON.parse(await readFile(path, 'utf8'))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async major(paths: ProjectPaths): Promise<2 | 3 | null> {
    const modern = await this.metadata(paths, 'package.json'), creator = modern?.creator;
    const version = creator && typeof creator === 'object' && !Array.isArray(creator) ? creator.version : null;
    const legacy = await this.metadata(paths, 'project.json');
    const major = typeof version === 'string' && /^3\.\d+\.\d+(?:[-+].*)?$/.test(version) ? 3 :
      legacy?.engine === 'cocos-creator-js' && typeof legacy.version === 'string' && /^2\.\d+\.\d+(?:[-+].*)?$/.test(legacy.version) ? 2 : null;
    if (!major) return null;
    try { return (await lstat(await paths.resolve('assets'))).isDirectory() ? major : null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
}
