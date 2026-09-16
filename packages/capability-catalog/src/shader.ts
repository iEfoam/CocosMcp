import type { Capability, Effect, JsonSchema } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';

/** Shader 能力单独维护；原生编译器只对已核查的精确版本开放。 */
export class ShaderCapabilities {
  list(): Capability[] {
    const rows: Capability[] = [];
    const str = S.string(); const obj = S.record(); const integer = S.integer();
    const materialProperties = { ...S.record(), description: '材质属性值映射，不是 Pass property 声明。标量用 number/boolean；颜色 {type:"color",value:[255,255,255,255]}（0..255）；向量 {type:"vec4",value:[1,1,1,1]}；纹理 {type:"texture",uuid:"资源 UUID"}。也接受完整 r/g/b/a 或 x/y/z/w 分量对象。数组表示 uniform 数组，不自动猜测向量。' };
    const url = { url: str }; const guard = { ...url, expectedHash: str };
    const material = { ...guard, properties: materialProperties, defines: obj, states: obj, technique: integer, passIndex: integer };
    const target = { componentId: str, slot: integer };
    const add = (id: string, title: string, effect: Effect, properties: Record<string, JsonSchema>, required: string[] = []): void => {
      rows.push({ id, title, description: title, module: 'F22', context: id.startsWith('runtime.') ? 'runtime' : 'editor', effect,
        inputSchema: S.object(properties, required), outputSchema: { type: 'object' }, versions: [3], supportedMajors: [3],
        implementation: 'implemented', verification: 'unverified', platforms: [id.startsWith('runtime.') ? 'development-runtime' : 'editor'],
        prerequisites: ['Creator 3.8.8；其他版本先查询 shader.environment'],
        ...(effect !== 'read' ? { rollback: '使用本次资源备份或 runtime.material.reset；恢复前校验当前版本，禁止全局撤销' } : {}) });
    };
    add('shader.environment', '查询 Shader 工具链、精确版本与验证边界', 'read', {});
    add('shader.templates', '查询当前引擎的 Effect 模板与源码', 'read', { name: str });
    add('shader.read', '读取 Effect/Chunk 源码及内容哈希', 'read', url, ['url']);
    add('shader.create', '创建 Effect/Chunk 并通过 AssetDB 导入', 'asset', { ...url, content: str }, ['url', 'content']);
    add('shader.update', '带源码哈希守卫更新 Effect/Chunk 并备份', 'asset', { ...guard, content: str }, ['url', 'expectedHash', 'content']);
    for (const id of ['inspect', 'validate', 'dependencies']) add(`shader.${id}`, `读取 Shader ${id} 结果及原生诊断`, 'read', url, ['url']);
    add('shader.compile', '原生 Effect 编译；返回任务及源码依赖指纹', 'read', { ...url, includeSource: S.boolean() }, ['url']);
    add('shader.diagnostics', '查询编译任务并检查源码是否已过期', 'read', { taskId: str }, ['taskId']);
    add('shader.variants.plan', '生成有数量上限的宏组合计划', 'read', { axes: S.record(), limit: { type: 'integer', minimum: 1, maximum: 256 } }, ['axes']);
    add('shader.restore', '仅当当前源码匹配时恢复本次资源备份', 'asset', { backupId: str, expectedHash: str }, ['backupId', 'expectedHash']);
    add('shader.preview.connect', '将已打开的 MCP 预览连接到本工程开发运行时网关', 'runtime', { gatewayPort: { type: 'integer', minimum: 1, maximum: 65535 } });
    add('material.query', '读取持久化材质和源码哈希', 'read', url, ['url']);
    add('material.create', '通过引擎初始化和序列化创建材质', 'asset', { ...material, effectUrl: str }, ['url', 'effectUrl']);
    add('material.clone', '复制材质资源到新路径', 'asset', { sourceUrl: str, targetUrl: str }, ['sourceUrl', 'targetUrl']);
    add('material.update', '在副本上验证材质参数后保存并备份', 'asset', material, ['url', 'expectedHash']);
    add('material.migrate', '预览或应用 Effect 切换及参数迁移', 'asset', { ...material, effectUrl: str, apply: S.boolean() }, ['url', 'effectUrl', 'expectedHash']);
    for (const id of ['properties', 'defines', 'states']) add(`material.${id}`, `查询材质 ${id} 与 Pass 数据`, 'read', url, ['url']);
    add('material.bindings', '查询当前场景材质引用和资源使用者', 'read', url, ['url']);
    add('material.assign', '带旧引用守卫绑定组件材质槽并读回', 'scene', { ...target, materialUuid: str, expectedMaterialUuid: { type: 'string' } }, ['componentId', 'materialUuid', 'expectedMaterialUuid']);
    add('material.apply_runtime', '保存用户选定的运行时参数快照', 'asset', { ...guard, properties: materialProperties, defines: obj, states: obj, passIndex: integer }, ['url', 'expectedHash', 'properties']);
    add('runtime.material.inspect', '查询组件材质实际参数与覆盖', 'read', target, ['componentId']);
    add('runtime.material.update', '创建独立材质实例并原子替换，失败保留原对象', 'runtime', { ...target, properties: materialProperties, defines: obj, states: obj, passIndex: integer }, ['componentId']);
    add('runtime.material.reset', '恢复本工具修改的材质绑定并销毁自有实例', 'runtime', target, ['componentId']);
    add('runtime.material.compile', '编译当前材质 Pass 并报告真实引擎返回值', 'runtime', target, ['componentId']);
    add('runtime.shader.variants.compile', '以临时实例验证有上限的宏组合', 'runtime', { ...target, axes: obj, limit: { type: 'integer', minimum: 1, maximum: 256 } }, ['componentId', 'axes']);
    add('runtime.shader.preview.open', '创建独立相机和测试几何体的 Shader 预览', 'runtime', { materialUuid: str, shape: S.enum('sphere', 'quad', 'cube'), width: { type: 'integer', minimum: 16, maximum: 2048 }, height: { type: 'integer', minimum: 16, maximum: 2048 } }, ['materialUuid']);
    add('runtime.shader.preview.update', '更新预览实例参数', 'runtime', { properties: materialProperties, defines: obj, states: obj, passIndex: integer });
    add('runtime.shader.preview.capture', '读取预览 RenderTexture 像素并生成图像', 'read', {});
    add('runtime.shader.preview.compare', '比较本次预览与已保存的运行时基线', 'read', { baselineId: str, tolerance: { type: 'number', minimum: 0, maximum: 1 } }, ['baselineId']);
    add('runtime.shader.preview.close', '释放预览自有节点、材质和纹理', 'runtime', {});
    add('runtime.shader.profile', '按真实帧事件采样整帧性能及预算；不伪称 GPU 耗时', 'read', { frames: { type: 'integer', minimum: 2, maximum: 300 }, warmupFrames: { type: 'integer', minimum: 1, maximum: 120 }, maxFrameMs: { type: 'number', exclusiveMinimum: 0, maximum: 1000 } });
    return rows;
  }
}
