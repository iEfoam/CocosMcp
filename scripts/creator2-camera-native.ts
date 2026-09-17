import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';

const project = resolve('.codex-work/build/creator2-test-project'), registry = new ProjectRegistry(), { projectId } = await registry.add(project);
const gateway = new RuntimeGateway(registry), gatewayPort = await gateway.start(), app = new CocosApplication(registry, undefined, undefined, true, gateway);
const rows: JsonObject[] = []; let preview = false;
const call = async (id: string, params: JsonObject = {}): Promise<JsonObject> => { const result = Json.object((await app.execute({ projectId, capabilityId: id, params })).result); rows.push({ id, result }); console.log(`PASS ${id}`); return result; };
try {
  const old = (await call('scene.hierarchy', { limit: 2000 })).rows as JsonObject[];
  for (const row of old) if (String(row.name).startsWith('CameraCoverage-')) await call('node.set', { nodeId: row.nodeId!, properties: { active: false } });
  const scene = Json.object((await call('scene.query')).scene).sceneId!;
  const root = (await call('node.create', { parentId: scene, name: `CameraCoverage-${Date.now()}` })).nodeId!;
  await call('node.set', { nodeId: root, properties: { position: { x: 120, y: 80, z: 0 } } });
  const camera = (await call('component.add', { nodeId: root, type: 'cc.Camera' })).componentId!;
  await call('component.set', { componentId: camera, properties: { zoomRatio: 2, alignWithScreen: true, cullingMask: 0 } });
  const maskNode = (await call('node.create', { parentId: scene, name: `CameraCoverage-Pixels-${Date.now()}` })).nodeId!;
  await call('node.set', { nodeId: maskNode, properties: { position: { x: 120, y: 80, z: 0 }, width: 100, height: 100 } });
  await call('component.add', { nodeId: maskNode, type: 'cc.Mask' });
  const graphicNode = (await call('node.create', { parentId: maskNode, name: 'GreenGeometry' })).nodeId!;
  await call('component.add', { nodeId: graphicNode, type: 'cc.Graphics' });
  await call('scene.save'); await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const hierarchy = (await call('runtime.hierarchy', { limit: 2000 })).rows as JsonObject[];
  const componentId = ((hierarchy.find(row => row.nodeId === root)!.components as JsonObject[]).find(row => row.type === 'cc.Camera'))!.componentId!;
  const state = await call('runtime.camera.inspect', { componentId });
  assert.equal(state.zoomRatio, 2); assert.equal(state.is3D, false); assert.equal(state.alignWithScreen, true);
  await call('runtime.set', { target: `component:${componentId}`, path: 'backgroundColor', value: { $type: 'cc.Color', args: [255, 0, 0, 255] } });
  await call('runtime.set', { target: `component:${componentId}`, path: 'clearFlags', value: 7 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const pixels = await call('runtime.camera.sample_pixels', { componentId, width: 32, height: 32, points: [{ x: 0, y: 0 }, { x: 16, y: 16 }, { x: 31, y: 31 }] });
    for (const row of pixels.rows as JsonObject[]) assert.deepEqual(row.rgba, [255, 0, 0, 255]);
    assert.equal(pixels.targetRestored, true); assert.equal(pixels.temporaryResourcesDestroyed, true);
    assert.equal(pixels.gpuObjectDeletionVerified, true);
    assert.equal((await call('runtime.camera.inspect', { componentId })).targetTexture, null);
  }
  const point = { x: 170, y: 105 }, center = Json.object(Json.object(state.visibleRect).center);
  const screen = await call('runtime.camera.convert', { componentId, direction: 'world-to-screen', point });
  const screenPoint = Json.object(screen.point);
  assert.ok(Math.abs(Number(screenPoint.x) - Number(center.x) - 100) < 0.001);
  assert.ok(Math.abs(Number(screenPoint.y) - Number(center.y) - 50) < 0.001);
  const world = Json.object((await call('runtime.camera.convert', { componentId, direction: 'screen-to-world', point: screen.point! })).point);
  assert.ok(Math.abs(Number(world.x) - point.x) < 0.001); assert.ok(Math.abs(Number(world.y) - point.y) < 0.001);
  assert.equal((await call('runtime.camera.culling', { componentId, nodeId: root })).maskMatches, false);
  await call('runtime.set', { target: `component:${componentId}`, path: 'cullingMask', value: 1 });
  const included = await call('runtime.camera.culling', { componentId, nodeId: root });
  assert.equal(included.maskMatches, true); assert.equal(included.nativeContainsNode, true); assert.equal(included.visible, null);
  const graphicsId = ((hierarchy.find(row => row.nodeId === graphicNode)!.components as JsonObject[]).find(row => row.type === 'cc.Graphics'))!.componentId!;
  const maskId = ((hierarchy.find(row => row.nodeId === maskNode)!.components as JsonObject[]).find(row => row.type === 'cc.Mask'))!.componentId!;
  await call('runtime.set', { target: `component:${graphicsId}`, path: 'fillColor', value: { $type: 'cc.Color', args: [0, 255, 0, 255] } });
  await call('runtime.invoke', { target: `component:${graphicsId}`, method: 'rect', args: [-100, -100, 200, 200] });
  await call('runtime.invoke', { target: `component:${graphicsId}`, method: 'fill' });
  await call('runtime.shader.profile', { frames: 2, warmupFrames: 1 });
  const sample = { componentId, rootId: maskNode, width: 32, height: 32, points: [{ x: 16, y: 16 }, { x: 22, y: 16 }, { x: 0, y: 0 }] };
  const clipped = await call('runtime.camera.sample_pixels', sample);
  assert.deepEqual((clipped.rows as JsonObject[]).map(row => row.rgba), [[0, 255, 0, 255], [255, 0, 0, 255], [255, 0, 0, 255]]);
  await call('runtime.set', { target: `component:${maskId}`, path: 'enabled', value: false });
  const unclipped = await call('runtime.camera.sample_pixels', sample);
  assert.deepEqual((unclipped.rows as JsonObject[]).map(row => row.rgba), [[0, 255, 0, 255], [0, 255, 0, 255], [255, 0, 0, 255]]);
  await call('runtime.set', { target: `component:${maskId}`, path: 'enabled', value: true });
  await call('runtime.set', { target: `component:${maskId}`, path: 'inverted', value: true });
  const inverted = await call('runtime.camera.sample_pixels', sample);
  assert.deepEqual((inverted.rows as JsonObject[]).map(row => row.rgba), [[255, 0, 0, 255], [0, 255, 0, 255], [255, 0, 0, 255]]);
  await call('runtime.set', { target: `component:${maskId}`, path: 'inverted', value: false });
  await call('runtime.set', { target: `component:${graphicsId}`, path: 'fillColor', value: { $type: 'cc.Color', args: [0, 0, 255, 255] } });
  await call('runtime.invoke', { target: `component:${graphicsId}`, method: 'rect', args: [-100, 0, 200, 100] });
  await call('runtime.invoke', { target: `component:${graphicsId}`, method: 'fill' });
  const orientation = await call('runtime.camera.sample_pixels', { ...sample, points: [{ x: 16, y: 12 }, { x: 16, y: 20 }] });
  assert.deepEqual((orientation.rows as JsonObject[]).map(row => row.rgba), [[0, 255, 0, 255], [0, 0, 255, 255]]);
  const businessTarget = Json.object((await call('runtime.create', { type: 'cc.RenderTexture', args: [] })).object).handle!;
  await call('runtime.invoke', { target: businessTarget, method: 'initWithSize', args: [16, 16] });
  await call('runtime.set', { target: `component:${componentId}`, path: 'targetTexture', value: { $handle: businessTarget } });
  const preserved = await call('runtime.camera.sample_pixels', sample);
  assert.equal(preserved.targetRestored, true); assert.equal(preserved.gpuObjectDeletionVerified, true);
  assert.equal(Json.object((await call('runtime.get', { target: `component:${componentId}`, path: 'targetTexture' })).value).handle, businessTarget);
  assert.equal(Json.object((await call('runtime.camera.inspect', { componentId })).targetTexture).width, 16);
  await call('runtime.set', { target: `component:${componentId}`, path: 'targetTexture', value: null });
  await call('runtime.release', { target: businessTarget, destroy: true });
  await call('runtime.set', { target: `node:${maskNode}`, path: 'active', value: false });
  await call('runtime.set', { target: `component:${componentId}`, path: 'alignWithScreen', value: false });
  await assert.rejects(() => call('runtime.camera.convert', { componentId, direction: 'world-to-screen', point }), error => CocosError.from(error).code === 'UNSUPPORTED_CAPABILITY');
  await call('runtime.set', { target: `component:${componentId}`, path: 'alignWithScreen', value: true });
  await call('runtime.set', { target: `component:${componentId}`, path: 'alignWithScreen', value: false });
  await call('runtime.set', { target: `node:${root}`, path: 'is3DNode', value: true });
  await call('runtime.set', { target: `node:${root}`, path: 'position', value: { x: 0, y: 0, z: 10 } });
  for (const [path, value] of Object.entries({ nearClip: 1, farClip: 100, fov: 60, zoomRatio: 1, orthoSize: 5 })) await call('runtime.set', { target: `component:${componentId}`, path, value });
  for (const ortho of [false, true]) {
    await call('runtime.set', { target: `component:${componentId}`, path: 'ortho', value: ortho });
    for (const rect of [[0, 0, 1, 1], [0.25, 0.25, 0.5, 0.5]]) {
      await call('runtime.set', { target: `component:${componentId}`, path: 'rect', value: { $type: 'cc.Rect', args: rect } });
      await call('runtime.shader.profile', { frames: 2, warmupFrames: 1 });
      for (const worldPoint of [{ x: 1, y: -2, z: 0 }, { x: 0, y: 0, z: 9 }, { x: 0, y: 0, z: -89 }]) {
        const projected = await call('runtime.camera.convert', { componentId, direction: 'world-to-screen', point: worldPoint });
        const projectedPoint = Json.object(projected.point);
        // 裁剪边界的浮点误差只用于夹具归一化，不改变生产接口对输入深度的限制。
        projectedPoint.z = Math.min(1, Math.max(0, Number(projectedPoint.z)));
        const back = Json.object((await call('runtime.camera.convert', { componentId, direction: 'screen-to-world', point: projectedPoint })).point);
        for (const axis of ['x', 'y', 'z'] as const) assert.ok(Math.abs(Number(back[axis]) - worldPoint[axis]) < 0.01, JSON.stringify({ ortho, rect, worldPoint, back }));
        assert.equal(projected.dimension, 3); assert.equal(projected.screenDepthEncoding, 'projection-depth-0-to-1');
      }
    }
  }
  rows.push({ projection3DVerified: true, perspectiveAndOrthographic: true, fullAndPartialViewport: true });
  await call('runtime.set', { target: `node:${root}`, path: 'active', value: false });
  rows.push({ passed: true, assertions: 'native 2D camera, screen round trip, culling, clear pixels, Graphics with enabled/disabled/inverted rectangular Mask, bottom-left pixel origin, original render target identity, temporary GPU deletion', renderedPixelsVerified: true });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/camera.json'), JSON.stringify({ project, rows }, null, 2)); } }
