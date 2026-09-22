import { mkdir, readFile, cp, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CocosError } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';

export class ExtensionInstaller {
  async install(project: string, major: 2 | 3, buildRoot: string): Promise<{ installedPath: string; backupPath: string | null }> {
    const paths = await ProjectPaths.open(project);
    const source = join(buildRoot, `extensions/creator${major}`);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { name: string };
    const parent = await paths.resolve(major === 2 ? 'packages' : 'extensions');
    const target = await paths.resolve(join(parent, manifest.name));
    await mkdir(parent, { recursive: true });
    // 只创建临时目录父级，staging 目标必须保持不存在才能让 cp 的 errorOnExist 真正防止覆盖。
    const staging = join(await paths.work('tmp'), `extension-${randomUUID()}`);
    await cp(source, staging, { recursive: true, force: false, errorOnExist: true });
    await writeFile(join(staging, 'service-config.json'), JSON.stringify({ nodeExecutable: process.execPath, buildRoot }), { mode: 0o600 });
    let backupPath: string | null = null;
    if (await stat(target).then(() => true, () => false)) {
      const previous = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as { name?: string };
      if (previous.name !== manifest.name) throw new CocosError('OPERATION_CONFLICT', 'Existing extension has a different identity');
      const directory = await paths.work('build', 'extension-backups');
      backupPath = join(directory, `${manifest.name}-${randomUUID()}`); await rename(target, backupPath);
    }
    try { await rename(staging, target); }
    catch (error) { if (backupPath) await rename(backupPath, target); throw error; }
    const ignore = await paths.resolve('.gitignore');
    const content = await readFile(ignore, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });
    if (!content.split(/\r?\n/).some(line => ['.codex-work/', '/.codex-work/'].includes(line.trim()))) {
      await writeFile(ignore, content + (content && !content.endsWith('\n') ? '\n' : '') + '.codex-work/\n');
    }
    return { installedPath: target, backupPath };
  }
}
