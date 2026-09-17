import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';

class Creator2Acceptance {
  async run(): Promise<void> {
    const project = resolve('.codex-work/build/creator2-test-project'), output = resolve('.codex-work/logs/creator2-native'); await mkdir(output, { recursive: true });
    const registry = new ProjectRegistry(), { projectId } = await registry.add(project), gateway = new RuntimeGateway(registry), gatewayPort = await gateway.start();
    let ownedPreview = false;
    const app = new CocosApplication(registry, undefined, undefined, true, gateway), rows: JsonObject[] = [];
    const record = async (): Promise<void> => writeFile(join(output, 'report.json'), JSON.stringify({ project, version: '2.4.15', rows }, null, 2));
    const call = async (id: string, params: JsonObject = {}): Promise<JsonObject> => {
      try { const result = Json.object((await app.execute({ projectId, capabilityId: id, params })).result); rows.push({ id, passed: true, result }); await record(); console.log(`PASS ${id}`); return result; }
      catch (error) { rows.push({ id, passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); await record(); throw error; }
    };
    try {
      const status = await call('editor.status'); assert.equal(status.editorVersion, '2.4.15');
      const location = await call('asset.location', { url: 'db://assets/Creator2Coverage.fire' });
      const query = await call('scene.query');
      if (query.dirty) await call('scene.save');
      if (location.targetExists) await call('scene.open', { uuid: (await call('asset.resolve', { reference: location.url! })).uuid! });
      else await call('scene.create', { url: location.url! });
      const sceneId = Json.object((await call('scene.query')).scene).sceneId!;
      const previousRows = (await call('scene.hierarchy', { rootId: sceneId, limit: 1000 })).rows as JsonObject[];
      for (const row of previousRows) if (row.parentId === sceneId && /^Coverage-[0-9]+$/.test(String(row.name))) await call('node.set', { nodeId: row.nodeId!, properties: { active: false } });
      const name = `Coverage-${Date.now()}`;
      const created = await call('node.create', { parentId: sceneId, name }); const nodeId = created.nodeId!;
      assert.equal((await call('scene.query')).dirty, true);
      await call('node.set', { nodeId, properties: { position: { x: 10, y: 20, z: 0 }, width: 160, height: 90, opacity: 220 } });
      await call('scene.undo'); assert.equal(Json.object(Json.object((await call('node.query', { nodeId })).node).position).x, 0);
      await call('scene.redo'); assert.equal(Json.object(Json.object((await call('node.query', { nodeId })).node).position).x, 10);
      const canvasId = (await call('component.add', { nodeId, type: 'cc.Canvas' })).componentId!;
      await call('component.set', { componentId: canvasId, properties: { designResolution: { width: 800, height: 600 }, fitWidth: true, fitHeight: true } });
      const document: JsonObject = { version: 1, root: { key: 'root', name: 'CoverageUi', components: [{ type: 'cc.UITransform', properties: { contentSize: { width: 300, height: 200 } } }, { type: 'cc.UIOpacity', properties: { opacity: 230 } }], children: [{ key: 'text', name: 'Title', components: [{ type: 'cc.Label', properties: { string: 'Creator 2.4.15 Coverage', fontSize: 24 } }] }, { key: 'button', name: 'Button', position: { x: 0, y: -60, z: 0 }, components: [{ type: 'cc.UITransform', properties: { contentSize: { width: 180, height: 50 } } }, { type: 'cc.Button', properties: { interactable: true } }] }] } };
      const plan = await call('ui.plan', { parentId: nodeId, document });
      const built = await call('ui.build', { parentId: nodeId, document, planHash: plan.planHash! });
      await call('ui.inspect_layout', { rootId: built.rootId! }); await call('ui.validate_interaction', { rootId: built.rootId! });
      const diff = await call('ui.diff', { rootId: built.rootId!, document, mapping: built.rows! });
      await call('ui.apply', { rootId: built.rootId!, document, mapping: built.rows!, planHash: diff.planHash! });
      const imageLocation = await call('asset.location', { url: 'db://assets/Creator2Fixture.png' });
      if (!imageLocation.targetExists) {
        const downloads = join(project, '.codex-work/downloads'); await mkdir(downloads, { recursive: true });
        const sourcePath = join(downloads, 'Creator2Fixture.png'); await copyFile('/Applications/Cocos/Creator/2.4.15/CocosCreator.app/Contents/Resources/static/default-assets/image/default_btn_normal.png', sourcePath);
        await call('asset.import', { sourcePath, targetUrl: imageLocation.url! });
      }
      const imageMeta = Json.object((await call('spriteframe.inspect', { url: imageLocation.url! })).meta);
      const spriteMeta = Object.values(Json.object(imageMeta.subMetas)).map(Json.object).find(row => row.importer === 'sprite-frame'); assert.ok(spriteMeta);
      const textureParams = { url: imageLocation.url!, settings: { minfilter: 'nearest', magfilter: 'nearest' } };
      const texturePlan = await call('texture.plan_import', textureParams);
      const textureChanged = await call('texture.apply_import', { ...textureParams, planHash: texturePlan.planHash! });
      if (textureChanged.changed) await call('texture.restore_import', { url: imageLocation.url!, backupId: textureChanged.backupId!, expectedHash: textureChanged.expectedHash! });
      const borderParams = { url: imageLocation.url!, spriteFrameUuid: spriteMeta.uuid!, settings: { borderLeft: 4, borderRight: 4, borderTop: 4, borderBottom: 4 } };
      const borderPlan = await call('spriteframe.plan', borderParams), borderChanged = await call('spriteframe.apply', { ...borderParams, planHash: borderPlan.planHash! });
      if (borderChanged.changed) await call('spriteframe.restore', { url: imageLocation.url!, backupId: borderChanged.backupId!, expectedHash: borderChanged.expectedHash! });
      const spriteId = (await call('component.add', { nodeId: built.rootId!, type: 'cc.Sprite' })).componentId!;
      await call('component.set', { componentId: spriteId, properties: { spriteFrame: { uuid: spriteMeta.uuid! }, type: 1, sizeMode: 0 } });
      const clipLocation = await call('asset.location', { url: `db://assets/${name}.anim` });
      const clip = await call('animation.clip.create', { url: clipLocation.url!, rootId: built.rootId!, document: { name: 'CoverageMotion', duration: 1, tracks: [{ path: '', property: 'position', keys: [{ time: 0, value: { x: 0, y: 0, z: 0 } }, { time: 1, value: { x: 100, y: 0, z: 0 } }] }] } });
      const sample = await call('animation.clip.sample', { uuid: clip.uuid!, time: 0.5 }); assert.equal(Json.object((sample.rows as JsonObject[])[0]!.value).x, 50);
      const source = await call('animation.clip.read', { url: clipLocation.url! });
      const patched = await call('animation.clip.patch', { url: clipLocation.url!, expectedHash: source.sourceHash!, patches: [{ trackIndex: 0, keys: [{ time: 0, value: { x: 0, y: 0, z: 0 } }, { time: 1, value: { x: 200, y: 0, z: 0 } }] }] });
      assert.equal(Json.object(((await call('animation.clip.sample', { uuid: clip.uuid!, time: 0.5 })).rows as JsonObject[])[0]!.value).x, 100);
      await call('animation.clip.restore', { url: clipLocation.url!, expectedHash: patched.sourceHash!, backupId: patched.backupId! });
      assert.equal(Json.object(((await call('animation.clip.sample', { uuid: clip.uuid!, time: 0.5 })).rows as JsonObject[])[0]!.value).x, 50);
      const twoDLocation = await call('asset.location', { url: `db://assets/${name}-2d.anim` });
      const twoDParams = { url: twoDLocation.url!, rootId: built.rootId!, document: { name: 'CoverageOpacity', duration: 1, tracks: [{ path: '', kind: 'opacity', keys: [{ time: 0, value: 255 }, { time: 1, value: 128 }] }] } };
      const twoDPlan = await call('animation2d.plan', twoDParams);
      await call('animation2d.create', { ...twoDParams, planHash: twoDPlan.planHash! });
      const animationId = (await call('component.add', { nodeId: built.rootId!, type: 'cc.Animation' })).componentId!;
      await call('component.set', { componentId: animationId, properties: { _clips: [{ uuid: clip.uuid! }], defaultClip: { uuid: clip.uuid! } } });
      await call('scene.save'); assert.equal((await call('scene.query')).dirty, false);
      await call('scene.open', { uuid: sceneId }); assert.equal((await call('node.find', { name })).total, 1);
      await call('scene.validate'); await call('asset.dependencies', { url: location.url! });
      if (!process.argv.includes('--editor-only')) {
        await call('preview.start', { width: 800, height: 600, visible: true }); ownedPreview = true;
        await call('shader.preview.connect', { gatewayPort });
        const runtime = await call('runtime.query'); assert.equal(runtime.engineVersion, '2.4.15');
        const runtimeUi = await call('runtime.ui.inspect', { rootId: built.rootId! });
        const runtimeComponents = (runtimeUi.rows as JsonObject[]).flatMap(row => row.components as JsonObject[]);
        const runtimeAnimationId = runtimeComponents.find(row => row.type === 'cc.Animation')!.componentId!;
        await call('runtime.render2d.audit', { rootId: built.rootId! }); await call('runtime.label.audit', { rootId: built.rootId! });
        await call('runtime.animation.play', { componentId: runtimeAnimationId, name: String(Json.object(clip.clip).name) });
        await call('runtime.animation.pause', { componentId: runtimeAnimationId, name: String(Json.object(clip.clip).name) });
        await call('runtime.animation.seek', { componentId: runtimeAnimationId, name: String(Json.object(clip.clip).name), time: 0.5 });
        await call('runtime.animation.stop', { componentId: runtimeAnimationId, name: String(Json.object(clip.clip).name) });
        const loaded = await call('runtime.asset.load', { uuid: clip.uuid! }); await call('runtime.asset.inspect', { handle: loaded.handle! }); await call('runtime.asset.release', { handle: loaded.handle! }); await call('runtime.bundle.inspect');
        await call('runtime.physics2d.inspect'); await call('runtime.atlas.inspect');
        const capture = await call('preview.capture'); await writeFile(join(output, 'preview.png'), Buffer.from(String(capture.dataUrl).split(',')[1]!, 'base64')); delete capture.dataUrl;
        await call('preview.input', { action: 'key', x: 0, y: 0, key: 'Space', durationMs: 10 });
        await call('preview.resize', { width: 390, height: 844 }); await call('preview.stop'); ownedPreview = false;
      }
    } finally { try { if (ownedPreview) await call('preview.stop'); } finally { await record(); await gateway.close(); } }
  }
}
await new Creator2Acceptance().run();
