import { Ajv } from 'ajv';
import { CocosError, type JsonSchema } from '../../contracts/src/index.js';
import { Schema as S } from '../../capability-catalog/src/schema.js';

export interface TwoDClipDocument {
  name: string; duration: number; loop?: boolean;
  events?: Array<{ time: number; method: string; params?: string[] }>;
  tracks: Array<{ path: string; kind: 'spriteFrame' | 'opacity' | 'color'; keys: Array<{ time: number; value: string | number | { r: number; g: number; b: number; a: number }; interpolation?: 'linear' | 'constant' }> }>;
}
export class TwoDClipModel {
  static readonly schema: JsonSchema = S.object({ name: { type: 'string', minLength: 1, maxLength: 128 }, duration: { type: 'number', exclusiveMinimum: 0, maximum: 600 }, loop: S.boolean(),
    events: { type: 'array', maxItems: 128, items: S.object({ time: { type: 'number', minimum: 0, maximum: 600 }, method: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9]{0,63}$' }, params: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 256 } } }, ['time', 'method']) },
    tracks: { type: 'array', minItems: 1, maxItems: 64, items: { oneOf: ['spriteFrame', 'opacity', 'color'].map(kind => S.object({
      path: { type: 'string', maxLength: 512 }, kind: { const: kind }, keys: { type: 'array', minItems: 1, maxItems: 1000, items: S.object({ time: { type: 'number', minimum: 0, maximum: 600 },
        value: kind === 'spriteFrame' ? S.string() : kind === 'opacity' ? { type: 'number', minimum: 0, maximum: 255 } : S.object(Object.fromEntries(['r', 'g', 'b', 'a'].map(key => [key, { type: 'number', minimum: 0, maximum: 255 }])), ['r', 'g', 'b', 'a']),
        interpolation: S.enum('linear', 'constant') }, ['time', 'value']) },
    }, ['path', 'kind', 'keys'])) } },
  }, ['name', 'duration', 'tracks']);
  parse(value: unknown): TwoDClipDocument {
    if (!new Ajv({ strict: true }).compile(TwoDClipModel.schema)(value)) throw new CocosError('INVALID_ARGUMENT', 'Invalid 2D clip document');
    const doc = value as TwoDClipDocument, seen = new Set<string>(); let count = 0;
    for (const track of doc.tracks) {
      if (track.path && track.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new CocosError('INVALID_ARGUMENT', 'Relative unambiguous node paths required');
      const key = `${track.path}:${track.kind}`;
      if (seen.has(key)) throw new CocosError('INVALID_ARGUMENT', 'Duplicate track target'); seen.add(key);
      let previous = -1;
      for (const frame of track.keys) {
        if (frame.time <= previous || frame.time > doc.duration || ++count > 4000) throw new CocosError('INVALID_ARGUMENT', 'Invalid keyframe order, duration or budget');
        if (track.kind === 'spriteFrame' && frame.interpolation === 'linear') throw new CocosError('INVALID_ARGUMENT', 'SpriteFrame keys are discrete');
        previous = frame.time;
      }
    }
    for (const event of doc.events ?? []) if (event.time > doc.duration || ['constructor', 'destroy', 'destroyImmediate', 'onDestroy', 'onLoad', 'onEnable', 'onDisable'].includes(event.method)) throw new CocosError('INVALID_ARGUMENT', 'Unsafe event method or event beyond duration');
    return doc;
  }
}
