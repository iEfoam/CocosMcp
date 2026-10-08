import { networkInterfaces } from 'node:os';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import type { EditorPort } from './port.js';
import { RoadmapCapabilities } from '../../capability-catalog/src/roadmap.js';

export class PreviewService {
  constructor(private readonly port: Pick<EditorPort, 'preview' | 'version' | 'request' | 'scene'>) {}

  async execute(id: string, params: JsonObject): Promise<JsonValue> {
    if (id === 'preview.presets') return { rows: RoadmapCapabilities.presets, trueDeviceSimulation: false };
    if (params.preset !== undefined) {
      const preset = RoadmapCapabilities.presets.find(row => row.id === params.preset);
      if (!preset) throw new CocosError('INVALID_ARGUMENT', 'Unknown preview preset');
      if ((params.width !== undefined && params.width !== preset.width) || (params.height !== undefined && params.height !== preset.height)) throw new CocosError('INVALID_ARGUMENT', 'Explicit size conflicts with preset');
      params = { ...params, width: preset.width, height: preset.height, orientation: preset.orientation };
    }
    if (!this.port.preview) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Managed preview host is unavailable');
    if (!['3.8.8', '2.4.15'].includes(this.port.version)) throw new CocosError('UNSUPPORTED_VERSION', 'Managed preview requires Creator 2.4.15 or 3.8.8');
    if (id === 'preview.runtime.connect') return this.port.preview('connect-runtime', params);
    if (id === 'preview.validate_viewports') {
      if (!Array.isArray(params.rows) || !params.rows.length || params.rows.length > 8) throw new CocosError('INVALID_ARGUMENT', 'Expected 1..8 viewports');
      const initial = Json.object(await this.port.preview('status', {}));
      if (!initial.running || !Array.isArray(initial.viewport)) throw new CocosError('CONTEXT_UNAVAILABLE', 'Start a dedicated preview first');
      const rows: JsonObject[] = []; let failure: unknown; let changedSize: JsonValue | undefined;
      try {
        for (const row of params.rows) {
          const current = Json.object(await this.port.preview('status', {}));
          if (!current.running || current.sceneId !== initial.sceneId || current.sceneGeneration !== initial.sceneGeneration || current.diagnosticSessionId !== initial.diagnosticSessionId) throw new CocosError('STALE_HANDLE', 'Preview session changed during viewport capture');
          const viewport = Json.object(row);
          changedSize = [viewport.width!, viewport.height!];
          rows.push(Json.object(await this.port.preview('resize', viewport)));
        }
      } catch (error) { failure = error; }
      finally {
        try {
          const current = Json.object(await this.port.preview('status', {}));
          // 同场景重新启动也是另一个窗口；不能把旧尺寸写入新的用户会话。
          if (changedSize === undefined) { /* 尚未成功改变窗口尺寸，无需恢复。 */ }
          else if (current.running && current.sceneId === initial.sceneId && current.sceneGeneration === initial.sceneGeneration && current.diagnosticSessionId === initial.diagnosticSessionId && Json.canonical(current.viewport!) === Json.canonical(changedSize)) await this.port.preview('resize', { width: initial.viewport[0]!, height: initial.viewport[1]! });
          else failure ??= new CocosError('STALE_HANDLE', 'Preview changed; viewport not restored');
        } catch (error) { failure ??= error; }
      }
      if (failure) throw new CocosError('OUTCOME_UNKNOWN', 'Viewport capture incomplete', { rows, cause: CocosError.from(failure).message });
      return { rows, restored: true, imageDelivery: params.imageDelivery ?? 'image', layoutVerified: false, limitations: ['实际多尺寸绘制截图，需视觉审查；不模拟真机安全区或输入法'] };
    }
    if (id === 'preview.start') {
      // 不自动保存用户工作，也不在旧预览仍运行时悄悄切换其场景。
      if (await this.port.request('scene', 'query-dirty')) throw new CocosError('RESOURCE_BUSY', 'Save the scene before starting its preview');
      const info = Json.object(await this.port.scene('sceneInfo'));
      const url = await this.port.request('preview', 'query-preview-url');
      if (typeof url !== 'string') throw new CocosError('EDITOR_ERROR', 'Creator did not return a preview URL');
      const localUrl = new URL(url);
      // Creator 默认返回本机局域网地址；只在地址确属本机接口时转换到回环，不放宽窗口的同源限制。
      const localAddresses = Object.values(networkInterfaces()).flatMap(rows => rows ?? []).map(row => row.address);
      if (localAddresses.includes(localUrl.hostname)) localUrl.hostname = '127.0.0.1';
      if (params.scene !== undefined && params.scene !== 'current' && params.scene !== info.sceneId) throw new CocosError('INVALID_ARGUMENT', 'Preview scene must be current or the current saved scene UUID');
      return this.port.preview('start', { ...params, target: params.target ?? 'embedded', url: localUrl.href, sceneId: info.sceneId! });
    }
    return this.port.preview(id.slice('preview.'.length), params);
  }
}
