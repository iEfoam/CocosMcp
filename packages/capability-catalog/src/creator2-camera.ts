import type { Capability } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';

export class Creator2CameraCapabilities {
  list(): Capability[] {
    const coordinate = { type: 'number', minimum: -10000000, maximum: 10000000 };
    const capabilities: Capability[] = ['inspect', 'convert', 'culling'].map(action => ({ id: `runtime.camera.${action}`, title: `Creator 2 相机诊断：${action}`,
      description: '读取相机状态、2D/3D 屏幕/世界坐标转换，3D 屏幕 z 统一为 0..1 投影深度或分组掩码，不把掩码匹配当作最终可见。', module: 'F20', context: 'runtime', effect: 'read',
      inputSchema: S.object({ componentId: S.string(), ...(action === 'convert' ? { direction: S.enum('world-to-screen', 'screen-to-world'), point: S.object({ x: coordinate, y: coordinate, z: coordinate }, ['x', 'y']) } : action === 'culling' ? { nodeId: S.string() } : {}) },
        ['componentId', ...(action === 'convert' ? ['direction', 'point'] : action === 'culling' ? ['nodeId'] : [])]),
      outputSchema: {}, versions: [2], supportedMajors: [2], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 2.4.15；convert：2D 要求屏幕对齐，3D 要求显式非屏幕对齐投影和 z'], rollback: '只读，不改变相机或渲染目标' }));
    capabilities.push({ ...capabilities[0]!, id: 'runtime.camera.sample_pixels', title: '采样 Creator 2 相机离屏像素', description: '临时纹理渲染并读取至多 64 个 RGBA 像素，恢复目标并释放临时 GPU 对象。', effect: 'runtime', inputSchema: S.object({ componentId: S.string(), rootId: S.string(), width: { type: 'integer', minimum: 1, maximum: 512 }, height: { type: 'integer', minimum: 1, maximum: 512 }, points: { ...S.array(S.object({ x: S.integer(), y: S.integer() }, ['x', 'y'])), minItems: 1, maxItems: 64 } }, ['componentId', 'width', 'height', 'points']), rollback: 'finally 恢复相机目标和节点变换，销毁临时纹理、FBO、深度模板缓冲；清理失败返回 OUTCOME_UNKNOWN' });
    return capabilities;
  }
}
