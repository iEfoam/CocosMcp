import { readFileSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';

interface VersionManifest { name: string; version: string; buildId?: string }
export interface ExtensionVersionState { version: string; buildId: string; installedVersion: string; installedBuildId: string; reloadRequired: boolean; updating: boolean; message: string | null }

/** 更新仅使用安装器记录的本地构建源，不接受面板传入的路径或命令。 */
export class ExtensionUpdate {
  private readonly running: VersionManifest;
  private pending: Promise<void> | undefined;
  private message: string | null = null;
  constructor(private readonly project: string, private readonly root: string, private readonly major: 2 | 3) {
    this.running = this.manifest(root);
  }
  private manifest(root: string): VersionManifest { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as VersionManifest; }
  snapshot(): ExtensionVersionState {
    const installed = this.manifest(this.root);
    return { version: this.running.version, buildId: this.running.buildId ?? '', installedVersion: installed.version,
      installedBuildId: installed.buildId ?? '', reloadRequired: installed.version !== this.running.version || installed.buildId !== this.running.buildId,
      updating: Boolean(this.pending), message: this.message };
  }
  update(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.install().catch(error => { this.message = error instanceof Error ? error.message : String(error); throw error; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async install(): Promise<void> {
    const config = JSON.parse(readFileSync(join(this.root, 'service-config.json'), 'utf8')) as {nodeExecutable?: string; buildRoot?: string};
    if (!config.nodeExecutable || !config.buildRoot) throw new Error('尚未配置本地更新源，请先使用 CocosMCP 安装器安装新版扩展');
    const source = this.manifest(join(config.buildRoot, `extensions/creator${this.major}`));
    if (source.name !== this.running.name || !source.buildId) throw new Error('更新包身份不匹配或缺少构建标识，请重新构建');
    const installed = this.manifest(this.root);
    if (source.version === installed.version && source.buildId === installed.buildId) { this.message = this.snapshot().reloadRequired ? '新版已安装，请在扩展管理器中重载扩展' : '已是本地构建源中的最新版本'; return; }
    this.message = '正在备份并安装本地构建版本…';
    const work = join(this.project, '.codex-work');
    await new Promise<void>((accept, reject) => {
      execFile(config.nodeExecutable!, [join(config.buildRoot!, 'server/cli.mjs'), 'install', '--project', this.project, '--major', String(this.major)], {
        env: { ...process.env, TMPDIR: join(work, 'tmp'), TMP: join(work, 'tmp'), TEMP: join(work, 'tmp'), NODE_COMPILE_CACHE: join(work, 'cache/node'), XDG_CACHE_HOME: join(work, 'cache') },
        timeout: 120000, maxBuffer: 1024 * 1024,
      }, (error, _stdout, stderr) => error ? reject(new Error(`更新失败：${stderr.trim() || error.message}`)) : accept());
    });
    const after = this.manifest(this.root);
    if (after.version !== source.version || after.buildId !== source.buildId) throw new Error('安装后版本校验失败');
    this.message = '新版已安装，旧版本已备份；请在扩展管理器中重载扩展后重新启动 MCP 服务';
  }
}
