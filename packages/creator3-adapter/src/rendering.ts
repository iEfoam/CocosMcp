import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { PropertyDump } from './dump.js';
import type { EditorPort } from './port.js';

type Run = (id: string, params: JsonObject) => Promise<JsonValue>;

export class RenderingService {
  constructor(private readonly port: EditorPort, private readonly run: Run) {}

  private async node(nodeId: string): Promise<JsonObject> {
    return Json.object(Json.object(await this.run('node.query', { nodeId })).node);
  }

  private async component(componentId: string, type: string): Promise<JsonObject> {
    const dump = Json.object(Json.object(await this.run('component.query', { componentId })).component);
    if (dump.type !== type) throw new CocosError('INVALID_ARGUMENT', `Expected ${type} component`);
    return dump;
  }

  private preflight(dump: JsonObject, properties: JsonObject): void {
    for (const [path, value] of Object.entries(properties)) PropertyDump.assign(PropertyDump.locate(dump, path), value);
  }

  async query(p: JsonObject): Promise<JsonValue> {
    const scene = Json.object(await this.port.scene('sceneInfo'));
    const dump = await this.node(Json.string(scene.sceneId, 'sceneId'));
    return { sceneId: scene.sceneId!, globals: PropertyDump.unwrap(dump._globals ?? {}),
      camera: p.cameraNodeId ? PropertyDump.unwrap(await this.node(Json.string(p.cameraNodeId, 'cameraNodeId'))) : null,
      supportedConfiguration: ['shadow-map', 'builtin-bloom', 'builtin-fxaa', 'planar-reflection'],
      limitations: [{ feature: 'hbao', status: 'requires-compatible-custom-pipeline', alternative: 'No darkening proxy is created' },
        { feature: 'physical-transmission', status: 'requires-transmission-effect-and-pipeline', alternative: 'Standard transparent material is alpha blending only' }],
      visualVerification: 'use preview.capture after saving; configuration is not a GPU image test' };
  }

  async configure(p: JsonObject): Promise<JsonValue> {
    // 不静默切换全工程管线，也不把 Alpha 混合或接地暗片冒充物理透射与屏幕空间 AO。
    if (p.ambientOcclusion === 'hbao' || p.transmission === 'physical') throw new CocosError('UNSUPPORTED_CAPABILITY', 'This Builtin configuration adapter cannot enable HBAO or physical transmission; provide a compatible custom pipeline/effect first');
    const steps: Array<{ label: string; id: string; params: JsonObject }> = [];
    let missingPipelineNode: string | null = null;
    const cameraProperties: JsonObject = {};
    if (p.bloom || p.fxaa !== undefined || p.editorPreview !== undefined) {
      const nodeId = Json.string(p.cameraNodeId, 'cameraNodeId'), node = await this.node(nodeId);
      const components = Array.isArray(node.__comps__) ? node.__comps__.map(row => Json.object(row)) : [];
      if (!components?.some(c => c.type === 'cc.Camera')) throw new CocosError('INVALID_ARGUMENT', 'cameraNodeId has no Camera');
      const pipeline = components.find(c => c.type === 'BuiltinPipelineSettings');
      if (p.bloom) {
        const bloom = Json.object(p.bloom);
        for (const key of ['enabled', 'threshold', 'intensity', 'iterations']) if (bloom[key] !== undefined) cameraProperties[key === 'enabled' ? 'bloomEnable' : `bloom${key[0]!.toUpperCase()}${key.slice(1)}`] = bloom[key]!;
      }
      if (p.fxaa !== undefined) cameraProperties.fxaaEnable = p.fxaa;
      if (p.editorPreview !== undefined) cameraProperties.editorPreview = p.editorPreview;
      if (pipeline) {
        this.preflight(pipeline, cameraProperties);
        const componentId = Json.string(PropertyDump.unwrap(Json.object(pipeline.value).uuid!), 'pipeline UUID');
        steps.push({ label: 'camera-post-processing', id: 'component.set', params: { componentId, properties: cameraProperties } });
      } else missingPipelineNode = nodeId;
    }
    if (p.shadows) {
      const shadows = Json.object(p.shadows), scene = Json.object(await this.port.scene('sceneInfo')), sceneId = Json.string(scene.sceneId, 'sceneId');
      const properties: JsonObject = { '_globals.shadows.enabled': shadows.enabled!, '_globals.shadows.type': 1 };
      if (shadows.resolution !== undefined) properties['_globals.shadows.shadowMapSize'] = shadows.resolution;
      this.preflight(await this.node(sceneId), properties);
      steps.push({ label: 'scene-shadow-map', id: 'node.set', params: { nodeId: sceneId, properties } });
      if (shadows.enabled === true || p.lightComponentId) {
        const componentId = Json.string(p.lightComponentId, 'lightComponentId'), light = await this.component(componentId, 'cc.DirectionalLight');
        const lightProperties: JsonObject = { shadowEnabled: shadows.enabled! };
        for (const [key, field] of [['pcf', 'shadowPcf'], ['bias', 'shadowBias'], ['normalBias', 'shadowNormalBias']]) if (shadows[key!] !== undefined) lightProperties[field!] = shadows[key!]!;
        this.preflight(light, lightProperties); steps.push({ label: 'directional-light-shadow', id: 'component.set', params: { componentId, properties: lightProperties } });
      }
    }
    const completed: JsonValue[] = [];
    try {
      if (missingPipelineNode) {
        const types = Json.object(await this.run('component.types', {}));
        const type = (types.rows as JsonObject[]).find(row => row.name === 'BuiltinPipelineSettings');
        if (!type) throw new CocosError('UNSUPPORTED_CAPABILITY', 'BuiltinPipelineSettings is not registered in this project');
        const added = Json.object(await this.run('component.add', { nodeId: missingPipelineNode, type: type.cid! }));
        const componentId = (added.componentIds as string[])[0]!; completed.push({ addedComponentId: componentId });
        steps.unshift({ label: 'camera-post-processing', id: 'component.set', params: { componentId, properties: cameraProperties } });
      }
      for (const step of steps) { await this.run(step.id, step.params); completed.push(step.label); }
      return { completed, sceneSaveRequired: completed.length > 0, visualVerification: 'not-run' };
    } catch (error) { throw new CocosError('EDITOR_ERROR', 'Rendering configuration incomplete', { completed, cause: CocosError.from(error).message }); }
  }

  async planarReflection(p: JsonObject): Promise<JsonValue> {
    const cameraComponentId = Json.string(p.cameraComponentId, 'cameraComponentId'); await this.component(cameraComponentId, 'cc.Camera');
    const ids = p.rendererComponentIds as string[];
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length) throw new CocosError('INVALID_ARGUMENT', 'Expected 1..200 unique renderer IDs');
    for (const id of ids) this.preflight(await this.component(id, 'cc.MeshRenderer'), { 'bakeSettings.reflectionProbe': 2 });
    const size = Json.object(p.size);
    if (!['x', 'y', 'z'].every(axis => Number.isFinite(size[axis]) && Number(size[axis]) > 0)) throw new CocosError('INVALID_ARGUMENT', 'Reflection volume dimensions must be positive');
    const completed: JsonValue[] = [];
    let nodeId: string | null = null;
    try {
      nodeId = Json.string(Json.object(await this.run('node.create', { name: p.name! })).nodeId, 'nodeId');
      await this.run('node.set', { nodeId, properties: { position: p.position! } });
      const componentId = (Json.object(await this.run('component.add', { nodeId, type: 'cc.ReflectionProbe' })).componentIds as string[])[0]!;
      await this.run('component.set', { componentId, properties: { probeType: 1, sourceCamera: { uuid: cameraComponentId }, size, resolution: p.resolution ?? 512 } });
      for (const id of ids) { await this.run('component.set', { componentId: id, properties: { 'bakeSettings.reflectionProbe': 2 } }); completed.push(id); }
      return { nodeId, componentId, rendererComponentIds: completed, sceneSaveRequired: true, visualVerification: 'not-run' };
    } catch (error) { throw new CocosError('EDITOR_ERROR', 'Planar reflection configuration incomplete', { nodeId, completedRendererIds: completed, cause: CocosError.from(error).message }); }
  }
}
