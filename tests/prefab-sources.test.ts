import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrefabSources } from '../packages/creator3-adapter/src/prefab-sources.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';
import { TestWorkspace } from './workspace.js';

class SourceFixture {
  async create() {
    const root = await new TestWorkspace().create('prefab-sources-'); await mkdir(join(root, 'assets'));
    const rootFile = join(root, 'assets/root.prefab'), childFile = join(root, 'assets/child.prefab');
    await writeFile(rootFile, JSON.stringify([{ __type__: 'cc.PrefabInfo', asset: { __uuid__: 'child' }, instance: {} }]));
    await writeFile(childFile, '[]');
    const port = { projectPath: root, request: async (_channel: string, _message: string, uuid: string) => ({ uuid, type: 'cc.Prefab', url: `db://assets/${uuid}.prefab` }) } as unknown as EditorPort;
    return { rootFile, childFile, port };
  }
}

test('nested source changes invalidate comparison even when the root Prefab remains unchanged', async () => {
  const f = await new SourceFixture().create(), sources = new PrefabSources(f.port);
  const first = await sources.capture('root'); assert.equal(first.dependencies.length, 2); await sources.verify();
  await assert.rejects(sources.capture('root'), { code: 'OPERATION_CONFLICT' });
  await writeFile(f.childFile, '[{"changed":true}]');
  await assert.rejects(sources.verify(), { code: 'STALE_REVISION' });
  const second = await new PrefabSources(f.port).capture('root');
  assert.equal(first.sha256, second.sha256); assert.notEqual(first.graphHash, second.graphHash);
});

test('dependency cycles and AssetDB remapping fail closed', async () => {
  const f = await new SourceFixture().create();
  const sources = new PrefabSources(f.port); await sources.capture('root');
  f.port.request = async () => ({ uuid: 'root', type: 'cc.Prefab', url: 'db://assets/other.prefab' });
  await assert.rejects(sources.verify(), { code: 'STALE_REVISION' });
  const cyclic = await new SourceFixture().create();
  await writeFile(cyclic.childFile, JSON.stringify([{ __type__: 'cc.PrefabInfo', asset: { __uuid__: 'root' }, instance: {} }]));
  await assert.rejects(new PrefabSources(cyclic.port).capture('root'), /Cyclic nested Prefab/);
});

test('compressed and full dependency UUIDs share one verified AssetDB identity', async () => {
  const f = await new SourceFixture().create(), full = 'fc991dd7-0033-4b80-9d41-c8a86a702e59', compressed = 'fcmR3XADNLgJ1ByKhqcC5Z';
  await writeFile(f.rootFile, JSON.stringify([compressed, full].map(uuid => ({ __type__: 'cc.PrefabInfo', asset: { __uuid__: uuid }, instance: {} }))));
  const requests: string[] = [];
  f.port.request = async (_channel, _method, uuid) => {
    requests.push(String(uuid));
    return { uuid: uuid === 'root' ? 'root' : compressed, type: 'cc.Prefab', url: `db://assets/${uuid === 'root' ? 'root' : 'child'}.prefab` };
  };
  const sources = new PrefabSources(f.port), result = await sources.capture('root'); await sources.verify();
  assert.equal(result.dependencies.length, 2); assert.equal(requests.filter(id => id === full).length, 2);
  assert.equal(requests.includes(compressed), false);
});
