import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';

export interface ResultReference { step: number; path: string }
export interface WorkflowOptions {
  paramRefs?: Record<string, ResultReference>;
  runtimeRef?: ResultReference;
  waitFor?: { path: string; equals: JsonValue; timeoutMs?: number; intervalMs?: number };
}

/** 引用只允许读取先前成功步骤的结果，不能访问原型或把失败响应当作资源 ID。 */
export class WorkflowValues {
  validate(options: WorkflowOptions, index: number): void {
    for (const [key, ref] of Object.entries(options.paramRefs ?? {})) { Json.safePath(key); if (key.includes('.')) throw new CocosError('INVALID_ARGUMENT', 'Parameter references must target top-level fields'); this.reference(ref, index); }
    if (options.runtimeRef) this.reference(options.runtimeRef, index);
    if (options.waitFor) {
      Json.safePath(options.waitFor.path);
      const timeout = options.waitFor.timeoutMs ?? 10000, interval = options.waitFor.intervalMs ?? 200;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000 || !Number.isInteger(interval) || interval < 10 || interval > 5000 || interval > timeout) throw new CocosError('INVALID_ARGUMENT', 'Invalid bounded workflow wait');
    }
  }
  private reference(ref: ResultReference, index: number): void {
    if (!Number.isInteger(ref.step) || ref.step < 0 || ref.step >= index) throw new CocosError('INVALID_ARGUMENT', 'References must point to an earlier step');
    Json.safePath(ref.path);
  }
  path(value: JsonValue, path: string): JsonValue {
    for (const key of Json.safePath(path)) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new CocosError('NOT_FOUND', `Workflow result path unavailable: ${path}`);
      value = (value as JsonObject)[key]!;
    }
    return value;
  }
  resolve(ref: ResultReference, rows: JsonValue[]): JsonValue {
    const row = Json.object(rows[ref.step]);
    if (row.status !== 'succeeded') throw new CocosError('CONTEXT_UNAVAILABLE', 'Referenced workflow step did not succeed');
    return this.path(Json.object(row.result).result!, ref.path);
  }
  params(params: JsonObject, options: WorkflowOptions, rows: JsonValue[]): JsonObject {
    const result = { ...params };
    for (const [key, ref] of Object.entries(options.paramRefs ?? {})) result[key] = this.resolve(ref, rows);
    return result;
  }
}
