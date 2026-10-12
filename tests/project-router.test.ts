import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { ProjectConnector, type ProjectBinding } from '../apps/server/src/project-connector.js';
import { ProjectRouter } from '../apps/server/src/project-router.js';
import { ProjectRegistry } from '../packages/application/src/registry.js';
import { ProjectPaths } from '../packages/application/src/paths.js';
import { ServiceConnections, type ServiceDescriptor } from '../packages/application/src/service-connections.js';
import { TestWorkspace } from './workspace.js';

class RoutedConnections extends ServiceConnections {
  service!: ServiceDescriptor;
  override async active() { return this.service; }
}
class RoutedClient extends Client {
  calls = 0;
  result: CallToolResult = { content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }], structuredContent: { frame: 4 } };
  override async callTool() { this.calls++; return this.result; }
}
class BoundConnector extends ProjectConnector {
  binding!: ProjectBinding;
  override async get(_id: string) { return this.binding; }
}
class RouterFixture {
  client = new RoutedClient({ name: 'router-fixture', version: '1' });
  connector!: BoundConnector; router!: ProjectRouter;
  context = { mcpReq: { signal: new AbortController().signal } } as unknown as ServerContext;
  async setup() {
    const root = await new TestWorkspace().create('project-router-'), paths = await ProjectPaths.open(root), connections = new RoutedConnections(paths);
    connections.service = { schemaVersion: 1, projectId: connections.projectId, projectPath: root, serviceId: 'fixture-service', pid: process.pid, startedAt: new Date().toISOString(), transport: 'http', owner: 'extension', status: 'running', endpoint: 'http://127.0.0.1:1/mcp', identityEndpoint: 'http://127.0.0.1:1/identity', tokenFile: 'fixture', apiVersion: 1 };
    this.connector = new BoundConnector(new ProjectRegistry(), { schemaVersion: 1, allowedRoots: [root], autoStartBackend: false, allowProjectCode: false, clientHeartbeatSeconds: 10, clientLeaseTtlSeconds: 60, idleExitSeconds: 90 }, root, 'unused');
    this.connector.binding = { projectId: connections.projectId, paths, descriptor: connections.service, connections, client: this.client, token: 'fixture', clientId: 'fixture', inFlight: 0 };
    this.router = new ProjectRouter(this.connector);
  }
}
test('project routing preserves image content, structured responses and backend tool errors without wrapping or replay', async () => {
  const f = new RouterFixture(); await f.setup(); const args = { projectId: f.connector.binding.projectId, instanceId: 'editor', params: {} };
  assert.equal(await f.router.call('cocos_scene_query', args, f.context), f.client.result);
  f.client.result = { content: [{ type: 'text', text: 'guarded failure' }], isError: true, structuredContent: { error: { code: 'REVISION_CONFLICT' } } };
  assert.equal(await f.router.call('cocos_scene_save', { ...args, operationId: 'save', expectedRevision: '1' }, f.context), f.client.result);
  assert.equal(f.client.calls, 2); assert.equal(f.connector.binding.inFlight, 0);
});
test('incompatible backends and already cancelled requests are rejected before any tool dispatch', async () => {
  const f = new RouterFixture(); await f.setup(); const args = { projectId: f.connector.binding.projectId, instanceId: 'editor', params: {}, operationId: 'save', expectedRevision: '1' };
  delete f.connector.binding.descriptor.apiVersion;
  await assert.rejects(f.router.call('cocos_scene_save', args, f.context), { code: 'UNSUPPORTED_VERSION' });
  await f.router.call('cocos_scene_query', args, f.context); assert.equal(f.client.calls, 1);
  f.connector.binding.descriptor.apiVersion = 2; await assert.rejects(f.router.call('cocos_scene_query', args, f.context), { code: 'UNSUPPORTED_VERSION' });
  f.connector.binding.descriptor.apiVersion = 1; const controller = new AbortController(); controller.abort();
  await assert.rejects(f.router.call('cocos_scene_query', args, { mcpReq: { signal: controller.signal } } as unknown as ServerContext), { code: 'CANCELLED' }); assert.equal(f.client.calls, 1);
});
