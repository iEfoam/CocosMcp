import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { CocosMcpServer } from '../apps/server/src/mcp.js';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { ProjectRouter } from '../apps/server/src/project-router.js';
import { UiAuthoring } from '../apps/server/src/ui-authoring.js';

test('MCP discovery exposes organization tools, scope schemas and mandatory asset instructions', async () => {
  const server = new CocosMcpServer(new CocosApplication(new ProjectRegistry())).create();
  const client = new Client({ name: 'organization-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    assert.match(client.getInstructions() ?? '', /asset.location/);
    assert.match(client.getInstructions() ?? '', /静态 UI 默认用 ui.plan\/build/);
    assert.match(client.getInstructions() ?? '', /scene.save 或 prefab.create/);
    assert.ok((ProjectRouter.instructions + UiAuthoring.instructions).length <= 512);
    const { tools } = await client.listTools();
    assert.equal(tools.find(row => row.name === 'cocos_ui_plan')?.annotations?.readOnlyHint, true);
    assert.match(tools.find(row => row.name === 'cocos_ui_build')?.description ?? '', /脚本只负责交互与动态内容/);
    const plan = tools.find(row => row.name === 'cocos_assets_organize_plan')!;
    const apply = tools.find(row => row.name === 'cocos_assets_organize_apply')!;
    assert.equal(plan.annotations?.readOnlyHint, true); assert.equal(apply.annotations?.readOnlyHint, false);
    assert.ok(apply.inputSchema.required?.includes('planHash'));
    const result = await client.callTool({ name: apply.name, arguments: { projectId: 'unknown', planHash: 'stale' } });
    assert.equal(result.isError, true);
  } finally { await client.close(); await server.close(); }
});
