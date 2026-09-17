import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';

const project = resolve('.codex-work/build/creator2-test-project'), registry = new ProjectRegistry();
const { projectId } = await registry.add(project), app = new CocosApplication(registry);
const results: JsonObject[] = [];
const call = async (id: string, params: JsonObject = {}): Promise<JsonObject> => {
  const result = Json.object((await app.execute({ projectId, capabilityId: id, params })).result);
  results.push({ id, result }); console.log(`PASS ${id}`); return result;
};
try {
  const candidates = (await call('asset.query', { pattern: 'db://assets/**/*.png', limit: 100 })).rows as JsonObject[];
  assert.ok(candidates.length);
  const texture = candidates[0]!;
  const meta = Json.object((await call('asset.meta', { url: texture.url! })).meta);
  const subassets = Object.values(Json.object(meta.subMetas ?? {})) as JsonObject[];
  assert.ok(subassets.length, 'Expected imported SpriteFrame subasset');
  const valid = subassets[0]!.uuid!, missing = 'd71ff4d8-1893-48ed-a22f-9d7343ad14b1';
  const location = await call('asset.location', { url: `db://assets/Prefabs/ReferenceAudit-${Date.now()}.prefab` });
  const content = JSON.stringify([
    { __type__: 'cc.Prefab', _name: 'ReferenceAudit', data: { __id__: 1 } },
    { __type__: 'cc.Node', _name: 'ReferenceAudit', _children: [], _components: [{ __id__: 2 }, { __id__: 3 }] },
    { __type__: 'cc.Sprite', node: { __id__: 1 }, _spriteFrame: { __uuid__: valid } },
    { __type__: 'cc.Sprite', node: { __id__: 1 }, _spriteFrame: { __uuid__: missing } },
  ]);
  await call('asset.create', { url: location.url!, content });
  const audit = await call('asset.references.audit', { url: location.url! });
  const refs = audit.rows as JsonObject[];
  assert.equal(refs.find(row => row.targetId === valid)!.status, 'registered');
  assert.equal(refs.find(row => row.targetId === missing)!.status, 'missing');
  assert.equal(audit.assetLookupComplete, true); assert.equal(audit.unsavedSceneIncluded, false);
  assert.ok((audit.issues as JsonObject[]).some(row => row.code === 'ASSET_REFERENCE_MISSING'));
  // 只修改本脚本创建的测试资源；通过 AssetDB 保存，保留 UUID 和元数据。
  await call('asset.save', { url: location.url!, content: content.replace(missing, String(valid)) });
  const repaired = await call('asset.references.audit', { url: location.url! });
  assert.equal((repaired.issues as JsonObject[]).length, 0);
  assert.equal(repaired.uniqueAssets, 1);
  results.push({ passed: true, assertions: 'native AssetDB SpriteFrame subasset, saved missing UUID, explicit source correction, duplicate lookup consolidation', fixture: location.url! });
} catch (error) { results.push({ passed: false, error: CocosError.from(error).message }); process.exitCode = 1; console.error(error); }
finally { await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/asset-references.json'), JSON.stringify({ project, results }, null, 2)); }
