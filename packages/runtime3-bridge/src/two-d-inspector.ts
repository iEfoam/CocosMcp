import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import { FeatureSupport as F } from './feature-support.js';
import type { SceneInspector } from './scene.js';
import { UiInspector } from './ui.js';

/** 只读候选诊断与真实命中分开返回，不能把层级遍历冒充引擎提交顺序。 */
export class TwoDInspector {
  constructor(private readonly scene: SceneInspector) {}
  private get cc(): RuntimeObject { return this.scene.environment.cc; }
  private nodes(p: JsonObject): RuntimeObject[] {
    const nodes = this.scene.all(this.scene.node(Json.string(p.rootId, 'rootId')));
    if (nodes.length > 1000) throw new CocosError('INVALID_ARGUMENT', '2D inspection is limited to 1000 nodes');
    return nodes;
  }
  sprite(frame: RuntimeObject): JsonObject {
    const texture = frame.texture ? A.object(frame.texture) : undefined;
    const sampler = texture && typeof texture.getSamplerInfo === 'function' ? A.object(A.call(texture, 'getSamplerInfo')) : undefined;
    const manager = this.cc.dynamicAtlasManager ? A.object(this.cc.dynamicAtlasManager) : undefined;
    const rect = A.object(frame.rect ?? {}), filter = A.object(A.object(this.cc.gfx ?? {}).Filter ?? {});
    const reasons: string[] = [];
    if (!manager?.enabled) reasons.push('DYNAMIC_ATLAS_DISABLED');
    if (!frame.packable) reasons.push('NOT_PACKABLE');
    if (frame.original) reasons.push('ALREADY_PACKED');
    if (!sampler || filter.LINEAR === undefined || filter.NONE === undefined) reasons.push('SAMPLER_SUPPORT_UNKNOWN');
    else if (sampler.minFilter !== filter.LINEAR || sampler.magFilter !== filter.LINEAR || sampler.mipFilter !== filter.NONE) reasons.push('SAMPLER_INCOMPATIBLE');
    if (manager && (Number(rect.width) > Number(manager.maxFrameSize) || Number(rect.height) > Number(manager.maxFrameSize))) reasons.push('FRAME_TOO_LARGE');
    return { uuid: A.uuid(frame), textureUuid: texture ? A.uuid(texture) : null, rect: A.safeData(frame.rect), originalSize: A.safeData(frame.originalSize),
      offset: A.safeData(frame.offset), rotated: Boolean(frame.rotated), packable: Boolean(frame.packable),
      borders: { left: Number(frame.insetLeft), right: Number(frame.insetRight), top: Number(frame.insetTop), bottom: Number(frame.insetBottom) },
      sampler: sampler ? A.safeData(sampler) : null, atlasCandidate: reasons.length === 0, reasons,
      limitations: ['候选条件不证明已入图集或可合批；保留像素风采样，不自动改为线性'] };
  }
  execute(id: string, p: JsonObject): JsonValue {
    if (id === 'runtime.ui.assert') {
      const nodes = new Map(this.nodes(p).map(node => [A.uuid(node), node]));
      if (!Array.isArray(p.rows) || !p.rows.length || p.rows.length > 100) throw new CocosError('INVALID_ARGUMENT', 'Expected 1..100 UI assertions');
      const rows = p.rows.map(value => {
        const expected = Json.object(value), nodeId = Json.string(expected.nodeId, 'nodeId'), node = nodes.get(nodeId);
        if (!node) return { nodeId, passed: false, reason: 'NODE_NOT_IN_SUBTREE' };
        const components = this.scene.components(node), label = components.find(c => this.scene.type(c) === 'cc.Label'), button = components.find(c => this.scene.type(c) === 'cc.Button');
        const actual: JsonObject = { active: Boolean(node.activeInHierarchy), text: label ? String(label.string) : null, interactable: button ? Boolean(button.interactable) : null };
        const checks = Object.keys(expected).filter(key => key !== 'nodeId');
        if (!checks.length || checks.some(key => !['active', 'text', 'interactable'].includes(key))) throw new CocosError('INVALID_ARGUMENT', 'Assertion must specify supported state fields');
        return { nodeId, passed: checks.every(key => actual[key] === expected[key]), expected, actual };
      });
      return { passed: rows.every(row => row.passed), rows, scope: 'current-runtime-state', pixelVisibilityVerified: false };
    }
    if (id === 'runtime.ui.hit_test') {
      const x = Number(p.x), y = Number(p.y);
      if (![x, y].every(Number.isFinite)) throw new CocosError('INVALID_ARGUMENT', 'Screen coordinates must be finite');
      const rows: JsonObject[] = [];
      for (const node of this.nodes(p)) {
        const transform = A.call(node, 'getComponent', F.require(this.cc.UITransform, 'UITransform'));
        if (!transform) continue;
        const active = Boolean(node.activeInHierarchy), hit = active && Boolean(A.call(transform, 'hitTest', A.construct(this.cc.Vec2, [x, y]), Number(p.windowId ?? 0)));
        const components = this.scene.components(node);
        rows.push({ nodeId: A.uuid(node), name: String(node.name), active, hit, layer: Number(node.layer),
          interactable: components.filter(c => typeof c.interactable === 'boolean').map(c => ({ componentId: A.uuid(c), type: this.scene.type(c), enabled: Boolean(c.enabledInHierarchy), interactable: Boolean(c.interactable) })),
          blocksInput: components.some(c => this.scene.type(c) === 'cc.BlockInputEvents' && c.enabledInHierarchy) });
      }
      return { rows, coordinateSpace: 'engine-screen', actualReceiverVerified: false, limitations: ['调用原生 hitTest，包含相机与 Mask；结果不是事件分发顺序，也不证明像素可见或业务回调成功'] };
    }
    if (id === 'runtime.ui.inspect') return { layout: new UiInspector(this.scene).layout(p), interaction: new UiInspector(this.scene).interaction(p) };
    if (id === 'runtime.atlas.inspect') {
      const manager = F.require(this.cc.dynamicAtlasManager, 'dynamicAtlasManager');
      return { enabled: Boolean(manager.enabled), textureSize: Number(manager.textureSize), maxFrameSize: Number(manager.maxFrameSize), maxAtlasCount: Number(manager.maxAtlasCount),
        atlasCount: typeof manager.atlasCount === 'number' ? manager.atlasCount : null, scope: 'public-manager-state', mutatesPacking: false };
    }
    const rows: JsonObject[] = [], diagnostics: JsonObject[] = [];
    let previous: { nodeId: string; texture: unknown; material: unknown; layer: unknown } | undefined;
    for (const node of this.nodes(p)) for (const component of this.scene.components(node)) {
      const type = this.scene.type(component), nodeId = A.uuid(node), componentId = A.uuid(component);
      if (type === 'cc.Sprite' && component.spriteFrame && id !== 'runtime.label.audit') {
        const frame = A.object(component.spriteFrame), material = A.call(component, 'getRenderMaterial', 0);
        const reasons: string[] = [];
        if (previous) {
          if (previous.texture !== frame.texture) reasons.push('TEXTURE_CHANGED');
          if (previous.material !== material) reasons.push('MATERIAL_INSTANCE_CHANGED');
          if (previous.layer !== node.layer) reasons.push('LAYER_CHANGED');
        }
        rows.push({ nodeId, componentId, type, active: Boolean(component.enabledInHierarchy), spriteFrame: this.sprite(frame) });
        if (reasons.length) diagnostics.push({ nodeId, previousNodeId: previous!.nodeId, reasons, evidence: 'hierarchy-candidate' });
        previous = { nodeId, texture: frame.texture, material, layer: node.layer };
      } else if (type === 'cc.Label') {
        rows.push({ nodeId, componentId, type, cacheMode: Number(component.cacheMode), overflow: Number(component.overflow), fontSize: Number(component.fontSize), textLength: String(component.string ?? '').length });
        diagnostics.push({ nodeId, code: 'CACHE_POLICY_REVIEW', message: '静态文本与频繁更新文本分别评估 BITMAP/CHAR；不自动更换缓存策略' });
        previous = undefined;
      } else if (type === 'cc.Mask') {
        diagnostics.push({ nodeId, componentId, code: 'STENCIL_BOUNDARY', evidence: 'component-configuration' }); previous = undefined;
      } else if (typeof component.getRenderMaterial === 'function') previous = undefined;
    }
    return { rows, diagnostics, scope: 'static-2d-render-candidates', drawCallReductionVerified: false,
      limitations: ['未读取私有批次数据；未把遍历顺序当作真实提交顺序；缓冲区、Sorting2D、多相机和原生渲染需单独实测'] };
  }
}
