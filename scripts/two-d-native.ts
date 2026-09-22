import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { Json, CocosError, type JsonObject } from '../packages/contracts/src/index.js';

class TwoDNativeAcceptance {
  async run(project: string, builtinImage: string): Promise<void> {
    const registry = new ProjectRegistry(), { projectId } = await registry.add(project), gateway = new RuntimeGateway(registry), gatewayPort = await gateway.start();
    // 仅本脚本在独立样例中调用固定原生方法，不扩大常驻服务权限。
    const app = new CocosApplication(registry, undefined, undefined, true, gateway), rows: JsonObject[] = [];
    let previous: string | undefined, sceneId: string | undefined, ownedPreview = false, failure: unknown;
    const call = async (id: string, params: JsonObject = {}): Promise<JsonObject> => {
      const result = Json.object((await app.execute({ projectId, capabilityId: id, params })).result);
      rows.push({ id, result }); return result;
    };
    const hierarchy = async (rootId: string): Promise<JsonObject[]> => (await call('scene.hierarchy', { rootId, includeComponents: true, limit: 1000 })).rows as JsonObject[];
    const node = async (parentId: string, name: string): Promise<string> => {
      const matches = (await hierarchy(parentId)).filter(row => row.parentId === parentId && row.name === name);
      assert.ok(matches.length <= 1); if (matches.length) return String(matches[0]!.nodeId);
      return String((await call('node.create', { parentId, name })).nodeId);
    };
    const component = async (nodeId: string, type: string): Promise<string> => {
      const root = (await hierarchy(nodeId)).find(row => row.nodeId === nodeId)!;
      const found = (root.components as JsonObject[]).find(row => row.type === type);
      if (found) return String(found.componentId);
      await call('component.add', { nodeId, type });
      const refreshed = (await hierarchy(nodeId)).find(row => row.nodeId === nodeId)!;
      const actual = (refreshed.components as JsonObject[]).find(row => row.type === type); assert.ok(actual);
      return String(actual.componentId);
    };
    const capture = async (name: string): Promise<void> => {
      const result = await call('preview.capture');
      const path = resolve('.codex-work/build', `two-d-${name}.png`);
      await writeFile(path, Buffer.from(String(result.dataUrl).split(',')[1]!, 'base64')); delete result.dataUrl; rows.push({ capture: name, path });
    };
    try {
      const initial = await call('scene.query'); assert.equal(initial.dirty, false); previous = String(Json.object(initial.scene).sceneId);
      assert.equal((await call('preview.status')).running, false);
      const location = await call('asset.location', { url: 'db://assets/McpTwoDAcceptance.scene' });
      if (location.targetExists) await call('scene.open', { uuid: (await call('asset.resolve', { reference: location.url! })).uuid! });
      else await call('scene.create', { url: location.url! });
      sceneId = String(Json.object((await call('scene.query')).scene).sceneId);
      const canvas = await node(sceneId, 'Canvas'), canvasId = await component(canvas, 'cc.Canvas');
      await component(canvas, 'cc.UITransform');
      await call('node.set', { nodeId: canvas, properties: { layer: 33554432 } });
      const cameraNode = await node(canvas, 'Camera'), cameraId = await component(cameraNode, 'cc.Camera');
      await call('node.set', { nodeId: cameraNode, properties: { position: { x: 0, y: 0, z: 1000 } } });
      await call('component.set', { componentId: cameraId, properties: { projection: 0, orthoHeight: 300, visibility: 33554432, near: 1, far: 2000 } });
      await call('component.set', { componentId: canvasId, properties: { cameraComponent: { uuid: cameraId }, alignCanvasWithScreen: true } });
      const existingMenu = (await hierarchy(canvas)).find(row => row.parentId === canvas && row.name === 'TwoDMenu');
      let menu: string;
      if (existingMenu) menu = String(existingMenu.nodeId);
      else {
        const params = { parentId: canvas, kind: 'menu', name: 'TwoDMenu', width: 340, height: 300 };
        const plan = await call('ui.template.plan', params); menu = String((await call('ui.template.build', { ...params, planHash: plan.planHash! })).rootId);
      }
      await call('node.set', { nodeId: menu, properties: { position: { x: 0, y: 0, z: 0 } } });
      const scriptNode = await node(canvas, 'UiBehaviour');
      const scriptLocation = await call('asset.location', { url: 'db://assets/McpTwoDPanel.ts' });
      if (!scriptLocation.targetExists) {
        const params = { template: 'ui', className: 'McpTwoDPanel', nodeId: menu, url: scriptLocation.url! };
        const plan = await call('gameplay2d.plan', params); await call('gameplay2d.apply', { ...params, planHash: plan.planHash! });
      } else await component(menu, 'McpTwoDPanel');
      await call('node.set', { nodeId: scriptNode, properties: { active: false } });
      const pictureLocation = await call('asset.location', { url: 'db://assets/McpTwoDFrame.png' });
      if (!pictureLocation.targetExists) {
        const downloads = join(project, '.codex-work/downloads'); await mkdir(downloads, { recursive: true });
        const sourcePath = join(downloads, 'McpTwoDFrame.png'); await copyFile(builtinImage, sourcePath);
        await call('asset.import', { sourcePath, targetUrl: pictureLocation.url! });
      }
      let inspected = await call('spriteframe.inspect', { url: pictureLocation.url! });
      if (Json.object(Json.object(inspected.meta).userData).type !== 'sprite-frame') {
        await call('asset.set_meta', { url: pictureLocation.url!, userData: { type: 'sprite-frame' } });
        inspected = await call('spriteframe.inspect', { url: pictureLocation.url! });
      }
      const spriteMeta = Object.values(Json.object(Json.object(inspected.meta).subMetas)).map(Json.object).find(row => row.importer === 'sprite-frame'); assert.ok(spriteMeta);
      const frameUuid = String(spriteMeta.uuid), edge = Json.object(spriteMeta.userData).borderLeft === 8 ? 10 : 8;
      const imageParams = { url: pictureLocation.url!, spriteFrameUuid: frameUuid, settings: { borderLeft: edge, borderRight: 8, borderTop: 8, borderBottom: 8 } };
      const borderPlan = await call('spriteframe.plan', imageParams), edited = await call('spriteframe.apply', { ...imageParams, planHash: borderPlan.planHash! });
      if (edited.changed) await call('spriteframe.restore', { url: pictureLocation.url!, backupId: edited.backupId!, expectedHash: edited.expectedHash! });
      const spriteNode = await node(canvas, 'AnimatedSprite'), spriteId = await component(spriteNode, 'cc.Sprite');
      await component(spriteNode, 'cc.UIOpacity'); await component(spriteNode, 'cc.UITransform');
      await call('node.set', { nodeId: spriteNode, properties: { layer: 33554432, position: { x: 0, y: 210, z: 0 } } });
      await call('component.set', { componentId: spriteId, properties: { spriteFrame: { uuid: frameUuid }, sizeMode: 0, type: 1 } });
      await call('component.set', { componentId: await component(spriteNode, 'cc.UITransform'), properties: { contentSize: { width: 120, height: 120 } } });
      const physicsNode = await node(sceneId, 'PhysicsProbe');
      await call('node.set', { nodeId: physicsNode, properties: { position: { x: 0, y: 0, z: 0 } } });
      const colliderId = await component(physicsNode, 'cc.BoxCollider2D');
      await call('component.set', { componentId: colliderId, properties: { size: { width: 100, height: 100 } } });
      const animLocation = await call('asset.location', { url: 'db://assets/McpTwoDColor.anim' });
      let clipUuid: string;
      if (!animLocation.targetExists) {
        const document = { name: 'McpTwoDColor', duration: 1, loop: true, tracks: [
          { path: '', kind: 'spriteFrame', keys: [{ time: 0, value: frameUuid }] },
          { path: '', kind: 'opacity', keys: [{ time: 0, value: 255 }, { time: 0.5, value: 100 }, { time: 1, value: 255 }] },
          { path: '', kind: 'color', keys: [{ time: 0, value: { r: 80, g: 170, b: 255, a: 255 } }, { time: 1, value: { r: 255, g: 140, b: 60, a: 255 } }] },
        ] };
        const params = { url: animLocation.url!, rootId: spriteNode, document }, plan = await call('animation2d.plan', params);
        clipUuid = String(Json.object((await call('animation2d.create', { ...params, planHash: plan.planHash! })).asset).uuid);
      } else clipUuid = String((await call('asset.resolve', { reference: animLocation.url! })).uuid);
      const animId = await component(spriteNode, 'cc.Animation');
      await call('component.set', { componentId: animId, properties: { clips: [{ uuid: clipUuid }], defaultClip: { uuid: clipUuid }, playOnLoad: true } });
      await call('scene.save');
      await call('scene.open', { uuid: previous }); await call('scene.open', { uuid: sceneId });
      assert.equal((await call('scene.query')).dirty, false);
      const clip = await call('animation.clip.inspect', { uuid: clipUuid }); assert.equal((clip.rows as unknown[]).length, 3);
      await call('preview.start', { width: 800, height: 600, visible: true }); ownedPreview = true;
      for (let attempt = 0; attempt < 8; attempt++) { try { await call('shader.preview.connect', { gatewayPort }); break; } catch (error) { if (attempt === 7) throw error; await delay(500); } }
      await call('runtime.ui.inspect', { rootId: canvas }); await call('runtime.ui.hit_test', { rootId: canvas, x: 400, y: 370 });
      await call('runtime.render2d.audit', { rootId: canvas }); await call('runtime.label.audit', { rootId: canvas }); await call('runtime.atlas.inspect');
      const subscription = await call('runtime.subscribe', { target: `node:${menu}`, event: 'ui-action' });
      await call('preview.input', { action: 'click', x: 400, y: 230 });
      const events = await call('runtime.events', { subscriptionId: subscription.subscriptionId! });
      assert.ok((events.rows as unknown[]).length > 0, 'Menu click must emit real ui-action');
      await call('runtime.unsubscribe', { subscriptionId: subscription.subscriptionId! });
      await call('preview.input', { action: 'drag', x: 390, y: 300, endX: 440, endY: 340, durationMs: 100, steps: 4 });
      await call('preview.input', { action: 'touch_cancel', x: 390, y: 300, endX: 440, endY: 340, durationMs: 100, steps: 4 });
      await call('preview.input', { action: 'key', x: 0, y: 0, key: 'Space', durationMs: 10 });
      await capture('desktop');
      const captures = await call('preview.validate_viewports', { rows: [{ width: 390, height: 844 }, { width: 1024, height: 768 }] });
      for (const [index, value] of (captures.rows as JsonObject[]).entries()) { const path = resolve('.codex-work/build', `two-d-viewport-${index}.png`); await writeFile(path, Buffer.from(String(value.dataUrl).split(',')[1]!, 'base64')); delete value.dataUrl; value.imagePath = path; }
      await call('runtime.physics2d.inspect');
      await call('runtime.get', { target: 'cc.PhysicsSystem2D', path: 'PHYSICS_BOX2D' });
      await call('runtime.get', { target: 'cc.PhysicsSystem2D', path: 'instance.physicsWorld' });
      const point = await call('runtime.physics2d.test_point', { point: { x: 0, y: 0 } });
      assert.ok((point.rows as JsonObject[]).some(row => row.nodeId === physicsNode));
      await call('runtime.physics2d.test_aabb', { x: 0, y: 0, width: 100, height: 100 });
      await call('runtime.set', { target: `component:${colliderId}`, path: 'enabled', value: false });
      assert.equal((await call('runtime.physics2d.test_point', { point: { x: 0, y: 0 } })).total, 0);
      await call('runtime.set', { target: `component:${colliderId}`, path: 'enabled', value: true });
      const logs = await call('preview.logs'); assert.equal((logs.rows as unknown[]).length, 0, 'Preview must not report errors');
      rows.push({ check: 'native-2d-core', passed: true, screenshotReviewRequired: true });
    } catch (error) { failure = error; rows.push({ error: CocosError.from(error).toJSON() }); }
    finally {
      try { if (ownedPreview) await call('preview.stop'); if (sceneId && previous) { await call('scene.save'); await call('scene.open', { uuid: previous }); } }
      catch (error) { failure ??= error; rows.push({ restorationError: CocosError.from(error).toJSON() }); }
      await gateway.close();
      const path = resolve('.codex-work/logs/two-d-native.json'); await writeFile(path, JSON.stringify({ passed: !failure, sceneId, previous, rows }, null, 2)); console.log(path);
    }
    if (failure) throw failure;
  }
}
const [project, builtinImage] = process.argv.slice(2);
if (!project || !builtinImage) throw new Error('Usage: two-d-native <test-project> <installed-engine-default-image>');
await new TwoDNativeAcceptance().run(resolve(project), resolve(builtinImage));
