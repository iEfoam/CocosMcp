import { CocosError, type BridgeDescriptor, type BridgeRequest, type ErrorPayload, type JsonValue } from '../../contracts/src/index.js';

export class BridgeClient {
  constructor(private readonly timeoutMs = 30_000) {}

  async identity(descriptor: BridgeDescriptor): Promise<boolean> {
    try {
      const response = await fetch(descriptor.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${descriptor.token}` },
        body: JSON.stringify({ protocolVersion: 1, projectId: descriptor.projectId, instanceId: descriptor.instanceId,
          operationId: 'registry-identity', capabilityId: 'bridge.identity', params: {} }) });
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body ?? []) { size += chunk.length; if (size > 1024 * 1024) return false; chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
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
