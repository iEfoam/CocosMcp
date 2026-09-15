import { Ajv } from 'ajv';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { ClipDocumentModel } from '../../animation-core/src/index.js';
import { RuntimeAccess as A } from './access.js';
import type { MaterialController } from './material.js';
import type { SceneInspector } from './scene.js';

export class AnimationTools {
  constructor(private readonly inspector: SceneInspector, private readonly assets: MaterialController) {}
  serialize(p: JsonObject): JsonValue {
    const document = new ClipDocumentModel().parse(p.document), root = this.inspector.node(Json.string(p.rootId, 'rootId'));
    for (const spec of document.tracks) {
      let node = root;
      for (const part of spec.path ? spec.path.split('/') : []) {
        const matches = (node.children as Record<string, unknown>[]).filter(child => child.name === part);
        if (matches.length !== 1) throw new CocosError('INVALID_ARGUMENT', `Animation target is missing or ambiguous: ${spec.path}`);
        node = matches[0]!;
      }
    }
    const cc = this.inspector.environment.cc, animation = A.object(cc.animation);
    const clip = A.object(A.construct(cc.AnimationClip, []));
    try {
      clip.name = document.name; clip.duration = document.duration;
      for (const spec of document.tracks) {
        const track = A.object(A.construct(animation.VectorTrack, [])), path = A.object(A.construct(animation.TrackPath, []));
        if (spec.path) A.call(path, 'toHierarchy', spec.path);
        A.call(path, 'toProperty', spec.property); track.path = path; track.componentsCount = 3;
        const channels = A.call(track, 'channels') as Record<string, unknown>[];
        for (const [index, axis] of ['x', 'y', 'z'].entries()) A.call(channels[index]!.curve, 'assignSorted', spec.keys.map(frame => [frame.time, { value: frame.value[axis as 'x' | 'y' | 'z'], interpolationMode: frame.interpolation === 'constant' ? 1 : 0 }]));
        A.call(clip, 'addTrack', track);
      }
      if (!this.inspector.environment.serialize) throw new CocosError('CONTEXT_UNAVAILABLE', 'Native editor serialization is required');
      return Json.value(this.inspector.environment.serialize(clip));
    } finally { A.destroyOwned(cc, clip); }
  }
  patchSource(p: JsonObject): JsonValue {
    const validate = new Ajv({ strict: true }).compile(ClipDocumentModel.patchesSchema);
    if (!validate(p.patches)) throw new CocosError('INVALID_ARGUMENT', 'Invalid animation patches');
    const patches = p.patches as JsonObject[], indices = patches.map(row => Number(row.trackIndex));
    if (new Set(indices).size !== indices.length) throw new CocosError('INVALID_ARGUMENT', 'Duplicate animation patch index');
    const cc = this.inspector.environment.cc, details = A.construct(A.object(cc.deserialize).Details, []);
    // 使用原生反序列化建立独立副本；外部资源引用尚未实现解析，必须拒绝，不能静默丢引用。
    const clone = A.object(A.call(cc, 'deserialize', Json.string(p.content, 'content'), details));
    try {
      if (typeof cc.AnimationClip !== 'function' || !(clone instanceof cc.AnimationClip)) throw new CocosError('INVALID_ARGUMENT', 'Source is not an AnimationClip');
      if ((details.uuidList as unknown[] ?? []).length) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Clip patching does not support external resource references');
      const tracks = Array.from(clone.tracks as Iterable<Record<string, unknown>>);
      const document = new ClipDocumentModel().parse({ name: String(clone.name), duration: Number(clone.duration), tracks: patches.map(row => ({ path: String(row.trackIndex), property: 'position', keys: row.keys })) });
      for (const [index, patch] of patches.entries()) {
        const track = tracks[Number(patch.trackIndex)], type = A.object(cc.animation).VectorTrack;
        if (!track || typeof type !== 'function' || !(track instanceof type) || track.componentsCount !== 3) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Only existing 3D VectorTrack channels can be patched');
        const channels = A.call(track, 'channels') as Record<string, unknown>[];
        for (const [axisIndex, axis] of ['x', 'y', 'z'].entries()) A.call(channels[axisIndex]!.curve, 'assignSorted', document.tracks[index]!.keys.map(frame => [frame.time, { value: frame.value[axis as 'x' | 'y' | 'z'], interpolationMode: frame.interpolation === 'constant' ? 1 : 0 }]));
      }
      if (!this.inspector.environment.serialize) throw new CocosError('CONTEXT_UNAVAILABLE', 'Editor serializer unavailable');
      return Json.value(this.inspector.environment.serialize(clone));
    } finally { if (typeof clone.destroy === 'function') A.destroyOwned(cc, clone); }
  }
  async inspect(p: JsonObject): Promise<JsonValue> {
    const clip = await this.assets.load(Json.string(p.uuid, 'uuid'), 'AnimationClip'), rows: JsonObject[] = [];
    let count = 0;
    for (const track of clip.tracks as Iterable<Record<string, unknown>>) {
      if (rows.length >= 128) throw new CocosError('INVALID_ARGUMENT', 'Clip has more than 128 tracks');
      const channels: JsonObject[] = [];
      for (const channel of A.call(track, 'channels') as Iterable<Record<string, unknown>>) {
        const curve = A.object(channel.curve), keyFramesCount = Number(curve.keyFramesCount); count += keyFramesCount;
        if (count > 12000 || !Number.isFinite(count)) throw new CocosError('INVALID_ARGUMENT', 'Clip inspection exceeds 12000 channel keys');
        channels.push({ name: String(channel.name ?? ''), keyFramesCount, times: Array.from(A.call(curve, 'times') as Iterable<number>),
          ...(p.time === undefined ? {} : { sampledValue: keyFramesCount ? A.safeData(A.call(curve, 'evaluate', p.time)) : null }) });
      }
      rows.push({ type: this.inspector.type(track), channels });
    }
    return { uuid: A.uuid(clip), name: String(clip.name), duration: Number(clip.duration), sample: Number(clip.sample), wrapMode: Number(clip.wrapMode), rows,
      scope: p.time === undefined ? 'native-track-channels' : 'native-curve-evaluation', limitations: ['曲线采样不会应用到场景，也不触发动画事件；不等于实际姿态或播放验收'] };
  }
}
