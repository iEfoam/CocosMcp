import { join } from 'path';
import { PathSampler } from '../../../packages/runtime3-bridge/src/path.js';
import { FeatureSupport } from '../../../packages/runtime3-bridge/src/feature-support.js';
import { EngineFeatureInspector } from '../../../packages/runtime3-bridge/src/engine-inspector.js';
import { IkAuthoring } from '../../../packages/runtime3-bridge/src/ik-authoring.js';
import { CocosError } from '../../../packages/contracts/src/index.js';
import { SceneResponse } from './scene-response.js';
import { SceneInspector } from '../../../packages/runtime3-bridge/src/scene.js';
import type { RuntimeObject } from '../../../packages/runtime3-bridge/src/access.js';
import { RuntimeAccess } from '../../../packages/runtime3-bridge/src/access.js';
import type { JsonValue } from '../../../packages/contracts/src/index.js';
import { Json } from '../../../packages/contracts/src/index.js';
import { MaterialController } from '../../../packages/runtime3-bridge/src/material.js';
import { CreatorShaderHost } from './shader-host.js';
import { UiDocumentModel } from '../../../packages/ui-core/src/index.js';
import { SerializedReferenceAudit } from '../../../packages/ui-core/src/reference-audit.js';
import { Creator3UiStructure } from './ui-structure.js';
import { Creator3UiStructureExecution } from './ui-structure-execution.js';
import { Creator3PrefabSnapshot } from './prefab-snapshot.js';
import { FontInspector } from '../../../packages/runtime3-bridge/src/font.js';
import { AnimationTools } from '../../../packages/runtime3-bridge/src/animation.js';
import { TwoDAnimationAuthoring } from '../../../packages/runtime3-bridge/src/animation-two-d.js';

declare const Editor: { App: { path: string } };
declare const EditorExtends: { serialize(value: unknown, options?: { reserveContentsForSyncablePrefab: boolean; dontStripDefault: boolean; compressUuid: boolean; keepNodeUuid: boolean }): unknown };
declare const cce: { SceneFacadeManager: RuntimeObject; Node: RuntimeObject };

class SceneLifecycle {
  private inspector: SceneInspector | undefined;
  private materials: MaterialController | undefined;
  async dispatch(method: string, args: unknown[]): Promise<JsonValue> {
    if (!this.inspector) {
      // cc 模块由 Creator 的场景进程提供，不能打包另一份引擎，否则对象类型和注册表会分裂。
      const engineModules = join(Editor.App.path, 'node_modules');
      if (!module.paths.includes(engineModules)) module.paths.push(engineModules);
      const cc = require('cc') as RuntimeObject;
      this.inspector = new SceneInspector({ cc, major: 3, serialize: value => EditorExtends.serialize(value),
        // 删除前的引用扫描必须展开 Prefab 默认内容，不能把压缩省略的组件当作没有引用。
        serializeReferences: value => EditorExtends.serialize(value, {
          reserveContentsForSyncablePrefab: true, dontStripDefault: true, compressUuid: false, keepNodeUuid: true,
        }), editor: true });
      this.materials = new MaterialController(this.inspector.environment);
    }
    if (method === 'scene.references') return new SerializedReferenceAudit().scene(this.inspector);
    if (method === 'prefab.snapshot') return new Creator3PrefabSnapshot(this.inspector, value => EditorExtends.serialize(value, {
      // 默认序列化会将可同步 Prefab 的组件压缩为 null，差异检查必须保留实例实际内容。
      reserveContentsForSyncablePrefab: true, dontStripDefault: true, compressUuid: false, keepNodeUuid: true,
    })).capture(Json.string(Json.value(args[0]), 'nodeId'));
    if (method === 'ui.structure.plan') {
      if (typeof cce === 'undefined') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Native scene facade is unavailable');
      return new Creator3UiStructure(this.inspector, cce.SceneFacadeManager).plan(Json.object(args[0]));
    }
    // 由版本受限的 adapter 暴露；原生端仍独立核对模式、计划与引用，避免绕过前端校验。
    if (method === 'ui.structure.apply') {
      if (typeof cce === 'undefined') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Native scene facade is unavailable');
      return new Creator3UiStructureExecution(this.inspector, cce.SceneFacadeManager, cce.Node).apply(Json.object(args[0]));
    }
    if (method.startsWith('ik.')) {
      const cc = this.inspector.environment.cc;
      return FeatureSupport.run(method, String(cc.VERSION ?? cc.ENGINE_VERSION ?? 'unknown'), () => {
        let editor: RuntimeObject;
        try { editor = require('cc/editor/new-gen-anim') as RuntimeObject; }
        catch (error) {
          if ((error as {code?: string}).code === 'MODULE_NOT_FOUND') throw new CocosError('UNSUPPORTED_CAPABILITY', '当前编辑器没有动画图编辑模块');
          throw error;
        }
        const authoring = new IkAuthoring(this.inspector!, editor), p = Json.object(args[0]);
        if (method === 'ik.inspect') return authoring.inspect(p);
        return method === 'ik.mask_serialize' ? authoring.mask(p) : authoring.serialize(p);
      });
    }
    if (method.startsWith('path.') || method === 'probe.generate' || method === 'engine.feature.inspect') {
      const cc = this.inspector.environment.cc, p = Json.object(args[0]);
      return FeatureSupport.run(method, String(cc.VERSION ?? cc.ENGINE_VERSION ?? 'unknown'), () => {
        if (method.startsWith('path.')) return new PathSampler(cc).execute(method, p);
        const inspector = new EngineFeatureInspector(this.inspector!);
        return method === 'probe.generate' ? inspector.generate(p) : inspector.inspect(String(p.family), p);
      });
    }
    if (method === 'shader.material') return this.materials!.serialized(Json.object(args[0]));
    if (method === 'shader.materialAsset') return this.materials!.asset(Json.object(args[0]));
    if (method === 'shader.compileNative') {
      const p = Json.object(args[0]);
      return new CreatorShaderHost(Editor.App.path, Json.string(p.projectPath, 'projectPath'), Json.string(p.editorVersion, 'editorVersion')).execute('compile', p);
    }
    if (method === 'shader.binding') return this.materials!.binding(Json.object(args[0]));
    if (method === 'shader.bindings') return this.materials!.bindings(String(args[0]));
    if (method === 'shader.checkMaterial') { await this.materials!.load(String(args[0]), 'Material'); return { valid: true }; }
    if (method === 'font.inspect') return new FontInspector(this.inspector, this.materials!).inspect(Json.object(args[0]));
    if (method === 'animation.clip.patchSource') return new AnimationTools(this.inspector, this.materials!).patchSource(Json.object(args[0]));
    if (method === 'animation2d.serialize') return new TwoDAnimationAuthoring(this.inspector, this.materials!).serialize(Json.object(args[0]));
    if (method === 'gameplay2d.class_available') {
      const p = Json.object(args[0]), name = Json.string(p.className, 'className');
      if (!/^[A-Z][A-Za-z0-9]{2,63}$/.test(name)) throw new CocosError('INVALID_ARGUMENT', 'Invalid generated class name');
      return { registered: typeof RuntimeAccess.call(this.inspector.environment.cc.js, 'getClassByName', name) === 'function' };
    }
    if (method === 'animation.clip.serialize') return new AnimationTools(this.inspector, this.materials!).serialize(Json.object(args[0]));
    if (method === 'animation.clip.inspect' || method === 'animation.clip.sample') return new AnimationTools(this.inspector, this.materials!).inspect(Json.object(args[0]));
    if (method === 'ui.preflight' || method === 'ui.preflight_update') {
      const rows = new UiDocumentModel().parse(Json.object(args[0]).document);
      for (const row of rows) for (const spec of row.node.components ?? []) for (const [property, value] of Object.entries(spec.properties ?? {})) {
        if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.assetUuid === 'string') {
          await this.materials!.load(value.assetUuid, ['spriteFrame', 'backgroundImage'].includes(property) ? 'SpriteFrame' : spec.type === 'cc.RichText' ? 'TTFFont' : 'Font');
        }
      }
    }
    return this.inspector.execute(method, args);
  }
  clear(): void { this.materials?.dispose(); this.materials = undefined; this.inspector = undefined; }
}
const lifecycle = new SceneLifecycle();
export const methods = { dispatch: (method: string, args: unknown[] = []): Promise<JsonValue> => SceneResponse.capture(() => lifecycle.dispatch(method, args)) };
export const load = (): void => lifecycle.clear();
export const unload = (): void => lifecycle.clear();
