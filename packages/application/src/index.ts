import { randomUUID } from 'node:crypto';
import { FeatureSupport } from '../../runtime3-bridge/src/feature-support.js';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CocosError, Json, type ExecutionRequest, type ExecutionResult, type JsonValue } from '../../contracts/src/index.js';
import { CapabilityCatalog } from '../../capability-catalog/src/index.js';
import { BridgeClient } from './bridge-client.js';
import { ProjectRegistry } from './registry.js';
import { ProjectQueue } from './queue.js';

export interface RuntimeExecutor { execute(projectId: string, runtimeInstanceId: string | undefined, capabilityId: string, params: import('../../contracts/src/index.js').JsonObject, signal?: AbortSignal): Promise<JsonValue> }
export interface WorkflowStep { capabilityId: string; params: import('../../contracts/src/index.js').JsonObject; instanceId?: string; runtimeInstanceId?: string; operationId?: string; expectedRevision?: string }

export class CocosApplication {
  private readonly queue = new ProjectQueue();
  private readonly outcomes = new Map<string, ExecutionResult>();
  private readonly inFlight = new Map<string, Promise<ExecutionResult>>();
  private readonly operationInputs = new Map<string, string>();
  private remember(key: string, result: ExecutionResult): void {
    this.outcomes.set(key, result);
    while (this.outcomes.size > 2048) {
      const oldest = this.outcomes.keys().next().value!;
      this.outcomes.delete(oldest); this.operationInputs.delete(oldest);
    }
  }
  private async persistWorkflow(projectId: string, workflowId: string, state: JsonValue): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workflowId)) throw new CocosError('INVALID_ARGUMENT', 'Invalid workflowId');
    const path = await this.projects.paths(projectId).work('cache', 'cocos-mcp/workflows');
    await writeFile(join(path, `${workflowId}.json`), JSON.stringify(state, null, 2), { mode: 0o600 });
  }
  constructor(readonly projects: ProjectRegistry, readonly catalog = new CapabilityCatalog(), private readonly bridge = new BridgeClient(),
    private readonly allowExternal = false, private readonly runtime?: RuntimeExecutor) {}

  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const capability = this.catalog.validate(request.capabilityId, request.params);
    if (capability.effect === 'external' && !this.allowExternal) throw new CocosError('UNAUTHORIZED', 'This operation executes project code or an unrestricted editor message. Start with --allow-project-code to enable it.');
    const paths = this.projects.paths(request.projectId);
    const operationId = request.operationId ?? randomUUID();
    if (request.operationId) {
      const key = `${request.projectId}:${request.operationId}`;
      const fingerprint = Json.canonical({ capabilityId: capability.id, params: request.params });
      const previousInput = this.operationInputs.get(key);
      if (previousInput && previousInput !== fingerprint) throw new CocosError('OPERATION_CONFLICT', 'operationId is already bound to different capability parameters');
      this.operationInputs.set(key, fingerprint);
      const previous = this.outcomes.get(key);
      if (previous) return previous;
      const active = this.inFlight.get(key);
      if (active) return active;
    }
    const execution = this.queue.run(request.projectId, async () => {
      if (capability.context === 'runtime') {
        if (!this.runtime) throw new CocosError(FeatureSupport.owns(capability.id) ? 'UNSUPPORTED_CAPABILITY' : 'CONTEXT_UNAVAILABLE', 'Runtime gateway is not enabled');
        const result = await this.runtime.execute(request.projectId, request.runtimeInstanceId, capability.id, request.params, signal);
        const execution: ExecutionResult = { operationId, capabilityId: capability.id, projectId: request.projectId, result, verification: capability.verification, completedAt: new Date().toISOString() };
        if (request.operationId) this.remember(`${request.projectId}:${request.operationId}`, execution);
        return execution;
      }
      const descriptor = await this.projects.instance(request.projectId, request.instanceId);
      if (!capability.versions.includes(descriptor.creatorMajor) || !capability.supportedMajors?.includes(descriptor.creatorMajor)) throw new CocosError('UNSUPPORTED_VERSION', 'Capability is not implemented by this Creator major version');
      const response = await this.bridge.call(descriptor, { protocolVersion: 1, projectId: request.projectId, instanceId: descriptor.instanceId,
        operationId, capabilityId: request.capabilityId, params: request.params,
        ...(request.expectedRevision !== undefined ? { expectedRevision: request.expectedRevision } : {}) }, signal);
      const result: ExecutionResult = { operationId, capabilityId: request.capabilityId, projectId: request.projectId, instanceId: descriptor.instanceId,
        revision: response.revision, result: response.result, verification: capability.verification, completedAt: new Date().toISOString() };
      const logs = await paths.work('logs', 'cocos-mcp');
      // 审计记录保留操作元信息，不把源码、资源内容和认证凭据写进通用日志。
      await appendFile(join(logs, 'operations.jsonl'), JSON.stringify({ operationId, capabilityId: request.capabilityId, projectId: request.projectId,
        instanceId: descriptor.instanceId, revision: response.revision, completedAt: result.completedAt }) + '\n', { mode: 0o600 });
      if (request.operationId) this.remember(`${request.projectId}:${request.operationId}`, result);
      return result;
    }, signal).catch((error: unknown) => {
      if (!FeatureSupport.owns(capability.id) || !(error instanceof CocosError) || !['UNSUPPORTED_CAPABILITY', 'UNSUPPORTED_VERSION'].includes(error.code)) throw error;
      const execution: ExecutionResult = { operationId, capabilityId: capability.id, projectId: request.projectId, result: FeatureSupport.unsupported(capability.id, error.message), verification: capability.verification, completedAt: new Date().toISOString() };
      if (request.operationId) this.remember(`${request.projectId}:${request.operationId}`, execution);
      return execution;
    });
    if (!request.operationId) return execution;
    const key = `${request.projectId}:${request.operationId}`;
    this.inFlight.set(key, execution);
    try { return await execution; }
    finally { if (this.inFlight.get(key) === execution) this.inFlight.delete(key); }
  }

  async instances(projectId: string): Promise<JsonValue> {
    return { rows: (await this.projects.instances(projectId)).map(({ token: _token, ...descriptor }) => Json.value(descriptor)) };
  }

  /** 先验证整个工作流并返回副作用、风险和版本要求，供客户端在执行前展示确认信息。 */
  plan(projectId: string, steps: WorkflowStep[]): JsonValue {
    this.projects.paths(projectId);
    const rows = steps.map((step, index) => {
      try {
        const capability = this.catalog.validate(step.capabilityId, step.params);
        if (capability.implementation !== 'implemented' || !(capability.supportedMajors?.length ?? 0)) {
          return { index, capabilityId: capability.id, valid: false, error: { code: 'UNSUPPORTED_CAPABILITY', message: 'Capability is registered but has no executable adapter' } };
        }
        if (capability.effect === 'external' && !this.allowExternal) {
          return { index, capabilityId: capability.id, valid: false, error: { code: 'UNAUTHORIZED', message: 'External project code requires --allow-project-code' } };
        }
        return { index, capabilityId: capability.id, title: capability.title, valid: true,
          implementation: capability.implementation, verification: capability.verification, versions: capability.versions, supportedMajors: capability.supportedMajors ?? capability.versions,
          effect: capability.effect, context: capability.context, prerequisites: capability.prerequisites ?? [],
          sideEffects: capability.sideEffects ?? [], risks: capability.risks ?? [], rollback: capability.rollback ?? null };
      } catch (error) {
        return { index, capabilityId: step.capabilityId, valid: false, error: CocosError.from(error).toJSON() };
      }
    });
    const valid = rows.every(row => row.valid);
    return Json.value({ projectId, valid, executable: valid && rows.length > 0, rows,
      summary: { total: rows.length, valid: rows.filter(row => row.valid).length, invalid: rows.filter(row => !row.valid).length,
        destructive: rows.filter(row => row.valid && row.effect !== 'read').length } });
  }

  /** 顺序执行工作流，失败时默认停止并保留已完成步骤，便于调用方按能力的 rollback 提示做补偿。 */
  async executeWorkflow(projectId: string, steps: WorkflowStep[], signal?: AbortSignal, continueOnError = false, workflowId: string = randomUUID()): Promise<JsonValue> {
    const plan = Json.object(this.plan(projectId, steps));
    if (plan.valid !== true) throw new CocosError('INVALID_ARGUMENT', 'Workflow contains invalid steps', plan);
    const rows: JsonValue[] = [];
    await this.persistWorkflow(projectId, workflowId, { workflowId, projectId, status: 'running', startedAt: new Date().toISOString(), total: steps.length, rows });
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]!;
      try {
        const result = await this.execute({ projectId, capabilityId: step.capabilityId, params: step.params,
          ...(step.instanceId ? { instanceId: step.instanceId } : {}), ...(step.runtimeInstanceId ? { runtimeInstanceId: step.runtimeInstanceId } : {}),
          ...(step.operationId ? { operationId: step.operationId } : {}), ...(step.expectedRevision ? { expectedRevision: step.expectedRevision } : {}) }, signal);
        rows.push({ index, capabilityId: step.capabilityId, status: 'succeeded', result: Json.value(result) });
        await this.persistWorkflow(projectId, workflowId, { workflowId, projectId, status: 'running', total: steps.length, currentIndex: index, rows });
      } catch (error) {
        rows.push({ index, capabilityId: step.capabilityId, status: 'failed', error: Json.value(CocosError.from(error).toJSON()) });
        await this.persistWorkflow(projectId, workflowId, { workflowId, projectId, status: 'failed', total: steps.length, currentIndex: index, rows, completedAt: new Date().toISOString() });
        if (!continueOnError) break;
      }
    }
    const failed = rows.some(row => Json.object(row).status === 'failed');
    const status = failed ? 'failed' : rows.length === steps.length ? 'succeeded' : 'stopped';
    const result = { workflowId, projectId, status, rows,
      completed: rows.filter(row => Json.object(row).status === 'succeeded').length, total: steps.length };
    await this.persistWorkflow(projectId, workflowId, { ...result, completedAt: new Date().toISOString() });
    return Json.value(result);
  }

  async operation(projectId: string, operationId: string, instanceId?: string): Promise<JsonValue> {
    const cached = this.outcomes.get(`${projectId}:${operationId}`);
    if (cached) return Json.value(cached);
    const descriptor = await this.projects.instance(projectId, instanceId);
    const response = await this.bridge.call(descriptor, { protocolVersion: 1, projectId, instanceId: descriptor.instanceId, operationId: randomUUID(), capabilityId: 'bridge.operation', params: { operationId } });
    return response.result;
  }

  async workflow(projectId: string, workflowId: string): Promise<JsonValue> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workflowId)) throw new CocosError('INVALID_ARGUMENT', 'Invalid workflowId');
    const directory = await this.projects.paths(projectId).work('cache', 'cocos-mcp/workflows');
    try { return Json.value(JSON.parse(await readFile(join(directory, `${workflowId}.json`), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CocosError('NOT_FOUND', 'Workflow not found'); throw error; }
  }
}

export { ProjectPaths } from './paths.js';
export { ProjectRegistry } from './registry.js';
export { ProjectQueue } from './queue.js';
