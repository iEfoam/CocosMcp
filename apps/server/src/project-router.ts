import type { CallToolResult, ReadResourceResult, ServerContext } from '@modelcontextprotocol/server';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { CapabilityCatalog } from '../../../packages/capability-catalog/src/index.js';
import { CaptureResult } from './capture-result.js';
import type { McpRouting } from './mcp.js';
import type { ProjectConnector } from './project-connector.js';

export class ProjectRouter implements McpRouting {
  static readonly instructions = 'Cocos 工具可直接传会话绝对 workspacePath，按 realpath 自动选择已授权工程并连接，无需先 cocos_project_connect；显式 projectId 优先，其次 projectPath。宿主可在启动时提供 COCOS_WORKSPACE_PATH，不能假定 stdio cwd 或安装目录是聊天工作区。工程内选择最近根，父目录多候选且无明确映射返回 AMBIGUOUS_TARGET 和脱敏 rows，选择 projectPath；不按名称、复制 id 或打开窗口猜工程。仅目标工程唯一且身份验证通过的编辑器实例可自动选择；多实例指定 instanceId。运行时明确指定 runtimeInstanceId。创建资源先 asset.location；整理先 plan 后 apply。写入传稳定 operationId 和适用 revision/哈希；未知结果查询原操作，禁止重发，恢复未知构建须确认原任务停止。';
  readonly instructions = ProjectRouter.instructions;
  constructor(readonly connector: ProjectConnector, readonly catalog = new CapabilityCatalog(), private readonly workspacePath?: string) {}
  get projects() { return this.connector.projects; }
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
    args = await this.target(args);
    const projectId = Json.string(args.projectId, 'projectId'), row = await this.connector.get(projectId);
    args = await this.instances(name, args, projectId);
    const writing = this.guard(name, args);
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
  private async target(args: JsonObject): Promise<JsonObject> {
    if (args.projectId) return { ...args };
    const workspace = typeof args.workspacePath === 'string' ? args.workspacePath : this.workspacePath;
    const path = typeof args.projectPath === 'string' ? args.projectPath : workspace ? (await this.connector.workspace(workspace)).root : undefined;
    if (!path) throw new CocosError('INVALID_ARGUMENT', 'Provide workspacePath, projectPath or a connected projectId; the host has not supplied a reliable session workspace');
    const connected = Json.object(await this.connector.connect(path)), project = Json.object(connected.project!);
    // 连接表由此 stdio 会话独占，工程标识由真实根路径生成；每次重新解析授权候选，不缓存旧授权选择。
    const { workspacePath: _workspace, projectPath: _path, ...forwarded } = args;
    return { ...forwarded, projectId: Json.string(project.projectId, 'projectId') };
  }
  private registered(name: string, args: JsonObject): ReturnType<CapabilityCatalog['describe']> | undefined {
    if (name === 'cocos_capability_execute') return this.catalog.describe(Json.string(args.capabilityId, 'capabilityId'));
    if (name === 'cocos_assets_organize_plan' || name === 'cocos_assets_organize_apply') return this.catalog.describe(name.endsWith('_plan') ? 'asset.organize.plan' : 'asset.organize.apply');
    return this.catalog.search('', undefined, 0, 1000).rows.find(row => `cocos_${row.id.replaceAll('.', '_')}` === name);
  }
  private async instances(name: string, args: JsonObject, projectId: string): Promise<JsonObject> {
    const steps = name === 'cocos_workflow_execute' && Array.isArray(args.steps) ? args.steps.map(value => Json.object(value)) : undefined;
    const needsInstance = steps ? steps.some(step => this.catalog.describe(Json.string(step.capabilityId, 'capabilityId')).context === 'editor' && !step.instanceId) :
      this.registered(name, args)?.context === 'editor' && !args.instanceId;
    if (!needsInstance) return args;
    const rows = await this.connector.projects.instances(projectId);
    if (!rows.length) throw new CocosError('CONTEXT_UNAVAILABLE', 'No authenticated editor instance is available in the selected project');
    if (rows.length !== 1) throw new CocosError('AMBIGUOUS_TARGET', 'Multiple authenticated instances belong to the selected project; specify instanceId', {
      projectId, rows: rows.map(({ token: _token, ...row }) => Json.value(row)) });
    const instanceId = rows[0]!.instanceId;
    if (steps) return { ...args, steps: steps.map(step => this.catalog.describe(Json.string(step.capabilityId, 'capabilityId')).context === 'editor' && !step.instanceId ? { ...step, instanceId } : step) };
    return { ...args, instanceId };
  }
  private capability(id: string, args: JsonObject, planning = false): boolean {
    const capability = this.catalog.describe(id);
    if (capability.context === 'editor' && !args.instanceId) throw new CocosError('AMBIGUOUS_TARGET', 'Editor operations require a selected authenticated instanceId');
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
    const capability = this.registered(name, args);
    return capability ? this.capability(capability.id, args) : false;
  }
  async resource(uri: string): Promise<ReadResourceResult> {
    const url = new URL(uri), match = /^\/([a-f\d]{24})\/capabilities$/.exec(url.pathname);
    if (url.protocol !== 'cocos:' || url.hostname !== 'projects' || !match || url.search || url.hash) throw new CocosError('INVALID_ARGUMENT', 'Unknown project resource URI');
    const row = await this.connector.get(match[1]!); row.inFlight++;
    try {
      if ((await row.connections.active())?.serviceId !== row.descriptor.serviceId) throw new CocosError('CONTEXT_UNAVAILABLE', 'Backend identity changed; reconnect');
      return await row.client.readResource({ uri }, { timeout: 10000 });
    } finally { row.inFlight--; }
  }
}
