import type { Capability, JsonSchema } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';

export class SceneProductionCapabilities {
  list(): Capability[] {
    const rows: Capability[] = [], str = S.string();
    const vector = S.object({ x: S.number(), y: S.number(), z: S.number() }, ['x', 'y', 'z']);
    const bounded = (minimum: number, maximum: number): JsonSchema => ({ type: 'number', minimum, maximum });
    const add = (id: string, title: string, effect: Capability['effect'], properties: Record<string, JsonSchema>, required: string[] = []): void => {
      rows.push({ id, title, description: title, module: id.startsWith('geometry.') ? 'F21' : 'F31', context: 'editor', effect,
        inputSchema: S.object(properties, required), outputSchema: {}, versions: [3], supportedMajors: [3], implementation: 'implemented', verification: 'unverified',
        prerequisites: ['Creator 3.8.8；修改后需显式 scene.save'], rollback: '失败时返回本次创建目标和已完成步骤；不撤销用户修改或自动删除已导入资源' });
    };
    add('geometry.create', '生成带参数及真实倒角的 Cube/Cylinder/Sphere/Torus 资源并创建场景节点', 'asset', {
      name: str, url: str, shape: S.enum('cube', 'cylinder', 'sphere', 'torus'), parentId: str, materialUuid: str, position: vector, rotation: vector,
      options: S.object({ size: vector, bevel: bounded(0, 5000), radius: bounded(0.001, 10000), height: bounded(0.001, 10000),
        tubeRadius: bounded(0.0001, 10000), tubeHeight: bounded(0.0001, 10000), segments: { type: 'integer', minimum: 8, maximum: 128 } }),
    }, ['name', 'url', 'shape', 'materialUuid']);
    add('geometry.array', '复制节点子树生成有限重复阵列，保留原节点并读回每份变换', 'scene', {
      nodeId: str, count: { type: 'integer', minimum: 1, maximum: 100 }, offset: vector, rotationStep: vector, namePrefix: str,
    }, ['nodeId', 'count', 'offset']);
    add('rendering.query', '读取当前场景全局渲染设置与指定相机后处理；明确 AO 和透射边界', 'read', { cameraNodeId: str });
    add('rendering.configure', '设置 Builtin 相机 Bloom/FXAA 与真实阴影图，逐项读回', 'scene', {
      cameraNodeId: str, lightComponentId: str,
      bloom: S.object({ enabled: S.boolean(), threshold: bounded(0, 100), intensity: bounded(0, 10), iterations: { type: 'integer', minimum: 1, maximum: 6 } }, ['enabled']),
      fxaa: S.boolean(), editorPreview: S.boolean(),
      shadows: S.object({ enabled: S.boolean(), resolution: { type: 'integer', enum: [512, 1024, 2048, 4096] }, pcf: { type: 'integer', minimum: 0, maximum: 3 }, bias: bounded(0, 1), normalBias: bounded(0, 1) }, ['enabled']),
      ambientOcclusion: S.enum('unchanged', 'hbao'), transmission: S.enum('unchanged', 'physical'),
    });
    add('rendering.planar_reflection', '创建平面反射探针，绑定真实相机和 MeshRenderer，验证引用', 'scene', {
      name: str, cameraComponentId: str, rendererComponentIds: { type: 'array', items: str, minItems: 1, maxItems: 200, uniqueItems: true }, position: vector, size: vector,
      resolution: { type: 'integer', enum: [128, 256, 512, 1024] },
    }, ['name', 'cameraComponentId', 'rendererComponentIds', 'position', 'size']);
    return rows;
  }
}
