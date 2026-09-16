import { networkInterfaces } from 'node:os';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import type { EditorPort } from './port.js';

export class PreviewService {
  constructor(private readonly port: EditorPort) {}

  async execute(id: string, params: JsonObject): Promise<JsonValue> {
    if (!this.port.preview) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Managed preview host is unavailable');
    if (this.port.version !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Managed preview requires the inspected Creator 3.8.8 API');
    if (id === 'preview.validate_viewports') {
      if (!Array.isArray(params.rows) || !params.rows.length || params.rows.length > 8) throw new CocosError('INVALID_ARGUMENT', 'Expected 1..8 viewports');
      const initial = Json.object(await this.port.preview('status', {}));
      if (!initial.running || !Array.isArray(initial.viewport)) throw new CocosError('CONTEXT_UNAVAILABLE', 'Start a dedicated preview first');
      const rows: JsonObject[] = []; let failure: unknown;
      try {
        for (const row of params.rows) {
          const current = Json.object(await this.port.preview('status', {}));
          if (!current.running || current.sceneId !== initial.sceneId || current.diagnosticSessionId !== initial.diagnosticSessionId) throw new CocosError('STALE_HANDLE', 'Preview session changed during viewport capture');
          const viewport = Json.object(row);
          rows.push(Json.object(await this.port.preview('resize', viewport)));
        }
      } catch (error) { failure = error; }
      finally {
        try {
          const current = Json.object(await this.port.preview('status', {}));
          // 同场景重新启动也是另一个窗口；不能把旧尺寸写入新的用户会话。
          if (current.running && current.sceneId === initial.sceneId && current.diagnosticSessionId === initial.diagnosticSessionId) await this.port.preview('resize', { width: initial.viewport[0]!, height: initial.viewport[1]! });
          else failure ??= new CocosError('STALE_HANDLE', 'Preview changed; viewport not restored');
        } catch (error) { failure ??= error; }
      }
      if (failure) throw new CocosError('OUTCOME_UNKNOWN', 'Viewport capture incomplete', { rows, cause: CocosError.from(failure).message });
      return { rows, restored: true, layoutVerified: false, limitations: ['实际多尺寸绘制截图，需视觉审查；不模拟真机安全区或输入法'] };
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
      return this.port.preview('start', { ...params, url: localUrl.href, sceneId: info.sceneId! });
    }
    return this.port.preview(id.slice('preview.'.length), params);
  }
}
