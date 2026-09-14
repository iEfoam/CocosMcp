import { join } from 'path';
import { SceneInspector } from '../../../packages/runtime3-bridge/src/scene.js';
import type { RuntimeObject } from '../../../packages/runtime3-bridge/src/access.js';
import type { JsonValue } from '../../../packages/contracts/src/index.js';

declare const Editor: { App: { path: string } };
declare const EditorExtends: { serialize(value: unknown): unknown };

class SceneLifecycle {
  private inspector: SceneInspector | undefined;
  dispatch(method: string, args: unknown[]): JsonValue {
    if (!this.inspector) {
      // cc 模块由 Creator 的场景进程提供，不能打包另一份引擎，否则对象类型和注册表会分裂。
      const engineModules = join(Editor.App.path, 'node_modules');
      if (!module.paths.includes(engineModules)) module.paths.push(engineModules);
      const cc = require('cc') as RuntimeObject;
      this.inspector = new SceneInspector({ cc, major: 3, serialize: value => EditorExtends.serialize(value), editor: true });
    }
    return this.inspector.execute(method, args);
  }
  clear(): void { this.inspector = undefined; }
}
const lifecycle = new SceneLifecycle();
export const methods = { dispatch: (method: string, args: unknown[] = []): JsonValue => lifecycle.dispatch(method, args) };
export const load = (): void => lifecycle.clear();
export const unload = (): void => lifecycle.clear();
