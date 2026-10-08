import { readFileSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { ExtensionHealth, type ExtensionHealthState } from '../../packages/native-adapters/src/extension-health.js';

interface VersionManifest { name: string; version: string; buildId?: string }
export interface ExtensionVersionState { version: string; buildId: string; runningBuildId: string; installedVersion: string; installedBuildId: string; integrity: ExtensionHealthState; runtimeHandshake: 'unknown'; reloadRequired: boolean; updating: boolean; message: string | null; latestVersion?: string; checking?: boolean }

/** 更新入口固定为随扩展打包的 GitHub 更新器，不接受面板传入的路径或命令。 */
export class ExtensionUpdate {
  private readonly running: VersionManifest;
  private pending: Promise<void> | undefined;
  private message: string | null = null;
  private latestVersion: string | undefined;
  private checking: Promise<void> | undefined;
  private nextCheck = 0;
  private installedSignature = '';
  private readonly health = new ExtensionHealth();
  private diskStamp = '';
  private integrity: ExtensionHealthState | undefined;
  private currentHealth(): ExtensionHealthState {
    const stamp = this.health.stamp(this.root, this.major);
    // 面板频繁轮询时只复查文件身份和修改时间；发生变化才重新摘要整套运行文件。
    if (stamp !== this.diskStamp || !this.integrity) { this.integrity = this.health.inspect(this.root, this.major); this.diskStamp = stamp; }
    return this.integrity;
  }
  private invoke(command: 'check' | 'install'): Promise<{version: string}> {
    const config = JSON.parse(readFileSync(join(this.root, 'service-config.json'), 'utf8')) as {nodeExecutable?: string};
    if (!config.nodeExecutable) throw new Error('尚未配置 Node.js，请重新安装扩展');
    const work = join(this.project, '.codex-work');
    return new Promise((accept, reject) => execFile(config.nodeExecutable!, [join(this.root, 'dist/update.mjs'), command, this.project, String(this.major)], {
      env: { ...process.env, TMPDIR: join(work, 'tmp'), TMP: join(work, 'tmp'), TEMP: join(work, 'tmp'), NODE_COMPILE_CACHE: join(work, 'cache/node'), XDG_CACHE_HOME: join(work, 'cache') },
      timeout: 120000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error(stderr.trim() || error.message)); return; }
      try { accept(JSON.parse(stdout)); } catch { reject(new Error('更新器返回无效版本信息')); }
    }));
  }
  check(force = false): void {
    if (this.checking || this.pending || (!force && Date.now() < this.nextCheck)) return;
    this.message = null;
    this.latestVersion = undefined;
    this.nextCheck = Date.now() + 5 * 60 * 1000;
    this.checking = Promise.resolve().then(() => this.invoke('check')).then(result => { this.latestVersion = result.version; }).catch(error => { this.message = `检查更新失败：${error instanceof Error ? error.message : String(error)}`; }).finally(() => { this.checking = undefined; });
  }
  constructor(private readonly project: string, private readonly root: string, private readonly major: 2 | 3) {
    this.running = this.manifest(root);
    this.installedSignature = JSON.stringify(this.currentHealth().rows);
  }
  private manifest(root: string): VersionManifest { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as VersionManifest; }
  snapshot(): ExtensionVersionState {
    let installed: VersionManifest;
    try { installed = this.manifest(this.root); }
    catch { installed = { name: this.running.name, version: '', buildId: '' }; }
    const integrity = this.currentHealth();
    return { version: this.running.version, buildId: this.running.buildId ?? '', runningBuildId: this.running.buildId ?? '', installedVersion: installed.version,
      installedBuildId: installed.buildId ?? '', integrity, runtimeHandshake: 'unknown', reloadRequired: installed.version !== this.running.version || installed.buildId !== this.running.buildId || JSON.stringify(integrity.rows) !== this.installedSignature,
      ...(this.latestVersion ? { latestVersion: this.latestVersion } : {}), checking: Boolean(this.checking), updating: Boolean(this.pending), message: this.message };
  }
  update(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.install().catch(error => { this.message = error instanceof Error ? error.message : String(error); throw error; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async install(): Promise<void> {
    await this.checking;
    this.message = '正在从 GitHub 下载并安装最新版本…';
    const result = await this.invoke('install');
    this.latestVersion = result.version;
    this.message = this.snapshot().reloadRequired ? '新版已安装，旧版本已备份；请重载扩展后重新启动 MCP 服务' : '已是 GitHub 最新版本';
  }
}
