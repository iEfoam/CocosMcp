import assert from 'node:assert/strict';
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';

const project = resolve('.codex-work/build/creator2-test-project'), registry = new ProjectRegistry(), { projectId } = await registry.add(project);
const gateway = new RuntimeGateway(registry), gatewayPort = await gateway.start(), app = new CocosApplication(registry, undefined, undefined, true, gateway);
const rows: JsonObject[] = []; let preview = false;
const call = async (id: string, params: JsonObject = {}): Promise<JsonObject> => { const result = Json.object((await app.execute({ projectId, capabilityId: id, params })).result); rows.push({ id, result }); console.log(`PASS ${id}`); return result; };
try {
  const scene = Json.object((await call('scene.query')).scene).sceneId!;
  const source = '/Applications/Cocos/Creator/2.4.15/CocosCreator.app/Contents/Resources/templates/example-cases/assets/res/imported';
  const nodes: string[] = [];
  for (const file of ['map.tmx', 'iso-test.tmx']) {
    const content = await readFile(join(source, file), 'utf8');
    const files = [...new Set([...content.matchAll(/<image[^>]+source="([^"]+)"/g)].map(row => row[1]!)), file];
    let uuid: string | undefined;
    for (const name of files) {
      assert.ok(!name.includes('/') && !name.includes('..'));
      const location = await call('asset.location', { url: `db://assets/Textures/TilemapCoverage/${name}` });
      if (!location.targetExists) {
        const directory = join(project, '.codex-work/downloads/tilemap'); await mkdir(directory, { recursive: true });
        const sourcePath = join(directory, name); await copyFile(join(source, name), sourcePath);
        await call('asset.import', { sourcePath, targetUrl: location.url! });
      }
      if (name === file) uuid = String((await call('asset.resolve', { reference: location.url! })).uuid);
    }
    const nodeId = (await call('node.create', { parentId: scene, name: `TilemapCoverage-${file}-${Date.now()}` })).nodeId!; nodes.push(String(nodeId));
    const componentId = (await call('component.add', { nodeId, type: 'cc.TiledMap' })).componentId!;
    await call('component.set', { componentId, properties: { tmxAsset: { uuid: uuid! } } });
  }
  await call('scene.save'); await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const hierarchy = (await call('runtime.hierarchy', { limit: 1000 })).rows as JsonObject[];
  for (const nodeId of nodes) {
    const node = hierarchy.find(row => row.nodeId === nodeId)!;
    const componentId = (node.components as JsonObject[]).find(row => row.type === 'cc.TiledMap')!.componentId!;
    const map = await call('runtime.tilemap.inspect', { componentId }), layer = (map.rows as JsonObject[])[0]!.componentId!;
    const region = { componentId: layer, x: 0, y: 0, width: 2, height: 2 };
    const before = await call('runtime.tilemap.query_region', region); assert.equal((before.rows as unknown[]).length, 4);
    const params = { componentId: layer, rows: [{ x: 0, y: 0, gid: 1, flags: 2147483648 }] };
    const plan = await call('runtime.tilemap.plan', params);
    await call('runtime.tilemap.apply', { ...params, planHash: plan.planHash! });
    const changed = (await call('runtime.tilemap.query_region', region)).rows as JsonObject[];
    assert.equal(changed[0]!.gid, 1); assert.equal(changed[0]!.flags, 2147483648);
    await assert.rejects(() => call('runtime.tilemap.apply', { ...params, planHash: plan.planHash! }), error => CocosError.from(error).code === 'STALE_REVISION');
    const old = (before.rows as JsonObject[])[0]!;
    const restore = { componentId: layer, rows: [{ x: 0, y: 0, gid: old.gid!, flags: old.flags! }] };
    const restoration = await call('runtime.tilemap.plan', restore); await call('runtime.tilemap.apply', { ...restore, planHash: restoration.planHash! });
    assert.deepEqual((await call('runtime.tilemap.query_region', region)).rows, before.rows);
  }
  rows.push({ passed: true, assertions: 'orthogonal/isometric, zero coordinates, unsigned flip flags, stale plan, restore readback' });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/tilemap.json'), JSON.stringify({ project, rows }, null, 2)); } }
