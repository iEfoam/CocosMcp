import type { Capability } from '../../contracts/src/index.js';
import { ClipDocumentModel } from '../../animation-core/src/index.js';
import { Schema as S } from './schema.js';
export class AnimationCapabilities {
  list(): Capability[] {
    return [
      ['animation.clip.read', '读取动画源和 sourceHash，供守卫编辑使用', 'read', S.object({ url: S.string() }, ['url'])],
      ['animation.clip.patch', '按索引替换选定三维向量轨道关键帧；保留其他轨道并备份', 'asset', S.object({ url: S.string(), expectedHash: S.string(), patches: ClipDocumentModel.patchesSchema }, ['url', 'expectedHash', 'patches'])],
      ['animation.clip.restore', '按当前 sourceHash 恢复同 UUID 动画源备份', 'asset', S.object({ url: S.string(), expectedHash: S.string(), backupId: S.string() }, ['url', 'expectedHash', 'backupId'])],
      ['animation.clip.create', '原生序列化变换动画剪辑；写入前检查时间、轨道和目标路径', 'asset', S.object({ url: S.string(), rootId: S.string(), document: ClipDocumentModel.schema }, ['url', 'rootId', 'document'])],
      ['animation.clip.inspect', '查询原生动画剪辑轨道与通道关键帧时间', 'read', S.object({ uuid: S.string() }, ['uuid'])],
      ['animation.clip.sample', '只读求值原生动画曲线；不应用到节点或触发事件', 'read', S.object({ uuid: S.string(), time: { type: 'number', minimum: 0, maximum: 600 } }, ['uuid', 'time'])],
    ].map(([id, title, effect, inputSchema]) => ({ id, title, description: title, effect, inputSchema, module: 'F23', context: 'editor', outputSchema: {}, versions: [3], supportedMajors: [3], implementation: 'implemented', verification: 'unverified',
      prerequisites: ['Creator 3.8.8；首版创建仅 position/scale/eulerAngles，线性或常量插值'], rollback: '创建不覆盖已有资源；导入验证失败保留实际 URL/UUID 供检查，不盲目删除',
    } as Capability));
  }
}
