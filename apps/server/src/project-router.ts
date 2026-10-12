import type { CallToolResult, ReadResourceResult, ServerContext } from '@modelcontextprotocol/server';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { CapabilityCatalog } from '../../../packages/capability-catalog/src/index.js';
import { CaptureResult } from './capture-result.js';
import type { McpRouting } from './mcp.js';
import { ProjectConnector } from './project-connector.js';

export class ProjectRouter implements McpRouting {
  readonly instructions = '处理 Cocos Creator 工程、场景、节点、资源、预制体、材质、构建或运行时任务时，先从会话上下文确认目标工程绝对路径，并调用 cocos_project_connect。后续工程工具使用返回的 projectId；编辑器和运行时操作必须指定实例。目标不明确时先询问，不能用唯一打开窗口猜测工程。创建资源前调用 asset.location；整理先 plan 后 apply。写操作使用稳定 operationId 和适用版本/哈希守卫；结果未知时查询原操作，禁止自动重试。恢复未知构建前须确认原任务已经停止。';
  constructor(readonly connector: ProjectConnector, private readonly catalog = new CapabilityCatalog()) {}
  private result(value: JsonValue): CallToolResult { return new CaptureResult().format(value); }
  async call(name: string, args: JsonObject, context: ServerContext): Promise<CallToolResult> {
    if (context.mcpReq.signal.aborted) throw new CocosError('CANCELLED', 'Request cancelled before dispatch');
    if (name === 'cocos_project_connect') return this.result(await this.connector.connect(Json.string(args.projectPath, 'projectPath'), typeof args.instanceId === 'string' ? args.instanceId : undefined));
    if (name === 'cocos_project_disconnect') return this.result(await this.connector.disconnect(Json.string(args.projectId, 'projectId')));
    if (name === 'cocos_connection_status') return this.result(await this.connector.status(typeof args.projectId === 'string' ? args.projectId : undefined));
    if (name === 'cocos_projects') return this.result(this.connector.list());
    if (!args.projectId) {
      if (name === 'cocos_capability_search') return this.result(Json.value(this.catalog.search(typeof args.query === 'string' ? args.query : '', typeof args.module === 'string' ? args.module : undefined, Number(args.offset ?? 0), Number(args.limit ?? 100))));
      if (name === 'cocos_capability_describe') return this.result(Json.value(this.catalog.describe(Json.string(args.capabilityId, 'capabilityId'))));
      if (name === 'cocos_coverage') return this.result(Json.value({ ...this.catalog.coverage(), requiresProjectConnection: true }));
    }
    const projectId = Json.string(args.projectId, 'projectId'), row = this.connector.get(projectId), writing = this.guard(name, args);
    if (writing && row.descriptor.apiVersion !== 1) throw new CocosError('UNSUPPORTED_VERSION', 'Backend API is incompatible with guarded writes; upgrade the project backend before editing', { actualApiVersion: row.descriptor.apiVersion ?? null, requiredApiVersion: 1 });
    if (row.descriptor.apiVersion !== undefined && row.descriptor.apiVersion !== 1) throw new CocosError('UNSUPPORTED_VERSION', 'Unsupported project backend API');
    row.inFlight++;
    try {
      const active = await row.connections.active();
      if (!active || active.serviceId !== row.descriptor.serviceId) throw new CocosError('CONTEXT_UNAVAILABLE', 'Backend identity changed; reconnect and inspect the target again');
      if (context.mcpReq.signal.aborted) throw new CocosError('CANCELLED', 'Request cancelled before dispatch');
      const token = context.mcpReq._meta?.progressToken;
      try {
        return await row.client.callTool({ name, arguments: args }, { signal: context.mcpReq.signal, timeout: 120_000, maxTotalTimeout: 120_000,
          ...((typeof token === 'string' || typeof token === 'number') ? { onprogress: progress => { void context.mcpReq.notify({ method: 'notifications/progress', params: { ...progress, progressToken: token } }).catch(() => {}); } } : {}) });
      } catch (error) {
        // 已交给传输层的写请求不能自动重发；保留原标识，让调用方查询后端的持久结果。
        if (writing) throw new CocosError('OUTCOME_UNKNOWN', 'Write reply was not received; query its original operation/workflow/build before recovery', {
          projectId, operationId: args.operationId ?? null, workflowId: args.workflowId ?? null, jobId: args.jobId ?? null });
        throw new CocosError('CONTEXT_UNAVAILABLE', 'Backend read failed; reconnect before requesting a fresh result');
      }
    } finally { row.inFlight--; }
  }
  private capability(id: string, args: JsonObject, planning = false): boolean {
    const capability = this.catalog.describe(id);
    if (capability.context === 'editor' && !args.instanceId) throw new CocosError('AMBIGUOUS_TARGET', 'Editor operations require explicit instanceId from cocos_project_connect');
    if (capability.context === 'runtime' && !args.runtimeInstanceId && !args.runtimeRef) throw new CocosError('AMBIGUOUS_TARGET', 'Runtime operations require explicit runtimeInstanceId or a planned runtimeRef');
    if (capability.effect === 'external' && !this.connector.policy.allowProjectCode) throw new CocosError('UNAUTHORIZED', 'Client policy does not allow executing project code');
    const writing = capability.effect !== 'read';
    if (writing && !planning && !args.operationId) throw new CocosError('INVALID_ARGUMENT', 'Writes require a stable operationId before dispatch');
    if (capability.effect === 'scene' && !planning && !args.expectedRevision) throw new CocosError('INVALID_ARGUMENT', 'Scene writes require expectedRevision from a fresh scene read');
    return writing;
  }
  private guard(name: string, args: JsonObject): boolean {
    if (name === 'cocos_capability_execute') return this.capability(Json.string(args.capabilityId, 'capabilityId'), args);
    if (name === 'cocos_assets_organize_plan' || name === 'cocos_assets_organize_apply') return this.capability(name.endsWith('_plan') ? 'asset.organize.plan' : 'asset.organize.apply', args);
    if (name === 'cocos_workflow_plan' || name === 'cocos_workflow_execute') {
      if (name === 'cocos_workflow_execute' && !args.workflowId) throw new CocosError('INVALID_ARGUMENT', 'Workflow execution requires a stable workflowId');
      const steps = args.steps;
      if (!Array.isArray(steps)) throw new CocosError('INVALID_ARGUMENT', 'Expected workflow steps');
      // 规划只检查 Schema，无需已选实例；执行时逐步检查，保留来自此前步骤的运行时引用。
      if (name === 'cocos_workflow_execute') for (const step of steps) { const row = Json.object(step); this.capability(Json.string(row.capabilityId, 'capabilityId'), row); }
      return name === 'cocos_workflow_execute';
    }
    if (name === 'cocos_build_start') { if (!args.operationId) throw new CocosError('INVALID_ARGUMENT', 'Build start requires a stable operationId'); return true; }
    if (name === 'cocos_build_cancel' || name === 'cocos_build_recover') return true;
    // 服务工具优先匹配；常用能力别名来自同一目录，不能由别名绕过目标与写入守卫。
    const capability = this.catalog.search('', undefined, 0, 1000).rows.find(row => `cocos_${row.id.replaceAll('.', '_')}` === name);
    return capability ? this.capability(capability.id, args) : false;
  }
  async resource(uri: string): Promise<ReadResourceResult> {
    const url = new URL(uri), match = /^\/([a-f\d]{24})\/capabilities$/.exec(url.pathname);
    if (url.protocol !== 'cocos:' || url.hostname !== 'projects' || !match || url.search || url.hash) throw new CocosError('INVALID_ARGUMENT', 'Unknown project resource URI');
    const row = this.connector.get(match[1]!); row.inFlight++;
    try {
      if ((await row.connections.active())?.serviceId !== row.descriptor.serviceId) throw new CocosError('CONTEXT_UNAVAILABLE', 'Backend identity changed; reconnect');
      return await row.client.readResource({ uri }, { timeout: 10000 });
    } finally { row.inFlight--; }
  }
}
