import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { TextureService } from '../../creator3-adapter/src/texture.js';
import type { Creator2Port } from './index.js';

/** 用独立元数据视图复用备份/指纹协议；落盘前还原为 2.x 根层字段。 */
export class Creator2Texture {
  constructor(private readonly port: Creator2Port, private readonly users: (url: string) => Promise<JsonValue>) {}
  private normalize(meta: JsonObject): JsonObject {
    const { subMetas, ...fields } = meta;
    const userData: JsonObject = { ...fields };
    if (meta.importer === 'texture') Object.assign(userData, {
      minfilter: meta.filterMode === 'point' ? 'nearest' : 'linear', magfilter: meta.filterMode === 'point' ? 'nearest' : 'linear',
      mipfilter: meta.genMipmaps ? 'linear' : 'none', wrapModeS: meta.wrapMode === 'clamp' ? 'clamp-to-edge' : meta.wrapMode === 'mirror' ? 'mirrored-repeat' : 'repeat', wrapModeT: meta.wrapMode === 'clamp' ? 'clamp-to-edge' : meta.wrapMode === 'mirror' ? 'mirrored-repeat' : 'repeat',
    });
    return { ...fields, userData, subMetas: Object.fromEntries(Object.entries(Json.object(subMetas ?? {})).map(([key, child]) => [key, this.normalize(Json.object(child))])) };
  }
  private native(meta: JsonObject): JsonObject {
    const { userData, subMetas, ...fields } = meta, values = Json.object(userData);
    const native: JsonObject = { ...fields, ...values };
    if (meta.importer === 'texture') {
      if (values.minfilter !== values.magfilter || values.wrapModeS !== values.wrapModeT || values.anisotropy !== undefined || values.mipfilter === 'nearest') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Creator 2 uses one filterMode/wrapMode and cannot represent independent samplers, nearest mip filtering or anisotropy');
      if (values.mipfilter === 'linear' && values.minfilter === 'nearest') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Creator 2 cannot represent nearest sampling with linear mip filtering');
      native.filterMode = values.minfilter === 'nearest' ? 'point' : values.mipfilter === 'linear' ? 'trilinear' : 'bilinear';
      native.genMipmaps = values.mipfilter !== 'none'; native.wrapMode = values.wrapModeS === 'clamp-to-edge' ? 'clamp' : values.wrapModeS === 'mirrored-repeat' ? 'mirror' : 'repeat';
      for (const key of ['minfilter', 'magfilter', 'mipfilter', 'wrapModeS', 'wrapModeT', 'anisotropy']) delete native[key];
    }
    native.subMetas = Object.fromEntries(Object.entries(Json.object(subMetas ?? {})).map(([key, child]) => [key, this.native(Json.object(child))]));
    return native;
  }
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    if (this.port.version !== '2.4.15') throw new CocosError('UNSUPPORTED_VERSION', 'Texture adapter requires Creator 2.4.15');
    if (id.startsWith('spriteframe.') && p.settings && Json.object(p.settings).packable !== undefined) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Creator 2 packable belongs to the source texture, not an individual SpriteFrame');
    const service = new TextureService({ version: '2.4.15', projectPath: this.port.projectPath, request: async (_channel, message, ...args) => {
      const url = String(args[0]);
      if (message === 'query-asset-info') return this.port.asset('assetInfo', url);
      if (message === 'query-asset-meta') return this.normalize(Json.object(Json.value(await this.port.asset('loadMeta', url))));
      if (message === 'query-asset-users') return this.users(url);
      if (message === 'save-asset-meta') return this.port.asset('saveMeta', await this.port.asset('urlToUuid', url), JSON.stringify(this.native(Json.object(JSON.parse(String(args[1]))))));
      if (message === 'reimport-asset') return this.port.asset('refresh', url);
      throw new CocosError('UNSUPPORTED_CAPABILITY', message);
    } }, id.startsWith('spriteframe.') ? 'spriteframe' : 'texture');
    // 在计划阶段检查能否无损映射，避免用户批准后才发现不可表示。
    if (id.endsWith('.plan') || id.endsWith('.plan_import')) {
      const plan = Json.object(await service.execute(id, p)); this.native(Json.object(plan.plannedMeta)); return plan;
    }
    return service.execute(id, p);
  }
}
