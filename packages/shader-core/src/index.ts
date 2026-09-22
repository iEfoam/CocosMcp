import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';

export class ShaderVariants {
  plan(axes: JsonObject, limit = 64): JsonObject {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new CocosError('INVALID_ARGUMENT', 'Variant limit must be 1..256');
    let rows: JsonObject[] = [{}]; let total = 1;
    for (const [name, values] of Object.entries(axes)) {
      Json.safePath(name);
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new CocosError('INVALID_ARGUMENT', 'Invalid macro name');
      if (!Array.isArray(values) || !values.length || values.some(value => !['boolean', 'number', 'string'].includes(typeof value))) throw new CocosError('INVALID_ARGUMENT', 'Each macro axis needs scalar values');
      const unique = [...new Map(values.map(value => [Json.canonical(value), value])).values()];
      total *= unique.length;
      if (total > limit) throw new CocosError('INVALID_ARGUMENT', 'Variant budget exceeded', { total, limit });
      rows = rows.flatMap(row => unique.map(value => ({ ...row, [name]: value })));
    }
    return { rows, total, limit };
  }
}

export class ShaderDiagnostics {
  from(error: unknown, assetUrl: string): JsonObject {
    const message = error instanceof Error ? error.message : String(error);
    const code = /\bEFX\d{4}\b/.exec(message)?.[0] ?? null;
    // 原生编译器行号可能指向展开后的程序，不能假装已映射回原始 Effect。
    const line = /(?:ERROR:\s*\d+:|\bline\s+)(\d+)/i.exec(message);
    return { severity: 'error', assetUrl, code, message: message.slice(0, 32768), line: line ? Number(line[1]) : null,
      column: null, locationAccuracy: line ? 'generated' : 'unavailable' };
  }
}

/** 所有材质入口共用输入约束，避免原生 setProperty 仅打印警告后返回。 */
export class MaterialValues {
  properties(properties: JsonObject): JsonObject {
    const normalized: JsonObject = {};
    for (const [name, value] of Object.entries(properties)) {
      Json.safePath(name);
      try { normalized[name] = this.normalize(value); this.value(normalized[name]!); }
      catch (error) { throw new CocosError('INVALID_ARGUMENT', `Material property "${name}": ${CocosError.from(error).message}`); }
    }
    return normalized;
  }

  private normalize(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(entry => this.normalize(entry));
    if (!value || typeof value !== 'object' || value.type !== undefined) return value;
    // 接受 Creator 属性查询/序列化常用的显式分量；不猜测数值数组是向量还是 uniform 数组。
    for (const [type, nativeType, keys] of [
      ['color', 'cc.Color', ['r', 'g', 'b', 'a']], ['vec4', 'cc.Vec4', ['x', 'y', 'z', 'w']],
      ['vec3', 'cc.Vec3', ['x', 'y', 'z']], ['vec2', 'cc.Vec2', ['x', 'y']],
    ] as const) {
      if (value.__type__ !== undefined && value.__type__ !== nativeType) continue;
      if (keys.every(key => typeof value[key] === 'number') && Object.keys(value).every(key => key === '__type__' || (keys as readonly string[]).includes(key))) {
        return { type, value: keys.map(key => value[key]!) };
      }
    }
    return value;
  }
  validate(properties: JsonObject, declared: JsonObject): void {
    for (const [name, value] of Object.entries(properties)) {
      Json.safePath(name);
      if (!(name in declared)) throw new CocosError('INVALID_ARGUMENT', `Unknown material property: ${name}`);
      this.value(value);
    }
  }
  value(value: JsonValue): void {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new CocosError('INVALID_ARGUMENT', 'Material number must be finite');
    if (value === null || typeof value === 'string') throw new CocosError('INVALID_ARGUMENT', 'Use an explicit texture UUID or typed material value');
    if (Array.isArray(value)) { for (const entry of value) this.value(entry); }
    else if (typeof value === 'object') {
      const type = value.type;
      if (!['color', 'vec2', 'vec3', 'vec4', 'mat3', 'mat4', 'texture'].includes(String(type))) throw new CocosError('INVALID_ARGUMENT', 'Expected a typed material value, e.g. {type:"color",value:[255,255,255,255]}, {type:"vec4",value:[1,1,1,1]} or {type:"texture",uuid:"..."}; property declarations are not writable values');
      if (type === 'texture') { Json.string(value.uuid, 'texture UUID'); return; }
      const count = type === 'vec2' ? 2 : type === 'vec3' ? 3 : type === 'mat3' ? 9 : type === 'mat4' ? 16 : 4;
      if (!Array.isArray(value.value) || value.value.length !== count || value.value.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new CocosError('INVALID_ARGUMENT', 'Invalid vector/color components');
    }
  }
}
