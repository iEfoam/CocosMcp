import { readFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { CocosError, Json } from '../../contracts/src/index.js';
import { ProjectPaths } from './paths.js';

/** 只在获准的父目录内向上定位真实工程；不能靠 assets 目录或已打开窗口猜测目标。 */
export class ProjectLocator {
  constructor(private readonly allowedRoots: string[]) {}
  private contains(root: string, path: string): boolean {
    const suffix = relative(root, path);
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
  }
  async locate(input: string): Promise<ProjectPaths> {
    if (!isAbsolute(input) || input.length > 4096 || input.includes('\0')) throw new CocosError('INVALID_ARGUMENT', 'projectPath must be an absolute directory path');
    let paths = await ProjectPaths.open(input);
    const roots = await Promise.all(this.allowedRoots.map(root => ProjectPaths.open(root)));
    const permitted = roots.filter(root => this.contains(root.root, paths.root)).sort((a, b) => b.root.length - a.root.length)[0];
    if (!permitted) throw new CocosError('PATH_OUTSIDE_PROJECT', 'Project is outside the client allowedRoots');
    for (let depth = 0; depth < 64; depth++) {
      if (await this.creator(paths)) return paths;
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
  private async creator(paths: ProjectPaths): Promise<boolean> {
    const modern = await this.metadata(paths, 'package.json'), creator = modern?.creator;
    const version = creator && typeof creator === 'object' && !Array.isArray(creator) ? creator.version : null;
    const legacy = await this.metadata(paths, 'project.json');
    const matches = (typeof version === 'string' && /^3\.\d+\.\d+(?:[-+].*)?$/.test(version)) ||
      (legacy?.engine === 'cocos-creator-js' && typeof legacy.version === 'string' && /^2\.\d+\.\d+(?:[-+].*)?$/.test(legacy.version));
    if (!matches) return false;
    try { return (await lstat(await paths.resolve('assets'))).isDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
}
