import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';
import { CreatorAccount } from './creator-account.mjs';
import { NativeAcceptanceGuard } from './native-acceptance-guard.js';

/** 仅在指定隔离工程创建自有场景/脚本；用真实脚本缺失验证比较与写入守卫。 */
class PrefabComponentNativeAcceptance {
  async run(project: string): Promise<void> {
    const guard = new NativeAcceptanceGuard(process.cwd());
    project = await guard.project(project, 3);
    const editor = guard.editor(await new CreatorAccount().existing(project), 3);
    const installed = JSON.parse(await readFile(join(project, 'extensions/cocos-mcp-creator3/package.json'), 'utf8')) as { buildId: string; sourceFingerprint: string };
    const registry = new ProjectRegistry(), { projectId } = await registry.add(project), app = new CocosApplication(registry);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const directory = resolve('.codex-work/artifacts/optimization-review-20261029', `prefab-components-${suffix}`);
    await mkdir(directory, { recursive: true });
    const rows: JsonObject[] = [], checks: string[] = [];
    const call = async (capabilityId: string, params: JsonObject = {}): Promise<JsonObject> => {
      try {
        const response = await app.execute({ projectId, instanceId: editor.instanceId, capabilityId, params });
        const result = Json.object(response.result); rows.push({ capabilityId, params, result }); return result;
      } catch (error) { rows.push({ capabilityId, params, error: Json.value(CocosError.from(error).toJSON()) }); throw error; }
      finally { await writeFile(join(directory, 'calls.json'), JSON.stringify(rows, null, 2)); }
    };
    let previous: string | undefined, created = false, failure: unknown;
    try {
      const initial = await call('scene.query'); assert.equal(initial.dirty, false);
      guard.preview(await call('preview.status'));
      previous = String(Json.object(initial.scene).sceneId);
      const sceneUrl = String((await call('asset.location', { url: `db://assets/PrefabComponentAcceptance_${suffix}.scene` })).url);
      await call('scene.create', { url: sceneUrl }); created = true;
      const sceneId = String(Json.object((await call('scene.query')).scene).sceneId);
      const className = `PrefabComponentAcceptance${suffix}`;
      const scriptUrl = String((await call('asset.location', { url: `db://assets/${className}.ts` })).url);
      const source = `import {_decorator,Component} from 'cc';const {ccclass,property}=_decorator;@ccclass('${className}') export class ${className} extends Component {@property score:number=7;}`;
      await call('asset.create', { url: scriptUrl, content: source });
      const scriptUuid = Json.object((await call('asset.info', { url: scriptUrl })).asset).uuid;
      let type: JsonObject | undefined;
      for (let i = 0; i < 40; i++) {
        type = ((await call('component.types')).rows as JsonObject[]).find(row => row.name === className);
        if (type) break; await delay(250);
      }
      assert.ok(type, 'Native custom component must register');
      const nodeId = String((await call('node.create', { parentId: sceneId, name: 'ComponentProbe' })).nodeId);
      await call('component.add', { nodeId, type: type.cid! });
      const prefabUrl = String((await call('asset.location', { url: `db://assets/PrefabComponentAcceptance_${suffix}.prefab` })).url);
      const prefab = await call('prefab.create', { nodeId, url: prefabUrl }), rootId = String(prefab.rootId);
      const components = ((await call('scene.hierarchy', { rootId, includeComponents: true })).rows as JsonObject[])[0]!.components as JsonObject[];
      const component = components.find(row => row.type === className); assert.ok(component, 'Custom component must survive Prefab creation');
      await call('component.set', { componentId: component.componentId!, properties: { score: 11 } });
      const diff = await call('prefab.diff', { nodeId: rootId });
      assert.equal(diff.comparisonComplete, true);
      assert.ok((diff.rows as JsonObject[]).some(row => row.change && Json.object(row.change).path === 'properties/score' && Json.object(row.change).before === 7 && Json.object(row.change).after === 11));
      checks.push('native custom component property override');
      await call('scene.save');
      // 删除前核对自有脚本身份；不删除任何历史资产，也不直接编辑场景或 .meta。
      assert.equal(Json.object((await call('asset.info', { url: scriptUrl })).asset).uuid, scriptUuid);
      await call('asset.delete', { url: scriptUrl });
      await call('scene.open', { uuid: previous });
      await call('scene.open', { uuid: sceneId });
      // Prefab 重载可能重建实例 UUID；按本次唯一名称重新定位，并由 diff 校验资源关联。
      const reopened = ((await call('scene.hierarchy', { includeComponents: true })).rows as JsonObject[]).filter(row => row.parentId !== null && row.name === prefab.rootName);
      assert.equal(reopened.length, 1, 'Exactly one owned Prefab instance must survive reopen');
      const reopenedId = String(reopened[0]!.nodeId);
      const missing = await call('prefab.diff', { nodeId: reopenedId });
      assert.equal(missing.assetUuid, prefab.assetUuid);
      assert.equal(missing.comparisonComplete, false);
      assert.ok((missing.issues as JsonObject[]).some(row => row.code === 'MISSING_COMPONENT_SCRIPT'));
      for (const action of ['apply', 'restore']) await assert.rejects(call('prefab.change.plan', { nodeId: reopenedId, action }), { code: 'VERIFICATION_FAILED' });
      checks.push('native missing script makes comparison incomplete and blocks apply/restore');
    } catch (error) { failure = CocosError.from(error).toJSON(); }
    finally {
      if (created && previous) try { await call('scene.open', { uuid: previous }); } catch (error) { failure ??= CocosError.from(error).toJSON(); }
      const bytes = await readFile(join(directory, 'calls.json'));
      await writeFile(join(directory, 'summary.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', project, checks, failure: failure ?? null,
        installedBuildId: installed.buildId, installedSourceFingerprint: installed.sourceFingerprint,
        callsSha256: createHash('sha256').update(bytes).digest('hex'), retained: 'Own scene and Prefab retained as evidence; own script intentionally deleted through AssetDB for missing-script acceptance.' }, null, 2));
      console.log(JSON.stringify({ directory, checks, failure: failure ?? null }));
      if (failure) process.exitCode = 1;
    }
  }
}
const project = process.argv[2];
if (!project) throw new Error('Usage: prefab-component-native-acceptance <isolated-Creator-3-project>');
await new PrefabComponentNativeAcceptance().run(resolve(project));
