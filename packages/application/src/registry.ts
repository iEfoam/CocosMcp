import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CocosError, type BridgeDescriptor } from '../../contracts/src/index.js';
import { ProjectPaths } from './paths.js';
import { BridgeClient } from './bridge-client.js';

export class ProjectRegistry {
  private readonly projects = new Map<string, ProjectPaths>();
  private readonly discovering = new Map<string, Promise<BridgeDescriptor[]>>();
  constructor(private readonly bridge = new BridgeClient()) {}

  async add(root: string): Promise<{ projectId: string; projectPath: string }> {
    const paths = await ProjectPaths.open(root);
    const projectId = createHash('sha256').update(paths.root).digest('hex').slice(0, 24);
    this.projects.set(projectId, paths);
    return { projectId, projectPath: paths.root };
  }

  paths(projectId: string): ProjectPaths {
    const paths = this.projects.get(projectId);
    if (!paths) throw new CocosError('NOT_FOUND', 'Project is not registered. Start the server with --project <path>.');
    return paths;
  }

  list(): { rows: Array<{ projectId: string; projectPath: string }> } {
    return { rows: [...this.projects].map(([projectId, paths]) => ({ projectId, projectPath: paths.root })) };
  }

  remove(projectId: string): void { this.projects.delete(projectId); }

  async instances(projectId: string, instanceId?: string): Promise<BridgeDescriptor[]> {
    this.paths(projectId);
    const key = JSON.stringify([projectId, instanceId ?? null]);
    let task = this.discovering.get(key);
    if (!task) { task = this.discover(projectId, instanceId); this.discovering.set(key, task); }
    // 仅合并仍在进行的认证，不缓存终态；后续写调用仍重新核验实例身份。
    try { return (await task).map(row => ({ ...row })); }
    finally { if (this.discovering.get(key) === task) this.discovering.delete(key); }
  }

  private async discover(projectId: string, instanceId?: string): Promise<BridgeDescriptor[]> {
    const paths = this.paths(projectId);
    const directory = await paths.resolve('.codex-work/cache/cocos-mcp/instances');
    let entries: string[];
    // 第一方桥接始终按 instanceId.json 写描述符；显式目标不需要枚举和读取无关候选。
    // 名称只负责定位，下面仍核验描述符内部身份、工程、PID、端点和实时认证。
    if (instanceId !== undefined) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(instanceId)) throw new CocosError('INVALID_ARGUMENT', 'Invalid editor instance identity');
      entries = [instanceId + '.json'];
    } else {
      try { entries = await readdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    }
    if (entries.length > 2000) throw new CocosError('RESOURCE_BUSY', 'Editor instance directory exceeds discovery limit');
    const rows: BridgeDescriptor[] = [];
    for (const entry of entries.filter(name => name.endsWith('.json'))) {
      const path = await paths.resolve(join(directory, entry));
      let descriptor: BridgeDescriptor;
      try { const info = await stat(path); if (!info.isFile() || info.size > 1024 * 1024) continue; descriptor = JSON.parse(await readFile(path, 'utf8')) as BridgeDescriptor; }
      catch { continue; }
      if (descriptor.protocolVersion !== 1 || descriptor.projectId !== projectId || descriptor.projectPath !== paths.root) continue;
      if (instanceId !== undefined && descriptor.instanceId !== instanceId) continue;
      if (typeof descriptor.token !== 'string' || !/^[a-f\d]{64}$/.test(descriptor.token)) continue;
      if (!Number.isInteger(descriptor.pid) || descriptor.pid <= 0) continue;
      try { process.kill(descriptor.pid, 0); } catch { continue; }
      let url: URL;
      try { url = new URL(descriptor.endpoint); } catch { continue; }
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/rpc') continue;
      if (![2, 3].includes(descriptor.creatorMajor) || typeof descriptor.instanceId !== 'string' || typeof descriptor.editorVersion !== 'string') continue;
      rows.push(descriptor);
    }
    // PID 存活不能证明原编辑器仍在：系统会复用 PID。保持真实多实例冲突，只排除认证探测失联的历史描述符。
    const active: BridgeDescriptor[] = [];
    for (let offset = 0; offset < rows.length; offset += 4) {
      const batch = rows.slice(offset, offset + 4), results = await Promise.all(batch.map(row => this.bridge.identity(row)));
      batch.forEach((row, index) => { if (results[index]) active.push(row); });
    }
    if (this.paths(projectId) !== paths) throw new CocosError('CONTEXT_UNAVAILABLE', 'Project registration changed during discovery');
    return active;
  }

  async instance(projectId: string, instanceId?: string): Promise<BridgeDescriptor> {
    const rows = await this.instances(projectId, instanceId);
    if (instanceId) {
      const match = rows.find(row => row.instanceId === instanceId);
      if (!match) throw new CocosError('CONTEXT_UNAVAILABLE', 'The editor instance is not connected');
      return match;
    }
    if (!rows.length) throw new CocosError('CONTEXT_UNAVAILABLE', 'Open the project in Creator and enable the CocosMCP extension');
    if (rows.length > 1) throw new CocosError('AMBIGUOUS_TARGET', 'Multiple editor instances are open; specify instanceId');
    return rows[0]!;
  }
}
