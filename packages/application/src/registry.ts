import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CocosError, type BridgeDescriptor } from '../../contracts/src/index.js';
import { ProjectPaths } from './paths.js';

export class ProjectRegistry {
  private readonly projects = new Map<string, ProjectPaths>();

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

  async instances(projectId: string): Promise<BridgeDescriptor[]> {
    const paths = this.paths(projectId);
    const directory = await paths.resolve('.codex-work/cache/cocos-mcp/instances');
    let entries: string[];
    try { entries = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const rows: BridgeDescriptor[] = [];
    for (const entry of entries.filter(name => name.endsWith('.json'))) {
      const path = await paths.resolve(join(directory, entry));
      let descriptor: BridgeDescriptor;
      try { descriptor = JSON.parse(await readFile(path, 'utf8')) as BridgeDescriptor; }
      catch { continue; }
      if (descriptor.protocolVersion !== 1 || descriptor.projectId !== projectId || descriptor.projectPath !== paths.root) continue;
      if (typeof descriptor.token !== 'string' || !/^[a-f\d]{64}$/.test(descriptor.token)) continue;
      if (!Number.isInteger(descriptor.pid) || descriptor.pid <= 0) continue;
      try { process.kill(descriptor.pid, 0); } catch { continue; }
      let url: URL;
      try { url = new URL(descriptor.endpoint); } catch { continue; }
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/rpc') continue;
      if (![2, 3].includes(descriptor.creatorMajor) || typeof descriptor.instanceId !== 'string' || typeof descriptor.editorVersion !== 'string') continue;
      rows.push(descriptor);
    }
    return rows;
  }

  async instance(projectId: string, instanceId?: string): Promise<BridgeDescriptor> {
    const rows = await this.instances(projectId);
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
