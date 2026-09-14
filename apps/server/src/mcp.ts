import { McpServer, ResourceTemplate, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { CocosError, Json, type ExecutionRequest } from '../../../packages/contracts/src/index.js';
import type { CocosApplication } from '../../../packages/application/src/index.js';
import type { RuntimeGateway } from '../../../packages/application/src/runtime-gateway.js';
import type { BuildJobs } from '../../../packages/native-adapters/src/build.js';

export class CocosMcpServer {
  constructor(private readonly application: CocosApplication, private readonly runtimes?: RuntimeGateway, private readonly builds?: BuildJobs, private readonly allTools = false) {}

  private async result(task: () => Promise<unknown> | unknown): Promise<CallToolResult> {
    try {
      const value = Json.value(await task());
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      const value = Json.value({ error: CocosError.from(error).toJSON() });
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    }
  }

  create(): McpServer {
    const server = new McpServer({ name: 'cocos-mcp', version: '0.1.0' });
    const project = { projectId: z.string().min(1) };
    const envelope = { ...project, instanceId: z.string().optional(), runtimeInstanceId: z.string().optional(),
      operationId: z.string().min(1).max(128).optional(), expectedRevision: z.string().optional() };
    const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    server.registerTool('cocos_projects', { title: '工程列表', description: '列出服务启动时注册的工程', inputSchema: z.object({}), annotations: read },
      () => this.result(() => this.application.projects.list()));
    server.registerTool('cocos_instances', { title: '编辑器实例', description: '列出指定工程已打开的 Creator 实例，不返回认证凭据', inputSchema: z.object(project), annotations: read },
      args => this.result(() => this.application.instances(args.projectId)));
    server.registerTool('cocos_capability_search', { title: '搜索能力', description: '搜索操作目录；先查询再执行长尾功能', inputSchema: z.object({ query: z.string().optional(), module: z.string().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100) }), annotations: read },
      args => this.result(() => this.application.catalog.search(args.query, args.module, args.offset, args.limit)));
    server.registerTool('cocos_capability_describe', { title: '能力详情', description: '获取精确参数 Schema、版本范围、副作用和验证状态', inputSchema: z.object({ capabilityId: z.string() }), annotations: read },
      args => this.result(() => this.application.catalog.describe(args.capabilityId)));
    server.registerTool('cocos_coverage', { title: '功能覆盖清单', description: '查看提案全部 54 个模块的实现和验证缺口', inputSchema: z.object({}), annotations: read },
      () => this.result(() => this.application.catalog.coverage()));
    server.registerTool('cocos_capability_execute', { title: '执行已注册能力', description: '按能力详情的 Schema 执行。修改前建议传 expectedRevision 和稳定 operationId。执行器不会执行任意 eval。',
      inputSchema: z.object({ ...envelope, capabilityId: z.string(), params: z.record(z.string(), z.unknown()).default({}) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
      (args, context) => this.execute(args, context));
    const workflowStep = z.object({ capabilityId: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}),
      instanceId: z.string().optional(), runtimeInstanceId: z.string().optional(), operationId: z.string().optional(), expectedRevision: z.string().optional() });
    server.registerTool('cocos_workflow_plan', { title: '规划工作流', description: '批量校验能力参数、版本、风险和副作用；规划不会修改工程',
      inputSchema: z.object({ ...project, steps: z.array(workflowStep).min(1).max(100) }), annotations: read },
      args => this.result(() => {
        const steps = args.steps.map(step => ({ capabilityId: step.capabilityId, params: Json.object(Json.value(step.params)),
          ...(step.instanceId ? { instanceId: step.instanceId } : {}), ...(step.runtimeInstanceId ? { runtimeInstanceId: step.runtimeInstanceId } : {}),
          ...(step.operationId ? { operationId: step.operationId } : {}), ...(step.expectedRevision ? { expectedRevision: step.expectedRevision } : {}) }));
        return this.application.plan(args.projectId, steps);
      }));
    server.registerTool('cocos_workflow_execute', { title: '执行工作流', description: '按顺序执行已规划能力；默认遇到失败即停止，并返回已完成步骤和补偿提示',
      inputSchema: z.object({ ...project, workflowId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), steps: z.array(workflowStep).min(1).max(100), continueOnError: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
      (args, context) => this.result(() => this.application.executeWorkflow(args.projectId, args.steps.map(step => ({ capabilityId: step.capabilityId, params: Json.object(Json.value(step.params)),
        ...(step.instanceId ? { instanceId: step.instanceId } : {}), ...(step.runtimeInstanceId ? { runtimeInstanceId: step.runtimeInstanceId } : {}),
        ...(step.operationId ? { operationId: step.operationId } : {}), ...(step.expectedRevision ? { expectedRevision: step.expectedRevision } : {}) })), context.mcpReq.signal, args.continueOnError, args.workflowId)));
    server.registerTool('cocos_workflow_status', { title: '工作流状态', description: '查询持久化工作流的步骤进度、失败位置和最终结果',
      inputSchema: z.object({ ...project, workflowId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }), annotations: read },
      args => this.result(() => this.application.workflow(args.projectId, args.workflowId)));
    server.registerTool('cocos_operation_query', { title: '查询操作结果', description: '超时或断线后查询 operationId，避免重复执行修改', inputSchema: z.object({ ...project, instanceId: z.string().optional(), operationId: z.string() }), annotations: read },
      args => this.result(() => this.application.operation(args.projectId, args.operationId, args.instanceId)));
    server.registerTool('cocos_runtime_instances', { title: '运行时实例', description: '列出已连接的开发运行实例', inputSchema: z.object(project), annotations: read },
      args => this.result(() => this.runtimes?.list(args.projectId) ?? { rows: [] }));
    server.registerTool('cocos_build_start', { title: '启动 Creator 构建', description: '使用 Creator CLI 构建已注册工程并返回任务 ID；构建需要本机 GUI 和已安装的平台工具', inputSchema: z.object({ ...project, creatorPath: z.string(), platform: z.string(), options: z.record(z.string(), z.unknown()).default({}) }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
      args => this.result(() => this.builds ? this.builds.start(args.projectId, this.application.projects.paths(args.projectId).root, args.creatorPath, args.platform, Json.object(Json.value(args.options))) : { error: 'Build service is unavailable' }));
    server.registerTool('cocos_build_status', { title: '构建状态', description: '查询构建任务状态、产物和日志路径', inputSchema: z.object({ ...project, jobId: z.string() }), annotations: read },
      args => this.result(() => this.builds?.status(args.projectId, this.application.projects.paths(args.projectId).root, args.jobId) ?? { error: 'Build service is unavailable' }));
    server.registerTool('cocos_build_list', { title: '构建任务', description: '列出工程的构建任务', inputSchema: z.object(project), annotations: read },
      args => this.result(() => this.builds?.list(args.projectId, this.application.projects.paths(args.projectId).root) ?? { rows: [] }));
    server.registerTool('cocos_build_logs', { title: '构建日志', description: '分页读取构建日志', inputSchema: z.object({ ...project, jobId: z.string(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(200) }), annotations: read },
      args => this.result(() => this.builds?.logs(args.projectId, this.application.projects.paths(args.projectId).root, args.jobId, args.offset, args.limit) ?? { rows: [] }));
    server.registerTool('cocos_build_cancel', { title: '取消构建', description: '取消正在执行的构建任务', inputSchema: z.object({ ...project, jobId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
      args => this.result(() => this.builds?.cancel(args.projectId, this.application.projects.paths(args.projectId).root, args.jobId) ?? { error: 'Build service is unavailable' }));

    const common = new Set(['scene.query', 'scene.snapshot', 'scene.diff', 'scene.hierarchy', 'scene.open', 'scene.save', 'node.create', 'node.query', 'node.set', 'component.add', 'component.set', 'asset.query', 'asset.import', 'prefab.instantiate', 'ui.build', 'scene.validate', 'runtime.capture']);
    for (const capability of this.application.catalog.search('', undefined, 0, Number.MAX_SAFE_INTEGER).rows) {
      if (!this.allTools && !common.has(capability.id)) continue;
      const schema = z.fromJSONSchema(capability.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
      server.registerTool(`cocos_${capability.id.replaceAll('.', '_')}`, { title: capability.title, description: capability.description,
        inputSchema: z.object({ ...envelope, params: schema }), annotations: { readOnlyHint: capability.effect === 'read', destructiveHint: capability.effect !== 'read', openWorldHint: capability.effect === 'external' } },
        (args, context) => this.execute({ ...args, capabilityId: capability.id }, context));
    }
    server.registerResource('coverage', 'cocos://coverage', { mimeType: 'application/json', description: '全部提案模块的覆盖状态' },
      uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(this.application.catalog.coverage()) }] }));
    server.registerResource('project-capabilities', new ResourceTemplate('cocos://projects/{projectId}/capabilities', { list: async () => ({ resources: this.application.projects.list().rows.map(project => ({ uri: `cocos://projects/${project.projectId}/capabilities`, name: project.projectPath, mimeType: 'application/json' })) }) }),
      { mimeType: 'application/json' }, (uri, variables) => {
        this.application.projects.paths(String(variables.projectId));
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(this.application.catalog.search('', undefined, 0, Number.MAX_SAFE_INTEGER)) }] };
      });
    server.registerPrompt('cocos-edit-workflow', { title: '可靠场景编辑流程', description: '定位工程、读取场景、修改、保存并读回验证', argsSchema: z.object({ task: z.string() }) },
      ({ task }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `任务：${task}\n先使用 cocos_projects 和 cocos_instances 明确目标，查询所需能力 Schema，读取场景 revision。修改使用唯一 operationId 和 expectedRevision。查询实际结果，保存后检查场景状态。未知或未验证的能力必须如实报告；超时先查询操作结果。` } }] }));
    return server;
  }

  private execute(args: unknown, context: ServerContext): Promise<CallToolResult> {
    return this.result(() => {
      const cleaned = Json.object(Json.value(args));
      const request: ExecutionRequest = { projectId: Json.string(cleaned.projectId, 'projectId'), capabilityId: Json.string(cleaned.capabilityId, 'capabilityId'), params: Json.object(cleaned.params ?? {}) };
      for (const key of ['instanceId', 'operationId', 'expectedRevision', 'runtimeInstanceId'] as const) if (typeof cleaned[key] === 'string') request[key] = cleaned[key];
      return this.application.execute(request, context.mcpReq.signal);
    });
  }
}
