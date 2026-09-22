export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;
export type CreatorMajor = 2 | 3;
export type ExecutionContext = 'editor' | 'runtime' | 'service';
export type Effect = 'read' | 'scene' | 'asset' | 'runtime' | 'configuration' | 'external';
export type Verification = 'source-only' | 'unverified' | 'contract-tested' | 'adapter-tested' | 'editor-verified' | 'runtime-verified' | 'device-verified';
export type Implementation = 'implemented' | 'planned';

export interface VerificationEvidence {
  id: string; level: Verification; source: string; sourceFingerprint?: string; reportSha256?: string;
  creatorVersion?: string; limitations: string; applicability: 'current-source' | 'historical';
}

export interface Capability {
  id: string;
  title: string;
  description: string;
  module: string;
  context: ExecutionContext;
  effect: Effect;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  versions: CreatorMajor[];
  supportedMajors?: CreatorMajor[];
  requires?: string[];
  implementation: Implementation;
  verification: Verification;
  verificationEvidence?: VerificationEvidence[];
  source?: string;
  platforms?: string[];
  prerequisites?: string[];
  sideEffects?: string[];
  risks?: string[];
  rollback?: string;
}

export interface ExecutionRequest {
  capabilityId: string;
  params: JsonObject;
  projectId: string;
  instanceId?: string;
  operationId?: string;
  expectedRevision?: string;
  runtimeInstanceId?: string;
}

export interface ExecutionResult {
  operationId: string;
  capabilityId: string;
  projectId: string;
  instanceId?: string;
  revision?: string;
  result: JsonValue;
  verification: Verification;
  completedAt: string;
  warnings?: Array<{ code: 'AUDIT_WRITE_FAILED'; message: string }>;
}

export interface BridgeDescriptor {
  protocolVersion: 1;
  projectId: string;
  projectPath: string;
  instanceId: string;
  editorVersion: string;
  creatorMajor: CreatorMajor;
  endpoint: string;
  token: string;
  pid: number;
  startedAt: string;
}

export interface BridgeRequest {
  protocolVersion: 1;
  projectId: string;
  instanceId: string;
  operationId: string;
  capabilityId: string;
  params: JsonObject;
  expectedRevision?: string;
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  details?: JsonValue;
}

export type ErrorCode =
  | 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'AMBIGUOUS_TARGET' | 'UNSUPPORTED_CAPABILITY'
  | 'UNSUPPORTED_VERSION' | 'CONTEXT_UNAVAILABLE' | 'STALE_REVISION' | 'STALE_HANDLE'
  | 'UNAUTHORIZED' | 'PATH_OUTSIDE_PROJECT' | 'OPERATION_CONFLICT' | 'OUTCOME_UNKNOWN'
  | 'CANCELLED' | 'TIMEOUT' | 'EDITOR_ERROR' | 'RUNTIME_ERROR' | 'VERIFICATION_FAILED'
  | 'RESOURCE_BUSY' | 'INTERNAL_ERROR';

export class CocosError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: JsonValue) {
    super(message);
    this.name = 'CocosError';
  }

  toJSON(): ErrorPayload {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }

  static from(error: unknown, fallback: ErrorCode = 'INTERNAL_ERROR'): CocosError {
    if (error instanceof CocosError) return error;
    // Electron IPC 会剥离 Error 原型；保留协议错误码与上下文，避免计划冲突退化成 [object Object]。
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
      const codes: ErrorCode[] = ['INVALID_ARGUMENT', 'NOT_FOUND', 'AMBIGUOUS_TARGET', 'UNSUPPORTED_CAPABILITY', 'UNSUPPORTED_VERSION', 'CONTEXT_UNAVAILABLE', 'STALE_REVISION', 'STALE_HANDLE', 'UNAUTHORIZED', 'PATH_OUTSIDE_PROJECT', 'OPERATION_CONFLICT', 'OUTCOME_UNKNOWN', 'CANCELLED', 'TIMEOUT', 'EDITOR_ERROR', 'RUNTIME_ERROR', 'VERIFICATION_FAILED', 'RESOURCE_BUSY', 'INTERNAL_ERROR'];
      const code = 'code' in error && codes.includes(error.code as ErrorCode) ? error.code as ErrorCode : fallback;
      let details: JsonValue | undefined;
      if ('details' in error && error.details !== undefined) { try { details = Json.value(error.details); } catch { /* 非 JSON 上下文不应掩盖原始错误消息。 */ } }
      return new CocosError(code, error.message, details);
    }
    return new CocosError(fallback, error instanceof Error ? error.message : String(error));
  }
}

export interface EditorAdapter {
  readonly major: CreatorMajor;
  execute(capabilityId: string, params: JsonObject): Promise<JsonValue>;
  revision(): Promise<string>;
  supportedCapabilities(): string[];
  dispose(): Promise<void>;
}

export class Json {
  static object(value: unknown, label = 'value'): JsonObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new CocosError('INVALID_ARGUMENT', `${label} must be an object`);
    }
    return value as JsonObject;
  }

  static string(value: JsonValue | undefined, label: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new CocosError('INVALID_ARGUMENT', `${label} must be a non-empty string`);
    return value;
  }

  static value(value: unknown): JsonValue {
    if (value === undefined) return null;
    try { return JSON.parse(JSON.stringify(value)) as JsonValue; }
    catch { throw new CocosError('INVALID_ARGUMENT', 'Value is not JSON serializable'); }
  }

  static safePath(path: string): string[] {
    const segments = path.split('.');
    if (!segments.length || segments.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) {
      throw new CocosError('INVALID_ARGUMENT', 'Unsafe property path');
    }
    return segments;
  }

  static canonical(value: JsonValue): string {
    if (Array.isArray(value)) return `[${value.map(v => Json.canonical(v)).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${Json.canonical(value[key]!)}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  static diff(before: JsonValue, after: JsonValue, maxRows = 1000): JsonValue[] {
    const rows: JsonValue[] = [];
    const visit = (left: JsonValue | undefined, right: JsonValue | undefined, path: string): void => {
      if (rows.length >= maxRows) return;
      if (left === undefined) { rows.push({ kind: 'added', path, after: right ?? null }); return; }
      if (right === undefined) { rows.push({ kind: 'removed', path, before: left }); return; }
      if (Json.canonical(left) === Json.canonical(right)) return;
      if (Array.isArray(left) && Array.isArray(right)) {
        const length = Math.max(left.length, right.length);
        for (let index = 0; index < length; index++) visit(left[index], right[index], `${path}/${index}`);
        return;
      }
      if (!Array.isArray(left) && !Array.isArray(right) && left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
        const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
        for (const key of [...keys].sort()) visit(left[key], right[key], path ? `${path}/${key}` : key);
        return;
      }
      rows.push({ kind: 'changed', path, before: left, after: right });
    };
    visit(before, after, '');
    if (rows.length >= maxRows) rows.push({ kind: 'truncated', path: '', maxRows });
    return rows;
  }
}
