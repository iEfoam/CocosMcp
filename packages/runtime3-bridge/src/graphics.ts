import { CocosError, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';

/** 只查询引擎已创建的设备，不创建 GPU 对象，也不把引擎计数当作驱动总显存。 */
export class GraphicsInspector {
  constructor(private readonly cc: RuntimeObject) {}
  private number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
  execute(id: string, p: JsonObject): JsonValue {
    if (!['runtime.graphics.inspect', 'runtime.graphics.formats'].includes(id)) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Unknown graphics query');
    const root = A.object(A.object(this.cc.director).root, 'render root'), device = A.object(root.device, 'graphics device'), gfx = A.object(this.cc.gfx, 'gfx module');
    if (id === 'runtime.graphics.formats') {
      if (!Array.isArray(p.formats) || !p.formats.length || p.formats.length > 64 || new Set(p.formats).size !== p.formats.length) throw new CocosError('INVALID_ARGUMENT', 'Provide 1–64 unique format names');
      const formats = A.object(gfx.Format), bits = A.object(gfx.FormatFeatureBit);
      const names = p.formats.map(name => {
        if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name) || ['UNKNOWN', 'COUNT'].includes(name) || !Object.hasOwn(formats, name) || !Number.isInteger(formats[name])) throw new CocosError('INVALID_ARGUMENT', `Unknown concrete gfx format: ${String(name)}`);
        return name;
      });
      return { rows: names.map(name => {
        const flags = A.call(device, 'getFormatFeatures', formats[name]);
        if (typeof flags !== 'number' || !Number.isInteger(flags) || flags < 0) throw new CocosError('CONTEXT_UNAVAILABLE', 'Native format features unavailable');
        return { name, flags, supportedUsages: Object.entries(bits).filter(([key, bit]) => /^[A-Z]/.test(key) && typeof bit === 'number' && bit > 0 && (flags & bit) === bit).map(([key]) => key) };
      }), scope: 'engine-device-format-features', allocationVerified: false };
    }
    const caps = A.object(device.capabilities), memory = A.object(device.memoryStatus), features = A.object(gfx.Feature), api = A.object(gfx.API);
    const limits: JsonObject = {};
    for (const key of ['maxVertexAttributes', 'maxVertexUniformVectors', 'maxFragmentUniformVectors', 'maxTextureUnits', 'maxImageUnits', 'maxVertexTextureUnits', 'maxColorRenderTargets', 'maxShaderStorageBufferBindings', 'maxShaderStorageBlockSize', 'maxUniformBufferBindings', 'maxUniformBlockSize', 'maxTextureSize', 'maxCubeMapTextureSize', 'maxArrayTextureLayers', 'max3DTextureSize', 'uboOffsetAlignment', 'maxComputeSharedMemorySize', 'maxComputeWorkGroupInvocations']) limits[key] = this.number(caps[key]);
    return { backend: typeof api[String(device.gfxAPI)] === 'string' ? String(api[String(device.gfxAPI)]) : 'unknown', renderer: typeof device.renderer === 'string' ? device.renderer : null, vendor: typeof device.vendor === 'string' ? device.vendor : null,
      limits, features: Object.entries(features).filter(([name, value]) => name !== 'COUNT' && /^[A-Z]/.test(name) && typeof value === 'number').map(([name, value]) => { const supported = A.call(device, 'hasFeature', value); return { name, supported: typeof supported === 'boolean' ? supported : null }; }),
      memory: { bufferBytes: this.number(memory.bufferSize), textureBytes: this.number(memory.textureSize), scope: 'engine-accounted-allocations', driverTotalBytes: null },
      counters: { drawCalls: this.number(device.numDrawCalls), instances: this.number(device.numInstances), triangles: this.number(device.numTris), scope: 'currently-recorded-not-frame-synchronized' }, backendVerified: false };
  }
}
