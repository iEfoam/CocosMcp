import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetQuery } from '../packages/creator3-adapter/src/asset-query.js';
import { PrimitiveGeometry, GeometryService } from '../packages/creator3-adapter/src/geometry.js';
import { RenderingService } from '../packages/creator3-adapter/src/rendering.js';
import { PreviewService } from '../packages/creator3-adapter/src/preview.js';
import { Creator3Adapter } from '../packages/creator3-adapter/src/index.js';
import { ManagedPreview, type PreviewWindow, type PreviewWindowFactory } from '../extensions/creator3/src/preview.js';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { CaptureResult } from '../apps/server/src/capture-result.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';
import type { JsonObject, JsonValue } from '../packages/contracts/src/index.js';

class AssetHarness {
  requests: unknown[] = [];
  port = { request: async (...args: unknown[]) => { this.requests.push(args); return [
    { uuid: 'directory', type: 'cc.Asset', isDirectory: true }, { uuid: 'image', type: 'cc.ImageAsset' },
    { uuid: 'cube-a', type: 'cc.TextureCube' }, { uuid: 'image-b', type: 'cc.ImageAsset' }, { uuid: 'cube-b', type: 'cc.TextureCube' },
  ]; } } as unknown as EditorPort;
}

test('AssetDB cc type filtering precedes pagination and preserves filtered totals', async () => {
  const h = new AssetHarness(), query = new AssetQuery(h.port);
  assert.deepEqual(await query.execute({ type: 'cc.TextureCube', limit: 1 }), { rows: [{ uuid: 'cube-a', type: 'cc.TextureCube' }], total: 2, nextOffset: 1 });
  assert.deepEqual(await query.execute({ type: 'cc.TextureCube', offset: 1, limit: 1 }), { rows: [{ uuid: 'cube-b', type: 'cc.TextureCube' }], total: 2, nextOffset: null });
  assert.deepEqual(await query.execute({ type: 'cc.Material' }), { rows: [], total: 0, nextOffset: null });
  assert.equal((await query.execute({}) as JsonObject).total, 5);
  await assert.rejects(query.execute({ offset: -1 }), /pagination/);
});

class MeshInspection {
  inspect(shape: string, options: JsonObject): { positions: Float32Array; normals: Float32Array; indices: Uint16Array; min: number[]; max: number[] } {
    const built = new PrimitiveGeometry().build(shape, options), gltf = JSON.parse(built.content);
    const buffer = Buffer.from(gltf.buffers[0].uri.split(',')[1], 'base64');
    const read = (index: number): ArrayBuffer => { const view = gltf.bufferViews[index]; return Uint8Array.from(buffer.subarray(view.byteOffset, view.byteOffset + view.byteLength)).buffer; };
    const positions = new Float32Array(read(0)), normals = new Float32Array(read(1)), indices = new Uint16Array(read(3));
    assert.equal(buffer.length, gltf.buffers[0].byteLength); assert.equal(positions.length / 3, built.vertices); assert.equal(indices.length / 3, built.triangles);
    assert.equal(gltf.accessors[2].count, built.vertices);
    assert.ok([...positions, ...normals].every(Number.isFinite)); assert.ok([...indices].every(index => index < built.vertices));
    for (let i = 0; i < normals.length; i += 3) assert.ok(Math.abs(Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) - 1) < 1e-5);
    // 检查非退化三角形的绕序和法线一致，捕获看似导入成功但被背面剔除的网格。
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i]!, indices[i + 1]!, indices[i + 2]!].map(index => index * 3);
      const u = [0, 1, 2].map(k => positions[b! + k]! - positions[a! + k]!), w = [0, 1, 2].map(k => positions[c! + k]! - positions[a! + k]!);
      const cross = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      const dot = cross.reduce((sum, v, k) => sum + v * (normals[a! + k]! + normals[b! + k]! + normals[c! + k]!), 0);
      assert.ok(dot > -1e-8, `${shape}: inward triangle ${i / 3}`);
    }
    return { positions, normals, indices, min: gltf.accessors[0].min, max: gltf.accessors[0].max };
  }
}

test('primitive meshes have finite attributes, valid indices and outward winding', () => {
  const h = new MeshInspection();
  for (const shape of ['cube', 'sphere', 'cylinder', 'torus']) h.inspect(shape, {});
  const cube = h.inspect('cube', { size: { x: 12, y: 0.4, z: 8 }, bevel: 0.06 });
  assert.deepEqual(cube.min, [-6, -0.2, -4]); assert.deepEqual(cube.max, [6, 0.2, 4]);
  const ring = h.inspect('torus', { radius: 2, tubeRadius: 0.08, tubeHeight: 0.025, segments: 128 });
  assert.equal(ring.max[1], 0.025);
  for (const options of [{ bevel: 0.5 }, { bevel: -1 }, { radius: 3 }]) assert.throws(() => new PrimitiveGeometry().build('cube', options), /parameter/);
  assert.throws(() => new PrimitiveGeometry().build('torus', { radius: 1, tubeRadius: 2 }), /parameter/);
  assert.throws(() => new PrimitiveGeometry().build('sphere', { segments: 8.5 }), /integer/);
});

class ArrayHarness {
  calls: Array<{ id: string; params: JsonObject }> = [];
  failAt = 0;
  private copies = 0;
  async run(id: string, params: JsonObject): Promise<JsonValue> {
    this.calls.push({ id, params });
    if (id === 'node.query') return { node: { name: { type: 'String', value: 'Stair' }, position: { type: 'cc.Vec3', value: { x: 1, y: 2, z: 3 } }, rotation: { type: 'cc.Vec3', value: { x: 0, y: 10, z: 0 } } } };
    if (id === 'node.duplicate') return { nodeIds: [`copy-${++this.copies}`] };
    if (this.failAt === this.copies) throw new Error('native write rejected');
    return {};
  }
}

test('array offsets are relative to the source and partial failures identify exact roots', async () => {
  const h = new ArrayHarness(), service = new GeometryService({} as EditorPort, h.run.bind(h));
  const params = { nodeId: 'source', count: 2, offset: { x: 0, y: 0.2, z: -0.5 }, rotationStep: { x: 0, y: 15, z: 0 } };
  const result = await service.array(params) as JsonObject; assert.equal((result.rows as JsonValue[]).length, 2);
  assert.deepEqual(h.calls.filter(x => x.id === 'node.set')[1]!.params.properties, { name: 'Stair_2', position: { x: 1, y: 2.4, z: 2 }, rotation: { x: 0, y: 40, z: 0 } });
  const failing = new ArrayHarness(); failing.failAt = 2;
  await assert.rejects(new GeometryService({} as EditorPort, failing.run.bind(failing)).array(params), error => {
    const details = (error as { details: JsonObject }).details;
    assert.equal(details.incompleteNodeId, 'copy-2'); assert.equal((details.rows as JsonValue[]).length, 1); return true;
  });
  assert.equal(failing.calls.some(x => x.id === 'node.delete' || x.id === 'scene.undo'), false);
  await assert.rejects(service.array({ ...params, count: 101 }), /1..100/);
});

class WindowHarness implements PreviewWindowFactory {
  windows: PreviewWindow[] = [];
  options: JsonObject | undefined;
  navigations = new Map<string, (...args: unknown[]) => void>();
  handler: (() => { action: 'deny' }) | undefined;
  permission: ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined;
  frame: unknown = { ready: true, sceneId: 'scene-a' };
  captures = 0;
  failLoad = false;
  empty = false;
  url = '';
  create(options: JsonObject): PreviewWindow {
    this.options = options; let destroyed = false; const h = this;
    const window: PreviewWindow = { isDestroyed: () => destroyed, destroy: () => { destroyed = true; }, once: () => {},
      loadURL: async url => { h.url = url; if (h.failLoad) throw new Error('load failure'); },
      webContents: { isDestroyed: () => destroyed, on: (event, listener) => { h.navigations.set(event, listener); }, setWindowOpenHandler: handler => { h.handler = handler; },
        session: { setPermissionRequestHandler: handler => { h.permission = handler; } }, executeJavaScript: async () => h.frame,
        capturePage: async () => { h.captures++; return { isEmpty: () => h.empty, toDataURL: () => 'data:image/png;base64,dGVzdA==', getSize: () => ({ width: 1280, height: 800 }) }; } } };
    this.windows.push(window); return window;
  }
}

test('managed preview isolates its window, blocks nonlocal navigation, and only captures a rendered target scene', async () => {
  const h = new WindowHarness(), preview = new ManagedPreview(h);
  await assert.rejects(preview.execute('start', { url: 'https://example.com', sceneId: 'scene-a' }), /loopback/); assert.equal(h.windows.length, 0);
  await preview.execute('start', { url: 'http://localhost:7456', sceneId: 'scene-a', visible: false });
  assert.equal(h.options!.show, false); assert.equal((h.options!.webPreferences as JsonObject).nodeIntegration, false);
  assert.equal(h.handler!().action, 'deny'); let allowed = true; h.permission!(null, 'camera', a => { allowed = a; }); assert.equal(allowed, false);
  let blocked = false; h.navigations.get('will-navigate')!({ preventDefault: () => { blocked = true; } }, 'https://example.com'); assert.equal(blocked, true);
  await preview.execute('start', { url: 'http://localhost:7456', sceneId: 'scene-a' }); assert.equal(h.windows.length, 1);
  await assert.rejects(preview.execute('start', { url: 'http://localhost:7456', sceneId: 'scene-b' }), /existing MCP preview/);
  h.frame = { ready: false }; await assert.rejects(preview.execute('capture', {}), /rendered/); assert.equal(h.captures, 0);
  h.frame = { ready: true, sceneId: 'scene-b' }; await assert.rejects(preview.execute('capture', {}), /different scene/);
  h.frame = { ready: true, sceneId: 'scene-a' }; assert.equal((await preview.execute('capture', {}) as JsonObject).source, 'managed-preview-window');
  h.empty = true; await assert.rejects(preview.execute('capture', {}), /empty image/);
  await preview.execute('stop', {}); assert.equal(h.windows[0]!.isDestroyed(), true);
  await assert.rejects(preview.execute('capture', {}), /Start an MCP preview/);
});

test('failed preview page loads destroy only the newly created window', async () => {
  const h = new WindowHarness(); h.failLoad = true; const preview = new ManagedPreview(h);
  await assert.rejects(preview.execute('start', { url: 'http://127.0.0.1:7456', sceneId: 'scene-a' }), /failed to load/);
  assert.equal(h.windows[0]!.isDestroyed(), true); assert.equal((await preview.execute('status', {}) as JsonObject).running, false);
});

test('preview capability is available only with matching host and never auto-saves a dirty scene', async () => {
  let dirty = true, calls = 0;
  const port = { projectPath: process.cwd(), version: '3.8.8', preview: async () => { calls++; return {}; }, scene: async () => ({ sceneId: 'saved' }), request: async (_channel: string, message: string) => message === 'query-dirty' ? dirty : 'http://localhost:7456' } as unknown as EditorPort;
  const adapter = new Creator3Adapter(port); assert.equal(adapter.supportedCapabilities().includes('preview.capture'), true);
  await assert.rejects(new PreviewService(port).execute('preview.start', {}), /Save the scene/); assert.equal(calls, 0);
  dirty = false; await adapter.execute('preview.start', {}); assert.equal(calls, 1);
  port.version = '3.7.4'; assert.equal(adapter.supportedCapabilities().includes('preview.start'), false);
});

class RenderingHarness {
  calls: Array<{ id: string; params: JsonObject }> = [];
  dump(value: JsonValue, type = 'Boolean'): JsonObject { return { type, value }; }
  async run(id: string, params: JsonObject): Promise<JsonValue> {
    this.calls.push({ id, params });
    if (id === 'node.query') return { node: { __comps__: [{ type: 'cc.Camera', value: { uuid: this.dump('camera', 'String') } },
      { type: 'BuiltinPipelineSettings', value: { uuid: this.dump('pipeline', 'String'), bloomEnable: this.dump(false), bloomThreshold: this.dump(0.8, 'Number'), fxaaEnable: this.dump(false) } }] } };
    return {};
  }
}

test('rendering config uses real Creator array dumps and rejects fake AO before any mutation', async () => {
  const h = new RenderingHarness(), service = new RenderingService({} as EditorPort, h.run.bind(h));
  await assert.rejects(service.configure({ cameraNodeId: 'node', bloom: { enabled: true }, ambientOcclusion: 'hbao' }), /compatible custom pipeline/); assert.equal(h.calls.length, 0);
  await service.configure({ cameraNodeId: 'node', bloom: { enabled: true, threshold: 1.1 }, fxaa: true });
  assert.deepEqual(h.calls.find(x => x.id === 'component.set')!.params, { componentId: 'pipeline', properties: { bloomEnable: true, bloomThreshold: 1.1, fxaaEnable: true } });
});

test('scene production capability schemas bound mesh, array, reflection and preview costs', () => {
  const catalog = new CapabilityCatalog();
  assert.throws(() => catalog.validate('geometry.array', { nodeId: 'a', count: 1000, offset: { x: 0, y: 1, z: 0 } }));
  assert.throws(() => catalog.validate('preview.start', { width: 9000 }));
  assert.throws(() => catalog.validate('geometry.create', { name: 'x', url: 'db://assets/x.gltf', shape: 'cube', materialUuid: 'a', options: { arbitrary: true } }));
  assert.equal(catalog.describe('geometry.create').module, 'F21');
  assert.equal(catalog.describe('rendering.configure').module, 'F31');
});

test('MCP screenshot results expose image content while preserving structured compatibility', () => {
  const value = { capabilityId: 'preview.capture', result: { dataUrl: 'data:image/png;base64,dGVzdA==', width: 1280 } };
  const result = new CaptureResult().format(value);
  assert.equal(result.content[1]!.type, 'image');
  assert.equal((result.content[0] as { text: string }).text.includes('base64'), false);
  assert.deepEqual(result.structuredContent, value); assert.equal(value.result.dataUrl, 'data:image/png;base64,dGVzdA==');
  assert.equal(new CaptureResult().format({ capabilityId: 'shader.read', result: value.result }).content.length, 1);
});

class GeometryHarness {
  calls: Array<{ id: string; params: JsonObject }> = [];
  native: string[] = [];
  failConfigure = false;
  port = { projectPath: process.cwd(), scene: async () => true,
    request: async (_channel: string, message: string, target: unknown) => {
      this.native.push(message);
      if (message === 'query-asset-info') return target === 'material' ? { type: 'cc.Material' } : null;
      return { uuid: 'asset', invalid: false, subAssets: { mesh: { uuid: 'mesh', type: 'cc.Mesh', invalid: false } } };
    } } as unknown as EditorPort;
  async run(id: string, params: JsonObject): Promise<JsonValue> {
    this.calls.push({ id, params });
    if (id === 'node.create') return { nodeId: 'created-node' };
    if (id === 'component.add') return { componentIds: ['created-renderer'] };
    if (this.failConfigure) throw new Error('native mesh assignment failed');
    return {};
  }
}

test('geometry creation binds the imported mesh, persists assets and reports partial targets on failure', async () => {
  const p = { name: 'Beveled platform', url: 'db://assets/AcceptancePrimitive.gltf', materialUuid: 'material', shape: 'cube', options: { size: { x: 12, y: 0.4, z: 8 }, bevel: 0.06 } };
  const h = new GeometryHarness(); const result = await new GeometryService(h.port, h.run.bind(h)).create(p) as JsonObject;
  assert.equal(result.savedMesh, true); assert.equal(result.sceneSaveRequired, true);
  assert.deepEqual(h.calls.find(c => c.id === 'component.set')!.params.properties, { mesh: { uuid: 'mesh' }, sharedMaterials: [{ uuid: 'material' }], shadowCastingMode: 1 });
  const bad = new GeometryHarness(); bad.failConfigure = true;
  await assert.rejects(new GeometryService(bad.port, bad.run.bind(bad)).create(p), error => {
    const details = (error as { details: JsonObject }).details; assert.equal(details.nodeId, 'created-node'); assert.equal(details.assetUrl, p.url); return true;
  });
  assert.equal(bad.native.includes('delete-asset'), false);
  await assert.rejects(new GeometryService(h.port, h.run.bind(h)).create({ ...p, url: 'db://assets/../escaped.gltf' }), /traversal/);
});

test('native preview addresses are normalized only when they belong to this host', async () => {
  const { networkInterfaces } = await import('node:os');
  const address = Object.values(networkInterfaces()).flatMap(rows => rows ?? []).find(row => row.family === 'IPv4')!.address;
  let source = `http://${address}:7456`, target = '';
  const port = { version: '3.8.8', preview: async (_method: string, params: JsonObject) => { target = String(params.url); return {}; }, scene: async () => ({ sceneId: 'saved' }), request: async (_channel: string, message: string) => message === 'query-dirty' ? false : source } as unknown as EditorPort;
  await new PreviewService(port).execute('preview.start', {}); assert.equal(target, 'http://127.0.0.1:7456/');
  source = 'http://example.com:7456'; await new PreviewService(port).execute('preview.start', {});
  assert.equal(target, 'http://example.com:7456/'); // 远端保持原样，由 ManagedPreview 严格拒绝，不能伪装成本机。
});
