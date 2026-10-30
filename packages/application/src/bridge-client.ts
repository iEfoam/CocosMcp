import { CocosError, type BridgeDescriptor, type BridgeRequest, type ErrorPayload, type JsonObject, type JsonValue } from '../../contracts/src/index.js';

export class BridgeClient {
  constructor(private readonly timeoutMs = 30_000, private readonly maxReplyBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxReplyBytes) || maxReplyBytes < 1) throw new CocosError('INVALID_ARGUMENT', 'Invalid bridge response budget');
  }

  private async json(response: Response, limit: number): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing bridge response body');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('Bridge response exceeds byte budget');
      while (true) {
        const row = await reader.read(); if (row.done) break;
        bytes += row.value.byteLength;
        if (bytes > limit) throw new Error('Bridge response exceeds byte budget');
        chunks.push(row.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally { await reader.cancel().catch(() => {}); }
  }

  async identity(descriptor: BridgeDescriptor): Promise<boolean> {
    try {
      const response = await fetch(descriptor.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${descriptor.token}` },
        body: JSON.stringify({ protocolVersion: 1, projectId: descriptor.projectId, instanceId: descriptor.instanceId,
          operationId: 'registry-identity', capabilityId: 'bridge.identity', params: { includeLoginState: false } }) });
      const body = await this.json(response, 1024 * 1024) as { result?: Partial<BridgeDescriptor>; error?: ErrorPayload };
      if (response.ok && body.result?.instanceId === descriptor.instanceId && body.result?.projectPath === descriptor.projectPath && body.result?.pid === descriptor.pid) return true;
      // 旧发行版没有身份入口；受相同 token/project/instance 校验保护的 describe 保留兼容发现。
      if (body.error?.code === 'UNSUPPORTED_CAPABILITY') {
        const legacy = await new BridgeClient(1000).call(descriptor, { protocolVersion: 1, projectId: descriptor.projectId,
          instanceId: descriptor.instanceId, operationId: 'registry-legacy-identity', capabilityId: 'bridge.describe', params: {} });
        const result = legacy.result as { editorVersion?: unknown; supportedCapabilities?: unknown };
        return result?.editorVersion === descriptor.editorVersion && Array.isArray(result.supportedCapabilities);
      }
    } catch { /* 身份探测只有只读副作用；失联描述符不属于当前可调用实例。 */ }
    return false;
  }

  async call(descriptor: BridgeDescriptor, request: BridgeRequest, signal?: AbortSignal): Promise<{ result: JsonValue; revision: string; timings?: JsonObject[] }> {
    let response: Response;
    try {
      const cancellation = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
      response = await fetch(descriptor.endpoint, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${descriptor.token}` },
        body: JSON.stringify(request), signal: cancellation });
    } catch (error) {
      // 请求可能已经进入编辑器，超时或断线并不意味着修改没有发生，禁止盲目重试。
      throw new CocosError('OUTCOME_UNKNOWN', 'Editor response was interrupted; query the operation before retrying', { operationId: request.operationId, cause: CocosError.from(error).message });
    }
    let body: { result?: JsonValue; revision?: string; error?: ErrorPayload; timings?: unknown };
    try { body = await this.json(response, this.maxReplyBytes) as typeof body; }
    catch { throw new CocosError('OUTCOME_UNKNOWN', 'Editor response body was interrupted or invalid; query the operation before retrying', { operationId: request.operationId }); }
    if (body?.error) throw new CocosError(body.error.code, body.error.message, body.error.details);
    if (!response.ok || !body || typeof body !== 'object' || !('result' in body) || typeof body.revision !== 'string') throw new CocosError('OUTCOME_UNKNOWN', 'Invalid editor bridge response; query the operation before retrying');
    // 旧桥接可以没有诊断计时；无效附加元数据不能把已确认成功的写入降为未知。
    const timings: JsonObject[] = [];
    if (Array.isArray(body.timings)) for (const row of body.timings.slice(0, 32)) {
      if (!row || typeof row !== 'object' || typeof row.stage !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(row.stage)
        || typeof row.durationMs !== 'number' || !Number.isFinite(row.durationMs) || row.durationMs < 0 || !Number.isSafeInteger(row.calls) || row.calls < 1) continue;
      timings.push({ stage: row.stage, durationMs: row.durationMs, calls: row.calls });
    }
    const serialization = /^cocos-json;dur=(\d+(?:\.\d+)?)$/.exec(response.headers.get('server-timing') ?? '');
    if (serialization && Number.isFinite(Number(serialization[1]))) timings.push({ stage: 'response-serialization', durationMs: Number(serialization[1]), calls: 1 });
    return { result: body.result ?? null, revision: body.revision, ...(timings.length ? { timings } : {}) };
  }
}
