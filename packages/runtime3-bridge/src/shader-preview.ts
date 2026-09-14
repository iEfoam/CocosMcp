import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import { SceneInspector, type SceneEnvironment } from './scene.js';
import { MaterialController } from './material.js';

interface Preview { root: RuntimeObject; renderer: RuntimeObject; texture: RuntimeObject; mesh: RuntimeObject; material: RuntimeObject; width: number; height: number; masks: Array<{ camera: RuntimeObject; before: number; after: number }> }

export class ShaderPreview {
  private preview: Preview | undefined;
  private readonly baselines = new Map<string, Uint8Array>();
  private sequence = 0;
  constructor(private readonly environment: SceneEnvironment, private readonly materials: MaterialController) {}
  private active(): Preview {
    if (!this.preview || this.preview.root.isValid === false) throw new CocosError('CONTEXT_UNAVAILABLE', 'Open a shader preview first');
    return this.preview;
  }
  private async frame(): Promise<void> {
    const director = this.environment.cc.director;
    const event = A.object(this.environment.cc.Director).EVENT_AFTER_DRAW;
    if (!event) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Frame completion event unavailable');
    await new Promise<void>((accept, reject) => {
      const done = (): void => { clearTimeout(timeout); A.call(director, 'off', event, done); accept(); };
      const timeout = setTimeout(() => { A.call(director, 'off', event, done); reject(new CocosError('CONTEXT_UNAVAILABLE', 'No rendered frame within 5 seconds')); }, 5000);
      A.call(director, 'once', event, done);
    });
  }
  async execute(id: string, p: JsonObject): Promise<JsonObject> {
    if (id === 'runtime.shader.preview.close') { this.dispose(); return { closed: true }; }
    if (id === 'runtime.shader.profile') return this.profile(Number(p.frames ?? 60));
    if (id === 'runtime.shader.preview.open') return this.open(p);
    const preview = this.active();
    if (id === 'runtime.shader.preview.update') {
      const candidate = await this.materials.instance(preview.material, p);
      try {
        if (this.materials.compile(candidate).status !== 'passed') throw new CocosError('VERIFICATION_FAILED', 'Preview candidate failed compilation');
        A.call(preview.renderer, 'setMaterialInstance', candidate, 0);
      } catch (error) { A.call(candidate, 'destroy'); throw error; }
      const previous = preview.material; preview.material = candidate; A.call(previous, 'destroy');
      await this.frame(); return this.materials.describe(candidate);
    }
    await this.frame();
    const bytes = A.call(preview.texture, 'readPixels', 0, 0, preview.width, preview.height) as Uint8Array | null;
    if (!bytes || bytes.length !== preview.width * preview.height * 4) throw new CocosError('VERIFICATION_FAILED', 'RenderTexture readback unavailable');
    if (id === 'runtime.shader.preview.compare') {
      const baseline = this.baselines.get(Json.string(p.baselineId, 'baselineId'));
      if (!baseline || baseline.length !== bytes.length) throw new CocosError('NOT_FOUND', 'Baseline expired or dimensions changed');
      let sum = 0; let changed = 0; const difference = new Uint8Array(bytes.length);
      for (let offset = 0; offset < bytes.length; offset += 4) {
        let pixelChanged = false;
        for (let channel = 0; channel < 3; channel++) {
          const delta = Math.abs(bytes[offset + channel]! - baseline[offset + channel]!); sum += delta;
          difference[offset + channel] = delta; if (delta) pixelChanged = true;
        }
        difference[offset + 3] = 255; if (pixelChanged) changed++;
      }
      const meanError = sum / (preview.width * preview.height * 3 * 255);
      return { meanError, changedPixels: changed, passed: meanError <= Number(p.tolerance ?? 0.01), difference: this.image(difference, preview.width, preview.height),
        scope: 'same-runtime-rendertexture', artisticAcceptance: 'requires-review' };
    }
    const baselineId = `preview-${++this.sequence}`; this.baselines.set(baselineId, new Uint8Array(bytes));
    if (this.baselines.size > 8) this.baselines.delete(this.baselines.keys().next().value!);
    let uniform = true;
    for (let offset = 4; offset < bytes.length; offset += 4) if (bytes[offset] !== bytes[0] || bytes[offset + 1] !== bytes[1] || bytes[offset + 2] !== bytes[2]) { uniform = false; break; }
    return { baselineId, width: preview.width, height: preview.height, image: this.image(bytes, preview.width, preview.height), uniformImage: uniform,
      compilation: this.materials.compile(preview.material), source: 'dedicated-rendertexture', timeControl: 'live-engine-time' };
  }
  private image(bytes: Uint8Array, width: number, height: number): JsonValue {
    const document = (globalThis as unknown as { document?: Document }).document;
    if (!document) return { encoding: 'rgba8', rows: Array.from(bytes), origin: 'bottom-left' };
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) throw new CocosError('UNSUPPORTED_CAPABILITY', 'PNG encoder unavailable');
    const pixels = context.createImageData(width, height);
    for (let y = 0; y < height; y++) pixels.data.set(bytes.subarray((height - y - 1) * width * 4, (height - y) * width * 4), y * width * 4);
    context.putImageData(pixels, 0, 0); return { dataUrl: canvas.toDataURL('image/png'), origin: 'top-left' };
  }
  private async open(p: JsonObject): Promise<JsonObject> {
    if (this.preview) throw new CocosError('RESOURCE_BUSY', 'Close the previous preview first');
    const cc = this.environment.cc; const inspector = new SceneInspector(this.environment);
    const width = Number(p.width ?? 512); const height = Number(p.height ?? 512);
    if (![width, height].every(value => Number.isInteger(value) && value >= 16 && value <= 2048)) throw new CocosError('INVALID_ARGUMENT', 'Preview dimensions must be 16..2048');
    const parent = await this.materials.load(Json.string(p.materialUuid, 'materialUuid'), 'Material');
    const material = await this.materials.instance(parent, {});
    const root = A.construct(cc.Node, ['Cocos MCP Shader Preview']);
    const texture = A.construct(cc.RenderTexture, []); let mesh: RuntimeObject | undefined;
    const masks: Preview['masks'] = [];
    try {
      const used = inspector.all().reduce((value, node) => value | Number(node.layer ?? 0), 0);
      let layer = 0;
      for (let bit = 0; bit < 20; bit++) if (!(used & (1 << bit))) { layer = 1 << bit; break; }
      if (!layer) throw new CocosError('RESOURCE_BUSY', 'No unused preview layer');
      for (const node of inspector.all()) for (const component of inspector.components(node)) {
        if (typeof cc.Camera === 'function' && component instanceof cc.Camera) {
          const before = Number(component.visibility); const after = before & ~layer;
          masks.push({ camera: component, before, after }); component.visibility = after;
        }
      }
      A.call(root, 'setParent', inspector.current()); root.layer = layer;
      const object = A.construct(cc.Node, ['Shader Geometry']); object.layer = layer; A.call(object, 'setParent', root);
      const primitive = A.object(cc.primitives); const shape = String(p.shape ?? 'sphere');
      if (!['sphere', 'cube', 'quad'].includes(shape)) throw new CocosError('INVALID_ARGUMENT', 'Unknown preview shape');
      const geometry = shape === 'sphere' ? A.call(primitive, 'sphere', 0.8) : shape === 'cube' ? A.call(primitive, 'box') : A.call(primitive, 'quad');
      mesh = A.object(A.call(cc.utils, 'createMesh', geometry));
      const renderer = A.object(A.call(object, 'addComponent', cc.MeshRenderer)); renderer.mesh = mesh;
      A.call(renderer, 'setSharedMaterial', parent, 0); A.call(renderer, 'setMaterialInstance', material, 0);
      const cameraNode = A.construct(cc.Node, ['Shader Camera']); cameraNode.layer = layer; A.call(cameraNode, 'setParent', root); A.call(cameraNode, 'setPosition', 0, 0, 3);
      const camera = A.object(A.call(cameraNode, 'addComponent', cc.Camera)); camera.visibility = layer; camera.priority = 1000;
      camera.clearColor = A.construct(cc.Color, [24, 24, 28, 255]); camera.clearFlags = 7;
      A.call(texture, 'reset', { width, height }); camera.targetTexture = texture;
      // 不往活动场景新增 DirectionalLight：它可能替换整个场景的主光，影响用户原有画面。
      this.preview = { root, renderer, texture, mesh, material, width, height, masks };
      await this.frame();
      return { opened: true, width, height, componentId: A.uuid(renderer), compilation: this.materials.compile(material), timeControl: 'live-engine-time', lighting: 'current-scene' };
    } catch (error) {
      if (this.preview) this.dispose();
      else {
        for (const row of masks) if (row.camera.visibility === row.after) row.camera.visibility = row.before;
        A.call(root, 'destroy'); A.call(texture, 'destroy'); A.call(material, 'destroy'); if (mesh) A.call(mesh, 'destroy');
      }
      throw error;
    }
  }
  private async profile(frames: number): Promise<JsonObject> {
    if (!Number.isInteger(frames) || frames < 2 || frames > 300) throw new CocosError('INVALID_ARGUMENT', 'Frame count must be 2..300');
    const started = performance.now(); const rows: number[] = [];
    await this.frame(); let previous = performance.now();
    for (let index = 0; index < frames; index++) {
      if (performance.now() - started > 15000) throw new CocosError('CONTEXT_UNAVAILABLE', 'Frame sampling exceeded 15 seconds');
      await this.frame(); const now = performance.now(); rows.push(now - previous); previous = now;
    }
    const sorted = [...rows].sort((a, b) => a - b);
    return { frames, meanMs: rows.reduce((sum, value) => sum + value, 0) / frames, p50Ms: sorted[Math.floor(frames * 0.5)]!, p95Ms: sorted[Math.floor(frames * 0.95)]!,
      rows, scope: 'whole-frame-wall-time', gpuMs: null, unavailableMetrics: ['isolated-shader-gpu-time', 'gpu-memory'], warmupFrames: 1 };
  }
  dispose(): void {
    const preview = this.preview; this.preview = undefined; this.baselines.clear();
    if (!preview) return;
    for (const row of preview.masks) if (row.camera.isValid !== false && row.camera.visibility === row.after) row.camera.visibility = row.before;
    for (const object of [preview.root, preview.material, preview.mesh, preview.texture]) if (object.isValid !== false) A.call(object, 'destroy');
  }
}
