import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { VerificationRegistry, type Evidence } from '../packages/capability-catalog/src/verification.js';
import { Operations } from '../packages/capability-catalog/src/operations.js';
import modules from '../packages/capability-catalog/src/modules.json' with { type: 'json' };
import { CocosMcpServer } from '../apps/server/src/mcp.js';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';

class CoverageHarness {
  plannedCatalog(): CapabilityCatalog {
    const rows = new Operations().list();
    rows.push({ ...rows.find(row => row.id === 'ui.build')!, id: 'ui.future_fixture', implementation: 'planned', supportedMajors: [] });
    return new CapabilityCatalog(rows);
  }
  evidence(level: Evidence['level'], fingerprint = 'current'): Evidence {
    return { id: 'reviewed-proof', level, entryIds: ['scene.query', 'cocos_build_status'], sourceFingerprint: fingerprint, source: 'test-proof', limitations: 'Test fixture only' };
  }
  catalog(level: Evidence['level'], fingerprint = 'current', scope = modules.find(row => row.id === 'F04')!.scope): CapabilityCatalog {
    return new CapabilityCatalog(new Operations().list(), new VerificationRegistry({ sourceFingerprint: 'current', records: [this.evidence(level, fingerprint)] }), [
      { moduleId: 'F04', reviewedScope: scope, criteria: [{ title: 'Explicit scope review fixture', entryIds: ['scene.query'], evidenceIds: ['reviewed-proof'] }] },
    ]);
  }
}

test('module completeness is not inferred from registered implemented operations', () => {
  const rows = new CapabilityCatalog().coverage().rows;
  assert.equal(rows.find(row => row.id === 'F04')!.status, 'partial');
  assert.equal(rows.find(row => row.id === 'F20')!.status, 'partial');
  assert.equal(rows.find(row => row.id === 'F47')!.registeredServiceTools, 6);
  assert.equal(rows.find(row => row.id === 'F47')!.status, 'partial');
  assert.equal(rows.find(row => row.id === 'F52')!.registeredServiceTools, 3);
  assert.equal(rows.find(row => row.id === 'F52')!.status, 'partial');
  assert.equal(rows.find(row => row.id === 'F13')!.registeredServiceTools, 0);
  assert.equal(new CapabilityCatalog().coverage().counting.aliasServiceTools, 3);
  assert.equal(new CapabilityCatalog().search('build').serviceTools.rows.length, 6);
  assert.equal(new CapabilityCatalog().search('workflow').serviceTools.rows.length, 3);
});

test('historical evidence remains visible but cannot certify current source or changed scope', () => {
  const h = new CoverageHarness();
  const stale = h.catalog('editor-verified', 'old');
  assert.equal(stale.describe('scene.query').verification, 'unverified');
  assert.equal(stale.describe('scene.query').verificationEvidence![0]!.applicability, 'historical');
  assert.equal(stale.coverage().rows.find(row => row.id === 'F04')!.status, 'partial');
  assert.equal(h.catalog('adapter-tested').describe('scene.query').verification, 'adapter-tested');
  assert.equal(h.catalog('adapter-tested').coverage().rows.find(row => row.id === 'F04')!.status, 'partial');
  assert.equal(h.catalog('editor-verified').coverage().rows.find(row => row.id === 'F04')!.status, 'implemented');
  assert.equal(h.catalog('editor-verified', 'current', 'outdated scope').coverage().rows.find(row => row.id === 'F04')!.status, 'partial');
  assert.equal(h.catalog('adapter-tested').serviceTools().find(row => row.id === 'cocos_build_status')!.verification, 'adapter-tested');
});

test('planned capabilities remain searchable but fail before execution', () => {
  const catalog = new CoverageHarness().plannedCatalog();
  assert.equal(catalog.search('ui.future_fixture').rows[0]!.implementation, 'planned');
  assert.throws(() => catalog.validate('ui.future_fixture', {}), /not executable/);
});

for (const allTools of [false, true]) test(`MCP tools omit planned entries and include independently counted service tools (allTools=${allTools})`, async () => {
  const catalog = new CoverageHarness().plannedCatalog(), server = new CocosMcpServer(new CocosApplication(new ProjectRegistry(), catalog), undefined, undefined, allTools).create();
  const client = new Client({ name: 'coverage-tests', version: '1' }); const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.some(row => row.name === 'cocos_ui_future_fixture'), false);
    assert.equal(tools.some(row => row.name === 'cocos_ui_build'), true);
    for (const tool of catalog.serviceTools()) assert.ok(tools.some(row => row.name === tool.id), `Undeclared service tool: ${tool.id}`);
    const generated = new Set(catalog.search('', undefined, 0, 1000).rows.map(row => `cocos_${row.id.replaceAll('.', '_')}`));
    assert.deepEqual(tools.filter(row => !generated.has(row.name)).map(row => row.name).sort(), catalog.serviceTools().map(row => row.id).sort());
    const result = await client.callTool({ name: 'cocos_capability_execute', arguments: { projectId: 'does-not-exist', capabilityId: 'ui.future_fixture', params: {} } });
    assert.equal(result.isError, true); assert.match(JSON.stringify(result), /not executable/);
    const coverage = await client.callTool({ name: 'cocos_coverage', arguments: {} });
    const content = coverage.structuredContent as { rows: Array<{ id: string; serviceTools: Array<{ availableInThisServer: boolean }> }> };
    assert.ok(content.rows.find(row => row.id === 'F47')!.serviceTools.every(row => row.availableInThisServer === false));
  } finally { await client.close(); await server.close(); }
});
