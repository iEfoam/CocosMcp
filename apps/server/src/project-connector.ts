import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { open, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import type { ClientPolicy } from '../../../packages/application/src/client-policy.js';
import { ProjectLocator } from '../../../packages/application/src/project-locator.js';
import { ProjectRegistry } from '../../../packages/application/src/registry.js';
import { ServiceConnections, type ServiceDescriptor } from '../../../packages/application/src/service-connections.js';
import type { ProjectPaths } from '../../../packages/application/src/paths.js';

export interface ProjectBinding {
  projectId: string; paths: ProjectPaths; descriptor: ServiceDescriptor; client: Client; connections: ServiceConnections;
  clientId: string; leaseToken?: string; token: string; heartbeat?: NodeJS.Timeout; failed?: string; inFlight: number;
}

/** 连接表属于一个 stdio 进程；目标永远由 projectId 指定，不维护全局当前工程。 */
export class ProjectConnector {
  private readonly bindings = new Map<string, ProjectBinding>();
  private readonly connecting = new Map<string, Promise<ProjectBinding>>();
  private closing = false;
  constructor(readonly projects: ProjectRegistry, readonly policy: ClientPolicy, private readonly installation: string, private readonly workerFile: string) {}
  get(projectId: string): ProjectBinding {
    const row = this.bindings.get(projectId);
    if (!row) throw new CocosError('NOT_FOUND', 'Project is not connected; call cocos_project_connect with its workspace path');
    if (row.failed) throw new CocosError('CONTEXT_UNAVAILABLE', row.failed);
    return row;
  }
  list(): JsonValue { return { rows: [...this.bindings.values()].map(row => this.summary(row)) }; }
  private summary(row: ProjectBinding): JsonObject {
    return { projectId: row.projectId, projectPath: row.paths.root, serviceId: row.descriptor.serviceId, owner: row.descriptor.owner,
      backendMode: row.descriptor.mode ?? 'external', state: row.failed ? 'disconnected' : 'connected', apiVersion: row.descriptor.apiVersion ?? null, inFlight: row.inFlight };
  }
  async status(projectId?: string): Promise<JsonValue> {
    const rows = projectId ? [this.bindings.get(projectId)].filter((row): row is ProjectBinding => Boolean(row)) : [...this.bindings.values()];
    if (projectId && !rows.length) throw new CocosError('NOT_FOUND', 'Project is not connected');
    return { rows: await Promise.all(rows.map(async row => {
      try {
        const current = await row.connections.active();
        if (!current || current.serviceId !== row.descriptor.serviceId) return { ...this.summary(row), state: 'disconnected', editorState: 'unavailable' };
        const instances = await this.projects.instances(row.projectId);
        const lifecycle = current.mode === 'shared' ? await row.connections.clientStatus(current) : null;
        return { ...this.summary(row), ...(lifecycle ? { backendClients: lifecycle.clients!, backendRequests: lifecycle.requests! } : {}), editorState: instances.length === 1 ? 'ready' : instances.length ? 'ambiguous' : 'offline',
          rows: instances.map(({ token: _token, ...instance }) => Json.value(instance)) };
      } catch { return { ...this.summary(row), state: 'unavailable', editorState: 'unavailable' }; }
    })) };
  }
  async connect(input: string, instanceId?: string): Promise<JsonValue> {
    if (this.closing) throw new CocosError('RESOURCE_BUSY', 'Unified client is closing');
    const paths = await new ProjectLocator(this.policy.allowedRoots).locate(input), connections = new ServiceConnections(paths);
    let task = this.connecting.get(connections.projectId);
    if (!task) { task = this.attach(paths, connections); this.connecting.set(connections.projectId, task); }
    let row: ProjectBinding;
    try { row = await task; } finally { if (this.connecting.get(connections.projectId) === task) this.connecting.delete(connections.projectId); }
    const instances = await this.projects.instances(row.projectId);
    if (instanceId && !instances.some(instance => instance.instanceId === instanceId)) throw new CocosError('CONTEXT_UNAVAILABLE', 'Requested editor instance does not belong to this connected project');
    return { project: { projectId: row.projectId, projectPath: paths.root }, connection: {
      backendState: 'ready', editorState: instanceId || instances.length === 1 ? 'ready' : instances.length ? 'ambiguous' : 'offline',
      backendMode: row.descriptor.mode ?? 'external', serviceId: row.descriptor.serviceId, apiVersion: row.descriptor.apiVersion ?? null,
      ...(instanceId ? { instanceId } : {}) }, rows: instances.map(({ token: _token, ...instance }) => Json.value(instance)) };
  }
  private async attach(paths: ProjectPaths, connections: ServiceConnections): Promise<ProjectBinding> {
    const existing = this.bindings.get(connections.projectId);
    if (existing) {
      const active = await connections.active();
      if (!existing.failed && active?.serviceId === existing.descriptor.serviceId) return existing;
      if (existing.inFlight) throw new CocosError('RESOURCE_BUSY', 'Project still has pending calls; query their original operations before reconnecting');
      await this.detach(existing); this.bindings.delete(existing.projectId); this.projects.remove(existing.projectId);
    }
    const deadline = performance.now() + 15_000;
    let started = false, childFailure: string | undefined;
    while (performance.now() < deadline) {
      if (this.closing) throw new CocosError('CANCELLED', 'Unified client is closing');
      let active: ServiceDescriptor | null | undefined;
      try { active = await connections.active(); }
      catch (error) { if (CocosError.from(error).code !== 'RESOURCE_BUSY') throw error; }
      if (active?.transport === 'stdio') throw new CocosError('RESOURCE_BUSY', 'This project is owned by a legacy stdio service; stop that connection explicitly before using the unified client');
      if (active?.status === 'running' && active.endpoint) {
        try { return await this.bind(paths, connections, active, Math.max(1, deadline - performance.now())); }
        catch (error) { if (CocosError.from(error).code !== 'RESOURCE_BUSY') throw error; }
      }
      if (active === null && !started) {
        if (!this.policy.autoStartBackend) throw new CocosError('CONTEXT_UNAVAILABLE', 'No backend is running and autoStartBackend is disabled');
        started = true;
        await this.launch(paths, error => { childFailure = error; });
      }
      // RESOURCE_BUSY 的启动竞争不是失败；只在已证明没有活动服务时启动，不接管存活但无法认证的进程。
      if (childFailure && active === null) throw new CocosError('INTERNAL_ERROR', childFailure);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new CocosError('RESOURCE_BUSY', 'Project backend did not become ready within 15 seconds; inspect its project logs and existing owner');
  }
  private async launch(paths: ProjectPaths, failed: (message: string) => void): Promise<void> {
    const info = await lstat(this.workerFile);
    if (!info.isFile() || info.isSymbolicLink()) throw new CocosError('VERIFICATION_FAILED', 'Shared worker bundle is unavailable');
    for (const directory of ['tmp', 'cache', 'logs'] as const) await paths.work(directory);
    const logPath = await paths.resolve('.codex-work/logs/cocos-shared-worker.log');
    try { const info = await lstat(logPath); if (!info.isFile() || info.isSymbolicLink()) throw new CocosError('VERIFICATION_FAILED', 'Worker log must be a regular file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const log = await open(logPath, 'a', 0o600);
    try {
      const child = spawn(process.execPath, [this.workerFile, '--project', paths.root, '--installation', this.installation],
        { cwd: paths.root, env: paths.environment(), shell: false, detached: true, stdio: ['ignore', log.fd, log.fd] });
      child.once('error', () => failed('Failed to launch shared worker; inspect the installed Node executable and worker bundle'));
      // 启动竞争的失败子进程可能返回非零；由身份发现确认胜出服务，不能杀死另一个客户端的进程。
      child.unref();
    } finally { await log.close(); }
  }
  private async bind(paths: ProjectPaths, connections: ServiceConnections, descriptor: ServiceDescriptor, timeout: number): Promise<ProjectBinding> {
    const token = await connections.token(descriptor.tokenFile, false), clientId = randomUUID();
    const row: ProjectBinding = { projectId: connections.projectId, paths, descriptor, connections, token, clientId, inFlight: 0, client: new Client({ name: 'cocos-unified-client', version: '1' }) };
    try {
      let heartbeatMs = this.policy.clientHeartbeatSeconds * 1000;
      if (descriptor.mode === 'shared') {
        const registered = Json.object(await this.control(row, '/register', { clientId }));
        row.leaseToken = Json.string(registered.leaseToken, 'leaseToken');
        if (!/^[a-f\d]{64}$/.test(row.leaseToken) || typeof registered.leaseTtlMs !== 'number' || registered.leaseTtlMs < 3000 || registered.leaseTtlMs > 600000) throw new CocosError('VERIFICATION_FAILED', 'Invalid client lease response');
        heartbeatMs = Math.min(heartbeatMs, Math.floor(registered.leaseTtlMs / 3));
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (row.leaseToken) { headers['X-Cocos-Client-Id'] = clientId; headers['X-Cocos-Lease-Token'] = row.leaseToken; }
      await row.client.connect(new StreamableHTTPClientTransport(new URL(descriptor.endpoint!), { requestInit: { headers, redirect: 'error' }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 } }), { timeout, signal: AbortSignal.timeout(Math.ceil(timeout)) });
      // HTTP 初始化结果必须是目标工程的服务，不能仅因端口可访问就建立绑定。
      const result = await row.client.callTool({ name: 'cocos_projects', arguments: {} }, { timeout: Math.min(timeout, 5000) });
      const projects = Json.object(Json.value(result.structuredContent));
      if (result.isError || !Array.isArray(projects.rows) || !projects.rows.some(value => {
        const project = Json.object(value); return project.projectId === row.projectId && project.projectPath === paths.root;
      })) throw new CocosError('VERIFICATION_FAILED', 'Backend MCP response does not contain the authenticated project');
      if (this.closing) throw new CocosError('CANCELLED', 'Unified client is closing');
      await this.projects.add(paths.root); this.bindings.set(row.projectId, row);
      if (row.leaseToken) {
        let renewing = false;
        row.heartbeat = setInterval(() => {
          if (renewing) return; renewing = true;
          void this.control(row, '/heartbeat', { clientId, leaseToken: row.leaseToken! }).catch(() => {
            row.failed = 'Backend lease is unavailable; call cocos_project_connect to restore the connection'; clearInterval(row.heartbeat);
          }).finally(() => { renewing = false; });
        }, heartbeatMs);
        row.heartbeat.unref();
      }
      return row;
    } catch (error) { await this.detach(row); throw error; }
  }
  private async control(row: ProjectBinding, route: string, body: JsonObject): Promise<JsonValue> {
    const response = await fetch(row.descriptor.clientControlEndpoint! + route, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${row.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    const length = response.headers.get('content-length'); if (length && Number(length) > 16 * 1024) throw new CocosError('VERIFICATION_FAILED', 'Client control response is too large');
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
    if (!reader) throw new CocosError('VERIFICATION_FAILED', 'Missing client control response');
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 16 * 1024) throw new CocosError('VERIFICATION_FAILED', 'Client control response is too large'); chunks.push(chunk.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const value = Json.value(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!response.ok) throw new CocosError(response.status === 401 ? 'UNAUTHORIZED' : 'RESOURCE_BUSY', 'Backend client lease request failed');
    return value;
  }
  async disconnect(projectId: string): Promise<JsonValue> {
    if (this.connecting.has(projectId)) throw new CocosError('RESOURCE_BUSY', 'Project connection is still starting');
    const row = this.bindings.get(projectId);
    if (!row) return { projectId, disconnected: true };
    if (row.inFlight) throw new CocosError('RESOURCE_BUSY', 'Project has pending calls; wait for their results before disconnecting');
    await this.detach(row); this.bindings.delete(projectId); this.projects.remove(projectId);
    return { projectId, disconnected: true };
  }
  private async detach(row: ProjectBinding): Promise<void> {
    clearInterval(row.heartbeat);
    await row.client.close().catch(() => {});
    if (row.leaseToken) {
      try { if ((await row.connections.active())?.serviceId === row.descriptor.serviceId) await this.control(row, '/release', { clientId: row.clientId, leaseToken: row.leaseToken }); }
      catch { /* 无法认证的后端不能接管；原租约通过 TTL 过期。 */ }
    }
  }
  async close(): Promise<void> {
    this.closing = true; await Promise.allSettled(this.connecting.values());
    await Promise.allSettled([...this.bindings.values()].map(row => this.detach(row))); this.bindings.clear();
  }
}
