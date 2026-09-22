import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { ClipDocumentModel } from '../../../packages/animation-core/src/index.js';
import { TwoDClipModel } from '../../../packages/animation-core/src/two-d.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../../packages/runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../../packages/runtime3-bridge/src/scene.js';

export class Creator2Animation {
  constructor(private readonly inspector: SceneInspector, private readonly serialize: (value: unknown) => unknown, private readonly load: (uuid: string) => Promise<unknown>) {}
  private node(root: RuntimeObject, path: string): RuntimeObject {
    let target = root;
    for (const part of path.split('/').filter(Boolean)) {
      const matches = (target.children as RuntimeObject[]).filter(child => child.name === part);
      if (matches.length !== 1) throw new CocosError('INVALID_ARGUMENT', `Animation path must resolve uniquely: ${path}`);
      target = matches[0]!;
    }
    return target;
  }
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    const cc = this.inspector.environment.cc;
    if (id === 'animation.clip.patchSource') {
      const source = Json.object(JSON.parse(Json.string(p.content, 'content')));
      if (source.__type__ !== 'cc.AnimationClip') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Only standalone Creator 2 clip source can be patched');
      const curveData = Json.object(source.curveData), tracks: Array<{ props: JsonObject; property: string; path: string }> = [];
      const collect = (path: string, data: JsonObject): void => { const props = Json.object(data.props ?? {}); for (const property of Object.keys(props)) tracks.push({ props, property, path }); for (const properties of Object.values(Json.object(data.comps ?? {}))) for (const property of Object.keys(Json.object(properties))) tracks.push({ props: Json.object(properties), property, path }); };
      collect('', curveData); for (const [path,data] of Object.entries(Json.object(curveData.paths ?? {}))) collect(path, Json.object(data));
      const seen = new Set<number>();
      for (const patch of p.patches as JsonObject[]) {
        const index = Number(patch.trackIndex), track = tracks[index];
        if (seen.has(index) || !track || !['position','eulerAngles'].includes(track.property)) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Patch only unique position/eulerAngles vector tracks');
        seen.add(index);
        const validated = new ClipDocumentModel().parse({ name: String(source._name), duration: Number(source._duration), tracks: [{ path: track.path, property: track.property, keys: patch.keys }] });
        track.props[track.property] = validated.tracks[0]!.keys.map(key => ({ frame: key.time, value: { __type__: 'cc.Vec3', ...key.value }, curve: key.interpolation === 'constant' ? 'constant' : 'linear' }));
      }
      return source;
    }
    if (id === 'animation.clip.serialize' || id === 'animation2d.serialize') {
      const twoD = id.startsWith('animation2d'), doc = twoD ? new TwoDClipModel().parse(p.document) : new ClipDocumentModel().parse(p.document);
      const root = this.inspector.node(Json.string(p.rootId, 'rootId')), clip = A.construct(cc.AnimationClip, []);
      clip.name = doc.name; clip._duration = doc.duration; clip.sample = 60;
      const curves: RuntimeObject = { props: {}, paths: {} }; clip.curveData = curves;
      try {
        for (const track of doc.tracks) {
          const node = this.node(root, track.path);
          const target = track.path ? ((curves.paths as RuntimeObject)[track.path] ??= { props: {}, comps: {} }) as RuntimeObject : curves;
          let property: string, destination = A.object(target.props);
          if ('kind' in track) {
            property = track.kind;
            if (property === 'spriteFrame') { if (!A.call(node, 'getComponent', cc.Sprite)) throw new CocosError('INVALID_ARGUMENT', 'SpriteFrame track needs a Sprite component'); target.comps ??= {}; destination = ((target.comps as RuntimeObject)['cc.Sprite'] ??= {}) as RuntimeObject; }
          } else property = track.property;
          if (property === 'scale') {
            // 2.x Node.scale 是标量；以各轴轨道保留文档 Vec3 语义。
            for (const [axis, suffix] of [['x', 'X'], ['y', 'Y'], ['z', 'Z']] as const) destination[`scale${suffix}`] = track.keys.map(frame => ({ frame: frame.time, value: (frame.value as { x: number; y: number; z: number })[axis], curve: frame.interpolation === 'constant' ? 'constant' : 'linear' }));
          } else {
            const keys: RuntimeObject[] = [];
            for (const frame of track.keys) {
              let value: unknown = frame.value;
              if (property === 'spriteFrame') value = await this.load(String(value));
              else if (property === 'color') { const color = value as { r: number; g: number; b: number; a: number }; value = A.construct(cc.Color, [color.r, color.g, color.b, color.a]); }
              else if (typeof value === 'object') { const vector = value as { x: number; y: number; z: number }; value = A.construct(cc.Vec3, [vector.x, vector.y, vector.z]); }
              keys.push({ frame: frame.time, value, curve: frame.interpolation === 'constant' || property === 'spriteFrame' ? 'constant' : 'linear' });
            }
            destination[property] = keys;
          }
        }
        if ('loop' in doc) clip.wrapMode = doc.loop ? A.object(cc.WrapMode).Loop : A.object(cc.WrapMode).Normal;
        if ('events' in doc) clip.events = (doc.events ?? []).map(event => ({ frame: event.time, func: event.method, params: event.params ?? [] }));
        const serialized = this.serialize(clip); return typeof serialized === 'string' ? JSON.parse(serialized) as JsonValue : Json.value(serialized);
      } finally { A.call(clip, 'destroy'); }
    }
    const clip = A.object(await this.load(Json.string(p.uuid, 'uuid')));
    if (this.inspector.type(clip) !== 'cc.AnimationClip') throw new CocosError('INVALID_ARGUMENT', 'Expected AnimationClip');
    const data = A.object(clip.curveData), rows: JsonObject[] = [];
    const inspect = (path: string, value: RuntimeObject): void => {
      for (const [property, frames] of Object.entries(A.object(value.props ?? {}))) rows.push({ path, property, keys: A.safeData(frames) });
      for (const [component, props] of Object.entries(A.object(value.comps ?? {}))) for (const [property, frames] of Object.entries(A.object(props))) rows.push({ path, component, property, keys: A.safeData(frames) });
    };
    inspect('', data); for (const [path, value] of Object.entries(A.object(data.paths ?? {}))) inspect(path, A.object(value));
    if (id === 'animation.clip.sample') {
      const time = Number(p.time);
      for (const row of rows) {
        const keys = row.keys as JsonObject[]; if (!keys.length) continue;
        const index = keys.findIndex(key => Number(key.frame) > time), left = keys[index === -1 ? keys.length - 1 : Math.max(0, index - 1)]!, right = index < 0 ? left : keys[index]!;
        if (left.curve && !['linear', 'constant'].includes(String(left.curve))) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Read-only sample supports linear/constant curves; no motion paths or Bezier');
        if (keys.some(key => key.motionPath)) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Motion path sample requires native animation playback');
        const ratio = left === right || left.curve === 'constant' ? 0 : Math.max(0, Math.min(1, (time - Number(left.frame)) / (Number(right.frame) - Number(left.frame))));
        const lerp = (a: JsonValue, b: JsonValue): JsonValue => typeof a === 'number' && typeof b === 'number' ? a + (b-a)*ratio : a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b) && !('uuid' in a) ? Object.fromEntries(Object.entries(a).map(([key,value]) => [key, lerp(value,b[key] ?? value)])) : a;
        row.value = lerp(left.value!, right.value!); delete row.keys;
      }
    }
    return { uuid: A.uuid(clip), name: String(clip.name), duration: Number(clip.duration), rows, events: A.safeData(clip.events), applied: false };
  }
}
