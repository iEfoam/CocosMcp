import { mkdir, readFile, cp, rename, stat, lstat, writeFile } from 'node:fs/promises';
import { join, isAbsolute, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CocosError } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import { ExtensionHealth } from './extension-health.js';
import { ClientPackage, ClientInstallation } from './client-installation.js';
import { ProjectLocator } from '../../application/src/project-locator.js';
import { ProjectAuthorizations } from './project-authorization.js';

export interface InstallationAuthorization { state: 'authorized' | 'pending'; message: string | null }

export class ExtensionInstaller {
  async authorizeInstalled(project: string, major: 2 | 3, clientInstallation?: string): Promise<InstallationAuthorization> {
    const paths = await ProjectPaths.open(project), actual = await new ProjectLocator([paths.root]).major(paths);
    // 单工程 stdio 和旧版安装入口继续可用，只有真实 Creator 工程才登记统一客户端授权。
    if (!actual) return { state: 'pending', message: 'No Creator project metadata; unified authorization was not granted' };
    if (actual !== major) throw new CocosError('INVALID_ARGUMENT', 'Creator project and extension major version do not match');
    if (!clientInstallation) {
      try {
        const config = JSON.parse(await readFile(await paths.resolve(`${major === 2 ? 'packages' : 'extensions'}/cocos-mcp-creator${major}/service-config.json`), 'utf8')) as { clientInstallation?: string };
        clientInstallation = config.clientInstallation;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!clientInstallation) throw new CocosError('VERIFICATION_FAILED', '统一客户端未配置，工程授权未完成，请使用完整本地构建安装');
    if (!isAbsolute(clientInstallation)) throw new CocosError('INVALID_ARGUMENT', 'clientInstallation must be an absolute path');
    await new ClientPackage().installed(clientInstallation);
    await new ProjectAuthorizations(clientInstallation).grant(paths.root, major);
    return { state: 'authorized', message: null };
  }
  async install(project: string, major: 2 | 3, buildRoot: string): Promise<{ installedPath: string; backupPath: string | null; authorization: InstallationAuthorization }> {
    const paths = await ProjectPaths.open(project);
    const source = join(buildRoot, `extensions/creator${major}`);
    new ExtensionHealth().require(source, major);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { name: string };
    const parent = await paths.resolve(major === 2 ? 'packages' : 'extensions');
    const target = await paths.resolve(join(parent, manifest.name));
    await mkdir(parent, { recursive: true });
    let config: { clientInstallation?: string } = {};
    // 离线/在线发行包不包含本机配置，升级先保留目标工程已有的客户端位置。
    for (const directory of [target, source]) {
      try { config = JSON.parse(await readFile(directory === target ? await paths.resolve(join(target, 'service-config.json')) : join(source, 'service-config.json'), 'utf8')) as typeof config; if (config.clientInstallation) break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const actual = await new ProjectLocator([paths.root]).major(paths);
    if (actual && actual !== major) throw new CocosError('INVALID_ARGUMENT', 'Creator project and extension major version do not match');
    if (actual) config.clientInstallation = await this.prepareClient(paths, buildRoot, config.clientInstallation);
    // 客户端准备完成后才复制候选；禁止把缺少客户端的半安装当作成功。
    const staging = join(await paths.work('tmp', `extension-install-${randomUUID()}`), manifest.name);
    await cp(source, staging, { recursive: true, force: false, errorOnExist: true });
    new ExtensionHealth().require(staging, major);
    await writeFile(join(staging, 'service-config.json'), JSON.stringify({ nodeExecutable: process.execPath, buildRoot, clientInstallation: config.clientInstallation }), { mode: 0o600 });
    const ignore = await paths.resolve('.gitignore');
    const content = await readFile(ignore, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });
    if (!content.split(/\r?\n/).some(line => ['.codex-work/', '/.codex-work/'].includes(line.trim()))) {
      await writeFile(ignore, content + (content && !content.endsWith('\n') ? '\n' : '') + '.codex-work/\n');
    }
    let backupPath: string | null = null;
    if (await stat(target).then(() => true, () => false)) {
      const previous = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as { name?: string };
      if (previous.name !== manifest.name) throw new CocosError('OPERATION_CONFLICT', 'Existing extension has a different identity');
      const directory = await paths.resolve('.codex-work/backups/extension-installations');
      await mkdir(directory, { recursive: true });
      backupPath = join(directory, `${manifest.name}-${randomUUID()}`); await rename(target, backupPath);
    }
    let published = false;
    try {
      await rename(staging, target); published = true;
      const authorization = await this.authorizeInstalled(paths.root, major, config.clientInstallation);
      return { installedPath: target, backupPath, authorization };
    } catch (error) {
      // 授权登记失败不能把“安装成功”交给用户；新候选保留诊断，恢复原插件。
      if (published) await rename(target, staging);
      if (backupPath) await rename(backupPath, target);
      throw error;
    }
  }

  private async prepareClient(project: ProjectPaths, buildRoot: string, configured?: string): Promise<string> {
    // 本地标准构建共用仓库的客户端；离线构建只能在目标工程内引导，不能按任意下载路径推导外部写入位置。
    const localBuild = basename(buildRoot) === 'build' && basename(dirname(buildRoot)) === '.codex-work';
    const workspace = localBuild ? dirname(dirname(buildRoot)) : project.root;
    const root = configured ?? join(workspace, '.codex-work/artifacts/cocos-client');
    if (!isAbsolute(root)) throw new CocosError('INVALID_ARGUMENT', 'clientInstallation must be an absolute path');
    try { await new ClientPackage().installed(root); return root; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await lstat(root); throw new CocosError('VERIFICATION_FAILED', '统一客户端安装不完整，请先修复已有安装'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // 已配置但损坏的客户端不能被静默覆盖；仅允许在可验证的默认位置首次安装。
    if (root !== join(workspace, '.codex-work/artifacts/cocos-client')) throw new CocosError('VERIFICATION_FAILED', '配置的统一客户端不存在，请修复 clientInstallation');
    try { await new ClientPackage().verify(join(buildRoot, 'client')); }
    catch (error) { throw new CocosError('VERIFICATION_FAILED', '统一客户端不可用，安装包须包含 client 构建；插件未替换', { reason: error instanceof Error ? error.message : String(error) }); }
    await new ClientInstallation().install(workspace, join(buildRoot, 'client'), []);
    await new ClientPackage().installed(root);
    return root;
  }
}
