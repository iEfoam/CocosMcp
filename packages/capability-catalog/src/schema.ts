import type { JsonSchema } from '../../contracts/src/index.js';

export class Schema {
  static any(): JsonSchema { return {}; }
  static string(description?: string): JsonSchema { return { type: 'string', minLength: 1, ...(description ? { description } : {}) }; }
  static number(): JsonSchema { return { type: 'number' }; }
  static integer(minimum = 0): JsonSchema { return { type: 'integer', minimum }; }
  static boolean(): JsonSchema { return { type: 'boolean' }; }
  static array(items: JsonSchema = {}): JsonSchema { return { type: 'array', items }; }
  static enum(...values: string[]): JsonSchema { return { type: 'string', enum: values }; }
  static object(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
    return { type: 'object', properties, required, additionalProperties: false };
  }
  static record(): JsonSchema { return { type: 'object', additionalProperties: true }; }
  static vector(): JsonSchema { return Schema.object({ x: Schema.number(), y: Schema.number(), z: Schema.number() }, ['x', 'y']); }
}
