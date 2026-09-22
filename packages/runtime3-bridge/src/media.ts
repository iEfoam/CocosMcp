import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import type { SceneInspector } from './scene.js';

export class MediaController {
  constructor(private readonly inspector: SceneInspector) {}
  private snapshot(component: RuntimeObject): JsonObject {
    const duration = Number(component.duration), time = Number(component.currentTime);
    return { currentTime: Number.isFinite(time) ? time : null, duration: Number.isFinite(duration) ? duration : null, state: A.safeData(component.state), enabled: Boolean(component.enabledInHierarchy), clipUuid: component.clip ? A.uuid(component.clip) : null };
  }
  execute(id: string, p: JsonObject): JsonValue {
    if (!/^runtime\.(audio|video)\.(state|play|pause|stop|seek)$/.test(id) && id !== 'runtime.webview.inspect') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Unknown media capability');
    const componentId = Json.string(p.componentId, 'componentId'), component = this.inspector.component(componentId), cc = this.inspector.environment.cc;
    const typeName = id.startsWith('runtime.audio.') ? 'AudioSource' : id.startsWith('runtime.video.') ? 'VideoPlayer' : 'WebView', type = cc[typeName];
    if (typeof type !== 'function') throw new CocosError('UNSUPPORTED_CAPABILITY', `${typeName} module is unavailable`);
    if (!(component instanceof type)) throw new CocosError('INVALID_ARGUMENT', `Target is not ${typeName}`);
    if (typeName === 'WebView') return { componentId, enabled: Boolean(component.enabledInHierarchy), hasUrl: Boolean(component.url), scope: 'component-configuration', pageLoaded: 'unknown' };
    const before = this.snapshot(component), action = id.split('.').at(-1)!;
    if (action === 'state') return { componentId, ...before, progressVerified: false };
    if (!['play', 'pause', 'stop', 'seek'].includes(action)) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Unknown media action');
    if (action === 'seek' && (!Number.isFinite(p.time) || Number(p.time) < 0 || !(Number(before.duration) > 0) || Number(p.time) > Number(before.duration))) throw new CocosError('INVALID_ARGUMENT', 'Media must have a known duration; seek time must be within it');
    try {
      if (action === 'seek') component.currentTime = p.time; else A.call(component, action);
      return { componentId, before, after: this.snapshot(component), progressVerified: false, restorePolicy: '由调用者根据 before 显式恢复；不重放结束事件，不在断线时停止游戏原有媒体' };
    } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Media action may have executed; query state and platform errors before retrying', { componentId, before, cause: CocosError.from(error).message }); }
  }
}
