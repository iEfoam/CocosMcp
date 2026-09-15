import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { Json, CocosError, type JsonObject } from '../packages/contracts/src/index.js';

class NativeSmoke {
  async run(project: string): Promise<void> {
    const registry = new ProjectRegistry(); const { projectId } = await registry.add(project);
    const gateway = new RuntimeGateway(registry); const port = await gateway.start();
    const app = new CocosApplication(registry, undefined, undefined, false, gateway);
    const report = join(process.cwd(), '.codex-work/logs', `native-roadmap-${randomUUID()}.json`), rows: JsonObject[] = [];
    const call = async (capabilityId: string, params: JsonObject = {}): Promise<JsonObject> => {
      const response = await app.execute({ projectId, capabilityId, params }); const result = Json.object(response.result);
      const recorded = { ...result };
      if (typeof recorded.dataUrl === 'string') {
        const imagePath = report.replace('.json', `-${rows.length}.png`);
        await writeFile(imagePath, Buffer.from(recorded.dataUrl.split(',')[1]!, 'base64'));
        recorded.imagePath = imagePath; delete recorded.dataUrl;
      }
      rows.push({ capabilityId, result: recorded }); console.log(capabilityId); return result;
    };
    let previous: string | undefined, previewOwned = false, failure: unknown;
    try {
      const initial = await call('scene.query'); assert.equal(initial.dirty, false, 'Current scene must be saved');
      previous = Json.string(Json.object(initial.scene).sceneId, 'previous scene');
      assert.equal((await call('preview.status')).running, false, 'An existing preview must not be replaced');
      const sceneUrl = Json.string((await call('asset.location', { url: `db://assets/MCP_Roadmap_${randomUUID().slice(0, 8)}.scene` })).url, 'scene URL');
      await call('scene.create', { url: sceneUrl });
      const parent = await call('node.create', { name: 'Native UI Test Container' });
      const document: JsonObject = { version: 1, root: { key: 'label', name: 'NativeLabel', components: [{ type: 'cc.UITransform', properties: { contentSize: { width: 320, height: 80 } } }, { type: 'cc.Label', properties: { string: 'Native Before', fontSize: 24, overflow: 1 } }] } };
      const params = { parentId: parent.nodeId!, document };
      const plan = await call('ui.plan', params), built = await call('ui.build', { ...params, planHash: plan.planHash! });
      const mapping = built.rows!, rootId = built.rootId!;
      const afterDocument = JSON.parse(JSON.stringify(document)) as JsonObject;
      const root = Json.object(afterDocument.root); (root.components as JsonObject[])[1]!.properties = { string: 'Native After', fontSize: 24, overflow: 1 };
      const update = { rootId, mapping, document: afterDocument };
      const diff = await call('ui.diff', update); assert.equal((diff.blocked as unknown[]).length, 0);
      await call('ui.apply', { ...update, planHash: diff.planHash! });
      await call('scene.save');
      const sceneId = Json.string((await call('asset.resolve', { reference: sceneUrl })).uuid, 'test scene');
      await call('scene.open', { uuid: previous }); await call('scene.open', { uuid: sceneId });
      const persisted = await call('ui.diff', update); assert.equal((persisted.rows as unknown[]).length, 0); assert.equal((persisted.blocked as unknown[]).length, 0);
      rows.push({ check: 'ui-save-reopen-uuid-and-properties', passed: true });
      await call('ui.validate_interaction', { rootId });
      await call('preview.start', { width: 640, height: 480, visible: false }); previewOwned = true;
      let connected = false;
      for (let i = 0; i < 10 && !connected; i++) {
        try { await call('shader.preview.connect', { gatewayPort: port }); connected = true; }
        catch (error) { if (i === 9) throw error; await setTimeout(1000); }
      }
      await call('preview.resize', { width: 800, height: 600 });
      await call('runtime.graphics.inspect'); await call('runtime.graphics.formats', { formats: ['RGBA8', 'RGBA16F'] });
      await call('runtime.physics2d.inspect'); await call('runtime.physics3d.inspect');
    } catch (error) { failure = error; }
    finally {
      if (previewOwned) { try { await call('preview.stop'); } catch (error) { failure ??= error; } }
      if (previous) {
        try { if ((await call('scene.query')).dirty === false) await call('scene.open', { uuid: previous }); else rows.push({ restore: 'skipped-dirty-scene-left-for-review' }); }
        catch (error) { failure ??= error; }
      }
      await gateway.close();
      await writeFile(report, JSON.stringify({ status: failure ? 'failed' : 'passed', sourceFingerprint: process.env.COCOS_NATIVE_SOURCE_FINGERPRINT ?? null, installedBuildId: JSON.parse(await readFile(join(project, 'extensions/cocos-mcp-creator3/package.json'), 'utf8')).buildId, rows, ...(failure ? { error: CocosError.from(failure).toJSON() } : {}), limitations: ['No business click callback or physical device acceptance'] }, null, 2));
    }
    console.log(JSON.stringify({ report, status: failure ? 'failed' : 'passed' })); if (failure) { console.error(CocosError.from(failure).toJSON()); process.exitCode = 1; }
  }
}
const project = process.argv[2]; if (!project) throw new Error('Provide the explicitly authorized Creator test project');
await new NativeSmoke().run(project);
