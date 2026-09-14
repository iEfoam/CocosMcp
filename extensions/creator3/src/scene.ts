import { join } from 'path';
import { SceneInspector } from '../../../packages/runtime3-bridge/src/scene.js';
import type { RuntimeObject } from '../../../packages/runtime3-bridge/src/access.js';
import type { JsonValue } from '../../../packages/contracts/src/index.js';
import { Json } from '../../../packages/contracts/src/index.js';
import { MaterialController } from '../../../packages/runtime3-bridge/src/material.js';

declare const Editor: { App: { path: string } };
declare const EditorExtends: { serialize(value: unknown): unknown };

class SceneLifecycle {
  private inspector: SceneInspector | undefined;
  private materials: MaterialController | undefined;
  async dispatch(method: string, args: unknown[]): Promise<JsonValue> {
    if (!this.inspector) {
      // cc 模块由 Creator 的场景进程提供，不能打包另一份引擎，否则对象类型和注册表会分裂。
      const engineModules = join(Editor.App.path, 'node_modules');
      if (!module.paths.includes(engineModules)) module.paths.push(engineModules);
      const cc = require('cc') as RuntimeObject;
      this.inspector = new SceneInspector({ cc, major: 3, serialize: value => EditorExtends.serialize(value), editor: true });
      this.materials = new MaterialController(this.inspector.environment);
    }
    if (method === 'shader.material') return this.materials!.serialized(Json.object(args[0]));
    if (method === 'shader.binding') return this.materials!.binding(Json.object(args[0]));
    if (method === 'shader.bindings') return this.materials!.bindings(String(args[0]));
    if (method === 'shader.checkMaterial') { await this.materials!.load(String(args[0]), 'Material'); return { valid: true }; }
    return this.inspector.execute(method, args);
  }
  clear(): void { this.materials?.dispose(); this.materials = undefined; this.inspector = undefined; }
}
const lifecycle = new SceneLifecycle();
export const methods = { dispatch: (method: string, args: unknown[] = []): Promise<JsonValue> => lifecycle.dispatch(method, args) };
export const load = (): void => lifecycle.clear();
export const unload = (): void => lifecycle.clear();
