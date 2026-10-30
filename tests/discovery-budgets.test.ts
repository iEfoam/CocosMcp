import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeClient } from '../packages/application/src/bridge-client.js';
import { ProjectRegistry } from '../packages/application/src/registry.js';
import type { BridgeDescriptor, BridgeRequest } from '../packages/contracts/src/index.js';
import { TestWorkspace } from './workspace.js';

class DiscoveryProbe extends BridgeClient {
  readonly calls: string[] = [];
  override async identity(descriptor: BridgeDescriptor): Promise<boolean> {
    this.calls.push(descriptor.instanceId);
    await new Promise(resolve => setImmediate(resolve));
    return true;
  }
}

class DiscoveryFixture {
  descriptor(projectId: string, projectPath: string, instanceId: string): BridgeDescriptor {
    return { protocolVersion: 1, projectId, projectPath, instanceId, creatorMajor: 3, editorVersion: '3.8.8', pid: process.pid, endpoint: 'http://127.0.0.1:12345/rpc', token: 'a'.repeat(64), startedAt: '' };
  }
  request(): BridgeRequest { return { protocolVersion: 1, projectId: 'p', instanceId: 'i', operationId: 'stable', capabilityId: 'node.create', params: { name: 'n' } }; }
}

test('concurrent instance discovery shares only in-flight authentication and explicit instance probes stay scoped', async () => {
  const root = await new TestWorkspace().create('discovery-'), probe = new DiscoveryProbe(), registry = new ProjectRegistry(probe), fixture = new DiscoveryFixture();
  const { projectId } = await registry.add(root), directory = join(root, '.codex-work/cache/cocos-mcp/instances');
  await mkdir(directory, { recursive: true });
  for (const id of ['one', 'two']) await writeFile(join(directory, id + '.json'), JSON.stringify(fixture.descriptor(projectId, root, id)));
  const rows = await Promise.all(Array.from({ length: 10 }, () => registry.instances(projectId)));
  assert.equal(probe.calls.length, 2); assert.ok(rows.every(row => row.length === 2));
  await registry.instance(projectId, 'one'); assert.equal(probe.calls.length, 3); assert.equal(probe.calls[2], 'one');
  await registry.instances(projectId); assert.equal(probe.calls.length, 5);
  await assert.rejects(registry.instance(projectId), { code: 'AMBIGUOUS_TARGET' });
});

test('oversized streamed bridge reply is cancelled and remains an unknown write outcome', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(65)); },
    cancel() { cancelled = true; },
  })));
  const fixture = new DiscoveryFixture();
  await assert.rejects(new BridgeClient(1000, 64).call(fixture.descriptor('p', '.', 'i'), fixture.request()), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(cancelled, true);
});

test('explicit instance lookup bypasses unrelated directory overflow but still validates filename, payload identity and authentication', async () => {
  const root = await new TestWorkspace().create('discovery-target-'), probe = new DiscoveryProbe(), registry = new ProjectRegistry(probe), fixture = new DiscoveryFixture();
  const { projectId } = await registry.add(root), directory = join(root, '.codex-work/cache/cocos-mcp/instances');
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < 2001; index++) await writeFile(join(directory, `unrelated-${index}.json`), '{}');
  await writeFile(join(directory, 'selected.json'), JSON.stringify(fixture.descriptor(projectId, root, 'selected')));
  assert.equal((await registry.instance(projectId, 'selected')).instanceId, 'selected');
  assert.deepEqual(probe.calls, ['selected']);
  await assert.rejects(registry.instances(projectId), { code: 'RESOURCE_BUSY' });
  await assert.rejects(registry.instance(projectId, '../escape'), { code: 'INVALID_ARGUMENT' });
  await writeFile(join(directory, 'selected.json'), JSON.stringify(fixture.descriptor(projectId, root, 'wrong')));
  await assert.rejects(registry.instance(projectId, 'selected'), { code: 'CONTEXT_UNAVAILABLE' });
  assert.equal(probe.calls.length, 1);
});

test('declared oversized bridge reply is rejected without reading its body', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { 'content-length': '1000' } }));
  const fixture = new DiscoveryFixture();
  await assert.rejects(new BridgeClient(1000, 64).call(fixture.descriptor('p', '.', 'i'), fixture.request()), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(cancelled, true);
});

test('bridge timings accept only bounded numeric diagnostics and preserve successful writes with legacy or invalid metadata', async t => {
  const fixture = new DiscoveryFixture();
  for (const timings of [undefined, 'invalid', [{ stage: 'native-execution', durationMs: 2, calls: 1, token: 'must-not-forward' }, { stage: 'bad', durationMs: -1, calls: 1 }]]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => Response.json({ result: { nodeId: 'confirmed' }, revision: 'r', timings }));
    try {
      const result = await new BridgeClient().call(fixture.descriptor('p', '.', 'i'), fixture.request());
      assert.deepEqual(result.result, { nodeId: 'confirmed' });
      assert.deepEqual(result.timings, Array.isArray(timings) ? [{ stage: 'native-execution', durationMs: 2, calls: 1 }] : undefined);
    } finally { mocked.mock.restore(); }
  }
});

test('bridge JSON serialization timing is read from numeric Server-Timing without depending on optional body diagnostics', async t => {
  const fixture = new DiscoveryFixture();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ result: {}, revision: 'r' }, { headers: { 'server-timing': 'cocos-json;dur=0.125' } }));
  const result = await new BridgeClient().call(fixture.descriptor('p', '.', 'i'), fixture.request());
  assert.deepEqual(result.timings, [{ stage: 'response-serialization', durationMs: 0.125, calls: 1 }]);
});
