import { Ajv } from 'ajv';
import { CocosError, type JsonSchema } from '../../contracts/src/index.js';
import { Schema as S } from '../../capability-catalog/src/schema.js';

export interface ClipDocument { name: string; duration: number; tracks: Array<{ path: string; property: 'position' | 'scale' | 'eulerAngles'; keys: Array<{ time: number; value: { x: number; y: number; z: number }; interpolation?: 'linear' | 'constant' }> }> }
export class ClipDocumentModel {
  static readonly schema: JsonSchema = S.object({ name: { type: 'string', minLength: 1, maxLength: 128 }, duration: { type: 'number', exclusiveMinimum: 0, maximum: 600 },
    tracks: { type: 'array', minItems: 1, maxItems: 64, items: S.object({ path: { type: 'string', maxLength: 512 }, property: S.enum('position', 'scale', 'eulerAngles'), keys: {
      type: 'array', minItems: 1, maxItems: 1000, items: S.object({ time: { type: 'number', minimum: 0, maximum: 600 }, value: S.object({ x: { type: 'number', minimum: -100000, maximum: 100000 }, y: { type: 'number', minimum: -100000, maximum: 100000 }, z: { type: 'number', minimum: -100000, maximum: 100000 } }, ['x', 'y', 'z']), interpolation: S.enum('linear', 'constant') }, ['time', 'value']),
    } }, ['path', 'property', 'keys']) },
  }, ['name', 'duration', 'tracks']);
  static readonly keysSchema = (((this.schema.properties as Record<string, JsonSchema>).tracks!.items as JsonSchema).properties as Record<string, JsonSchema>).keys!;
  static readonly patchesSchema: JsonSchema = { type: 'array', minItems: 1, maxItems: 64, items: S.object({ trackIndex: { type: 'integer', minimum: 0, maximum: 127 }, keys: this.keysSchema }, ['trackIndex', 'keys']) };
  parse(value: unknown): ClipDocument {
    const validate = new Ajv({ strict: true }).compile(ClipDocumentModel.schema);
    if (!validate(value)) throw new CocosError('INVALID_ARGUMENT', 'Invalid clip document');
    const document = value as ClipDocument, targets = new Set<string>(); let count = 0;
    for (const track of document.tracks) {
      if (track.path && track.path.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) throw new CocosError('INVALID_ARGUMENT', 'Clip paths must be relative child paths');
      const key = `${track.path}:${track.property}`;
      if (targets.has(key)) throw new CocosError('INVALID_ARGUMENT', 'Duplicate animation track target'); targets.add(key);
      let previous = -1;
      for (const frame of track.keys) {
        if (frame.time <= previous || frame.time > document.duration) throw new CocosError('INVALID_ARGUMENT', 'Keyframe times must be strictly increasing within clip duration');
        previous = frame.time; if (++count > 4000) throw new CocosError('INVALID_ARGUMENT', 'Clip exceeds 4000 keyframes');
      }
    }
    return document;
  }
}
