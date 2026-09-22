import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { CocosApplication, ProjectRegistry, ProjectPaths } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';

class ShaderRuntimeSmoke {
  async run(projectRoot: string, materialUrl: string): Promise<void> {
    const registry = new ProjectRegistry(); await registry.add(projectRoot); const projectId = registry.list().rows[0]!.projectId;
    const gateway = new RuntimeGateway(registry); const port = await gateway.start();
    const application = new CocosApplication(registry, undefined, undefined, false, gateway);
    const prefix = `MCP_Shader_Runtime_${randomBytes(4).toString('hex')}`;
    const paths = await ProjectPaths.open(projectRoot); const logRoot = await paths.work('logs', `shader/${prefix}`);
    const rows: JsonObject[] = [];
    const call = async (capabilityId: string, params: JsonObject = {}): Promise<JsonObject> => {
      const response = await application.execute({ projectId, capabilityId, params }); const result = Json.object(response.result);
      const summary = Json.object(Json.value(result));
      if (typeof summary.dataUrl === 'string') {
        const path = join(logRoot, `capture-${rows.length}.png`);
        await writeFile(path, Buffer.from(summary.dataUrl.split(',')[1]!, 'base64')); delete summary.dataUrl; summary.imagePath = path;
      }
      rows.push({ capabilityId, result: summary }); console.log(capabilityId); return result;
    };
    let previousScene: string | null = null;
    try {
      const before = await call('scene.query');
      assert.equal(before.dirty, false, 'Save the current scene before running this test');
      const scene = Json.object(before.scene); const sceneId = typeof scene.sceneId === 'string' ? scene.sceneId : '';
      if (sceneId) { const resolved = await call('asset.resolve', { reference: sceneId }); if (resolved.url) previousScene = sceneId; }
      const sceneUrl = Json.string((await call('asset.location', { url: `db://assets/${prefix}.scene` })).url, 'scene URL');
      await call('scene.create', { url: sceneUrl });
      const resolved = await call('asset.resolve', { reference: materialUrl }); const materialUuid = Json.string(resolved.uuid, 'material UUID');
      const meshUrl = Json.string((await call('asset.location', { url: `db://assets/${prefix}.gltf` })).url, 'mesh URL');
      const geometry = await call('geometry.create', { name: 'Shader Sphere', shape: 'sphere', url: meshUrl, materialUuid, options: { radius: 0.8, segments: 32 } });
      await call('material.assign', { componentId: geometry.componentId!, materialUuid, expectedMaterialUuid: materialUuid });
      const cameraNode = await call('node.create', { name: 'Shader Camera' });
      await call('node.set', { nodeId: cameraNode.nodeId!, properties: { position: { x: 0, y: 0, z: 3 } } });
      await call('component.add', { nodeId: cameraNode.nodeId!, type: 'cc.Camera' });
      await call('scene.save'); await call('preview.start', { width: 640, height: 480, visible: false });
      let connected = false;
      for (let retry = 0; retry < 15 && !connected; retry++) {
        try { await call('shader.preview.connect', { gatewayPort: port }); connected = true; }
        catch (error) { if (retry === 14) throw error; await setTimeout(1000); }
      }
      const inspected = await call('runtime.material.inspect', { componentId: geometry.componentId! }); assert.equal(inspected.effectUuid !== null, true);
      await call('runtime.material.update', { componentId: geometry.componentId!, properties: { tint: { type: 'color', value: [255, 50, 180, 255] } } });
      await call('runtime.material.reset', { componentId: geometry.componentId! });
      await call('runtime.shader.preview.open', { materialUuid, shape: 'sphere', width: 256, height: 256 });
      const first = await call('runtime.shader.preview.capture'); assert.equal(first.uniformImage, false);
      await call('runtime.shader.preview.update', { properties: { tint: { type: 'color', value: [255, 50, 180, 255] } } });
      const second = await call('runtime.shader.preview.capture'); assert.equal(second.uniformImage, false);
      const comparison = await call('runtime.shader.preview.compare', { baselineId: first.baselineId!, tolerance: 0 }); assert.ok(Number(comparison.meanError) > 0);
      await call('runtime.shader.profile', { frames: 8 }); await call('runtime.shader.preview.close');
      await writeFile(join(logRoot, 'report.json'), JSON.stringify({ status: 'passed', prefix, rows }, null, 2));
      console.log(JSON.stringify({ status: 'passed', logRoot }));
    } catch (error) {
      await writeFile(join(logRoot, 'report.json'), JSON.stringify({ status: 'failed', prefix, error: CocosError.from(error).toJSON(), rows }, null, 2));
      console.error(JSON.stringify({ status: 'failed', logRoot, error: CocosError.from(error).toJSON() })); process.exitCode = 1;
    } finally {
      try { await call('preview.stop'); } catch (error) { console.error(CocosError.from(error).message); }
      if (previousScene) { try { await call('scene.open', { uuid: previousScene }); } catch (error) { console.error(CocosError.from(error).message); } }
      await gateway.close();
    }
  }
}

const [project, material] = process.argv.slice(2);
if (!project || !material) throw new Error('Pass test project path and the unlit sample material db:// URL');
await new ShaderRuntimeSmoke().run(project, material);
