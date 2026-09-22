import type { Capability } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';

export class TextureCapabilities {
  list(): Capability[] {
    const asset = { url: S.string() }, patch = { ...asset, textureUuid: S.string(), settings: { ...S.object({
      minfilter: S.enum('nearest', 'linear'), magfilter: S.enum('nearest', 'linear'), mipfilter: S.enum('none', 'nearest', 'linear'),
      wrapModeS: S.enum('repeat', 'clamp-to-edge', 'mirrored-repeat'), wrapModeT: S.enum('repeat', 'clamp-to-edge', 'mirrored-repeat'), anisotropy: { type: 'integer', minimum: 1, maximum: 16 },
    }), minProperties: 1 } };
    return [
      ['texture.inspect', '读取纹理源、导入元数据、子资源与引用者', 'read', S.object(asset, ['url'])],
      ['texture.plan_import', '预览纹理采样、Mipmap 与寻址设置修改', 'read', S.object(patch, ['url', 'settings'])],
      ['texture.apply_import', '按 planHash 修改纹理导入设置，备份并重导入验证 UUID', 'asset', S.object({ ...patch, planHash: S.string() }, ['url', 'settings', 'planHash'])],
      ['texture.restore_import', '按当前 expectedHash 恢复同资源的导入备份', 'asset', S.object({ ...asset, expectedHash: S.string(), backupId: { type: 'string', pattern: '^[a-f0-9-]{36}$' } }, ['url', 'expectedHash', 'backupId'])],
    ].map(([id, title, effect, inputSchema]) => ({ id, title, description: title, effect, inputSchema, module: 'F16', context: 'editor', outputSchema: {}, versions: [3], supportedMajors: [3], implementation: 'implemented', verification: 'unverified',
      prerequisites: ['Creator 3.8.8；仅本地工程已有 image/texture 资源'], rollback: 'texture.restore_import 带 backupId 与当前 expectedHash；不自动覆盖不确定导入结果',
    } as Capability));
  }
}
