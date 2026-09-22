import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { TwoDClipModel } from '../../animation-core/src/two-d.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import { FeatureSupport as F } from './feature-support.js';
import type { SceneInspector } from './scene.js';
import type { MaterialController } from './material.js';

export class TwoDAnimationAuthoring {
  constructor(private readonly scene: SceneInspector, private readonly assets: MaterialController) {}
  async serialize(p: JsonObject): Promise<JsonValue> {
    const doc = new TwoDClipModel().parse(p.document), root = this.scene.node(Json.string(p.rootId, 'rootId')), cc = this.scene.environment.cc;
    const animation = F.require(cc.animation, 'animation'), loaded = new Map<string, RuntimeObject>();
    for (const event of doc.events ?? []) {
      const matches = this.scene.components(root).filter(c => typeof c[event.method] === 'function');
      if (matches.length !== 1) throw new CocosError('INVALID_ARGUMENT', `Animation event requires exactly one root receiver: ${event.method}`);
    }
    for (const spec of doc.tracks) {
      let node = root;
      for (const part of spec.path ? spec.path.split('/') : []) {
        const matches = (node.children as RuntimeObject[]).filter(child => child.name === part);
        if (matches.length !== 1) throw new CocosError('INVALID_ARGUMENT', `Missing or ambiguous animation node ${spec.path}`);
        node = matches[0]!;
      }
      const type = spec.kind === 'opacity' ? 'cc.UIOpacity' : 'cc.Sprite';
      const matches = this.scene.components(node).filter(c => this.scene.type(c) === type);
      if (matches.length !== 1) throw new CocosError('INVALID_ARGUMENT', `Exactly one ${type} required at ${spec.path}`);
      if (spec.kind === 'spriteFrame') for (const frame of spec.keys) {
        const uuid = String(frame.value); if (!loaded.has(uuid)) loaded.set(uuid, await this.assets.load(uuid, 'SpriteFrame'));
      }
    }
    const clip = A.object(A.construct(cc.AnimationClip, []));
    try {
      clip.name = doc.name; clip.duration = doc.duration; clip.wrapMode = doc.loop ? 2 : 1;
      clip.events = (doc.events ?? []).map(event => ({ frame: event.time, func: event.method, params: event.params ?? [] }));
      for (const spec of doc.tracks) {
        const type = spec.kind === 'spriteFrame' ? 'ObjectTrack' : spec.kind === 'opacity' ? 'RealTrack' : 'ColorTrack';
        const track = A.object(A.construct(F.require(animation[type], type), [])), path = A.object(A.construct(animation.TrackPath, []));
        if (spec.path) A.call(path, 'toHierarchy', spec.path);
        A.call(path, 'toComponent', spec.kind === 'opacity' ? 'cc.UIOpacity' : 'cc.Sprite');
        A.call(path, 'toProperty', spec.kind); track.path = path;
        const channels = A.call(track, 'channels') as RuntimeObject[];
        for (const [index, channel] of channels.entries()) A.call(channel.curve, 'assignSorted', spec.keys.map(frame => {
          if (spec.kind === 'spriteFrame') return [frame.time, loaded.get(String(frame.value))];
          const value = spec.kind === 'opacity' ? frame.value : (frame.value as Record<string, number>)[['r', 'g', 'b', 'a'][index]!];
          return [frame.time, { value, interpolationMode: frame.interpolation === 'constant' ? 1 : 0 }];
        }));
        A.call(clip, 'addTrack', track);
      }
      if (!this.scene.environment.serialize) throw new CocosError('CONTEXT_UNAVAILABLE', 'Editor serializer required');
      return Json.value(this.scene.environment.serialize(clip));
    } finally { A.destroyOwned(cc, clip); }
  }
}
