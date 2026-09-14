import { networkInterfaces } from 'node:os';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import type { EditorPort } from './port.js';

export class PreviewService {
  constructor(private readonly port: EditorPort) {}

  async execute(id: string, params: JsonObject): Promise<JsonValue> {
    if (!this.port.preview) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Managed preview host is unavailable');
    if (this.port.version !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Managed preview requires the inspected Creator 3.8.8 API');
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
