import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { ProjectPaths } from './paths.js';

export interface ClientPolicy {
  schemaVersion: 1; allowedRoots: string[]; autoStartBackend: boolean; allowProjectCode: boolean;
  clientHeartbeatSeconds: number; clientLeaseTtlSeconds: number; idleExitSeconds: number;
  workspaceMappings?: Array<{ workspacePath: string; projectPath: string }>;
}

export class ClientPolicies {
  parse(value: unknown): ClientPolicy {
    const row = Json.object(Json.value(value));
    const known = new Set(['schemaVersion', 'allowedRoots', 'autoStartBackend', 'allowProjectCode', 'clientHeartbeatSeconds', 'clientLeaseTtlSeconds', 'idleExitSeconds', 'workspaceMappings']);
    if (Object.keys(row).some(key => !known.has(key)) || row.schemaVersion !== 1 || !Array.isArray(row.allowedRoots) || row.allowedRoots.length > 64 ||
      row.allowedRoots.some(root => typeof root !== 'string' || !isAbsolute(root) || root.length > 4096 || root.includes('\0'))) throw new CocosError('INVALID_ARGUMENT', 'Invalid client policy / allowedRoots');
    for (const key of ['autoStartBackend', 'allowProjectCode']) if (typeof row[key] !== 'boolean') throw new CocosError('INVALID_ARGUMENT', `Policy ${key} must be boolean`);
    const heartbeat = this.seconds(row, 'clientHeartbeatSeconds', 1, 60), ttl = this.seconds(row, 'clientLeaseTtlSeconds', 3, 600), idle = this.seconds(row, 'idleExitSeconds', 1, 3600);
    if (ttl < heartbeat * 3) throw new CocosError('INVALID_ARGUMENT', 'Client TTL must allow at least three heartbeats');
    const mappings = row.workspaceMappings;
    if (mappings !== undefined && (!Array.isArray(mappings) || mappings.length > 64 || mappings.some(value => {
      const mapping = Json.object(value);
      return Object.keys(mapping).sort().join('|') !== 'projectPath|workspacePath' || ['workspacePath', 'projectPath'].some(key =>
        typeof mapping[key] !== 'string' || !isAbsolute(mapping[key]) || mapping[key].length > 4096 || mapping[key].includes('\0'));
    }))) throw new CocosError('INVALID_ARGUMENT', 'Invalid workspaceMappings');
    return { schemaVersion: 1, allowedRoots: row.allowedRoots as string[], autoStartBackend: row.autoStartBackend as boolean, allowProjectCode: row.allowProjectCode as boolean,
      clientHeartbeatSeconds: heartbeat, clientLeaseTtlSeconds: ttl, idleExitSeconds: idle,
      ...(mappings !== undefined ? { workspaceMappings: mappings as NonNullable<ClientPolicy['workspaceMappings']> } : {}) };
  }
  private seconds(row: JsonObject, key: string, minimum: number, maximum: number): number {
    const value = row[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw new CocosError('INVALID_ARGUMENT', `Invalid policy ${key}`);
    return value;
  }
  async load(installation: ProjectPaths): Promise<ClientPolicy> {
    const path = await installation.resolve('policy.json'), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new CocosError('VERIFICATION_FAILED', 'Invalid client policy file');
    return this.parse(JSON.parse(await readFile(path, 'utf8')));
  }
}
