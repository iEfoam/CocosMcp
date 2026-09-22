import { CocosError, type BridgeDescriptor, type BridgeRequest, type ErrorPayload, type JsonValue } from '../../contracts/src/index.js';

export class BridgeClient {
  constructor(private readonly timeoutMs = 30_000) {}

  async call(descriptor: BridgeDescriptor, request: BridgeRequest, signal?: AbortSignal): Promise<{ result: JsonValue; revision: string }> {
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
    let body: { result?: JsonValue; revision?: string; error?: ErrorPayload };
    try { body = await response.json() as typeof body; }
    catch { throw new CocosError('OUTCOME_UNKNOWN', 'Editor response body was interrupted or invalid; query the operation before retrying', { operationId: request.operationId }); }
    if (body?.error) throw new CocosError(body.error.code, body.error.message, body.error.details);
    if (!response.ok || !body || typeof body !== 'object' || !('result' in body) || typeof body.revision !== 'string') throw new CocosError('OUTCOME_UNKNOWN', 'Invalid editor bridge response; query the operation before retrying');
    return { result: body.result ?? null, revision: body.revision };
  }
}
