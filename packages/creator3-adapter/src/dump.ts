import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';

export class PropertyDump {
  static isDump(value: JsonValue | undefined): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && 'value' in value
      && ('type' in value || 'default' in value || 'isArray' in value);
  }

  static unwrap(value: JsonValue): JsonValue {
    if (PropertyDump.isDump(value)) return PropertyDump.unwrap(value.value ?? null);
    if (Array.isArray(value)) return value.map(entry => PropertyDump.unwrap(entry));
    if (value && typeof value === 'object') {
      const result: JsonObject = {};
      for (const key of Object.keys(value)) result[key] = PropertyDump.unwrap(value[key]!);
      return result;
    }
    return value;
  }

  static locate(root: JsonObject, path: string): JsonObject {
    let current: JsonValue = root;
    for (const segment of Json.safePath(path)) {
      if (PropertyDump.isDump(current)) current = current.value ?? null;
      if (!current || typeof current !== 'object') throw new CocosError('NOT_FOUND', `Property not found: ${path}`);
      current = Array.isArray(current) ? current[Number(segment)] ?? null : current[segment] ?? null;
    }
    if (!PropertyDump.isDump(current)) throw new CocosError('NOT_FOUND', `No editable property description: ${path}`);
    return current;
  }

  static assign(dump: JsonObject, value: JsonValue): JsonObject {
    if (dump.readonly === true) throw new CocosError('INVALID_ARGUMENT', 'Property is read-only');
    const result = Json.object(Json.value(dump));
    const old = result.value;
    if (Array.isArray(old) && Array.isArray(value)) {
      const template = result.elementTypeData;
      result.value = value.map((entry, index) => {
        const previous = old[index] ?? template;
        return PropertyDump.isDump(previous) ? PropertyDump.assign(previous, entry) : entry;
      });
    } else if (old && typeof old === 'object' && !Array.isArray(old) && value && typeof value === 'object' && !Array.isArray(value)
      && Object.values(old).some(entry => PropertyDump.isDump(entry))) {
      const merged = { ...old };
      for (const [key, entry] of Object.entries(value)) {
        Json.safePath(key);
        if (!(key in old)) throw new CocosError('INVALID_ARGUMENT', `Unknown nested property: ${key}`);
        merged[key] = PropertyDump.isDump(old[key]) ? PropertyDump.assign(old[key], entry) : entry;
      }
      result.value = merged;
    } else result.value = value;
    return result;
  }

  static matches(actual: JsonValue, expected: JsonValue): boolean {
    // 原生数组元素会补齐默认字段；逐项验证请求值，同时保持长度和顺序严格一致。
    if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length
      && expected.every((value, index) => PropertyDump.matches(actual[index]!, value));
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && actual && typeof actual === 'object' && !Array.isArray(actual)) {
      return Object.entries(expected).every(([key, value]) => key in actual && PropertyDump.matches(actual[key]!, value));
    }
    if (typeof actual === 'number' && typeof expected === 'number') return Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-6;
    return Json.canonical(actual) === Json.canonical(expected);
  }
}
