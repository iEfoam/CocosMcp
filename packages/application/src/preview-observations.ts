import { performance } from 'node:perf_hooks';
import { CocosError, Json, type ExecutionRequest, type ExecutionResult, type JsonObject, type JsonValue } from '../../contracts/src/index.js';

type PreviewCall = (request: ExecutionRequest, capabilityId: string, params: JsonObject, signal?: AbortSignal) => Promise<ExecutionResult>;

/** 预览交互与有界观察复用应用调度；不持有 fixture、验收账本或独立的原生连接。 */
export class PreviewObservations {
  constructor(private readonly call: PreviewCall) {}
  async click(request: ExecutionRequest, signal?: AbortSignal): Promise<JsonObject> {
    const selected = Json.object((await this.call(request, 'runtime.ui.select', { selector: request.params.selector!, ...(request.params.rootId ? { rootId: request.params.rootId } : {}) }, signal)).result), target = Json.object(selected.target);
    if (target.active !== true || target.interactable !== true || target.visible !== true || target.maskVisibilityVerified !== true || selected.uniqueInputCandidate !== true) throw new CocosError('VERIFICATION_FAILED', 'Unique active and visible native button target was not proven', { inputSent: false, before: selected });
    const preview = Json.object((await this.call(request, 'preview.status', {}, signal)).result);
    if (!preview.running || preview.currentSceneId !== selected.sceneId || typeof preview.runtimeInstanceId !== 'string') throw new CocosError('STALE_HANDLE', 'Selected runtime is not bound to the owned preview', { inputSent: false });
    if (request.runtimeInstanceId && preview.runtimeInstanceId !== request.runtimeInstanceId) throw new CocosError('STALE_HANDLE', 'Selected runtime differs from owned preview', { inputSent: false });
    const point = Json.object(target.point);
    const before = Json.object((await this.call({ ...request, runtimeInstanceId: String(preview.runtimeInstanceId) }, 'runtime.ui.select', { selector: { nodeId: target.nodeId! } }, signal)).result);
    if (before.sceneGeneration !== selected.sceneGeneration || Json.canonical(Json.object(before.target).point!) !== Json.canonical(point)) throw new CocosError('STALE_HANDLE', 'UI geometry changed before input', { inputSent: false });
    let input: JsonObject;
    try { input = Json.object((await this.call(request, 'preview.input', { action: 'click', x: point.x!, y: point.y!, coordinateSpace: 'window-css',
      expectedSceneId: selected.sceneId!, expectedGeneration: preview.sceneGeneration!, expectedRuntimeInstanceId: preview.runtimeInstanceId!, allowResume: request.params.allowResume === true }, signal)).result); }
    catch (error) { throw error; }
    const deadline = Date.now() + Number(request.params.timeoutMs ?? 5000); let after: JsonValue = null;
    try {
      if (request.params.after) {
        do {
          after = (await this.call({ ...request, runtimeInstanceId: String(preview.runtimeInstanceId) }, 'runtime.ui.check', { rows: request.params.after }, signal)).result;
          if (Json.object(after).passed === true) break;
          if (Date.now() >= deadline) throw new CocosError('VERIFICATION_FAILED', 'Post-input condition did not pass');
          await new Promise(resolve => setTimeout(resolve, 100));
        } while (!signal?.aborted);
        if (signal?.aborted) throw new CocosError('CANCELLED', 'Post-input observation cancelled');
      }
      return { inputSent: true, before: selected, input, after, actualReceiverVerified: false, businessOutcomeVerified: false };
    } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Input was sent but post-state was not proven; do not replay', { inputSent: true, before: selected, after, cause: CocosError.from(error).message }); }
  }
  async regression(request: ExecutionRequest, signal?: AbortSignal): Promise<JsonObject> {
    const preview = Json.object((await this.call(request, 'preview.status', {}, signal)).result);
    if (!preview.running || typeof preview.runtimeInstanceId !== 'string') throw new CocosError('CONTEXT_UNAVAILABLE', 'Regression requires the owned preview runtime');
    if (request.runtimeInstanceId && request.runtimeInstanceId !== preview.runtimeInstanceId) throw new CocosError('STALE_HANDLE', 'Regression runtime differs from the owned preview');
    let currentRequest = { ...request, runtimeInstanceId: preview.runtimeInstanceId };
    const operations = request.params.rows as JsonObject[];
    if (operations.some(row => !['preview.resize', 'preview.refresh', 'preview.wait', 'runtime.scene.load'].includes(String(row.capabilityId)))) throw new CocosError('UNAUTHORIZED', 'Regression operations are limited to resize, refresh, wait and scene loading');
    const rows: JsonObject[] = [], durations: number[] = [];
    const baseline = Json.object((await this.call(currentRequest, 'runtime.lifecycle.snapshot', {}, signal)).result);
    for (let cycle = 0; cycle < Number(request.params.cycles); cycle++) {
      for (const row of operations) {
        if (signal?.aborted) throw new CocosError('CANCELLED', 'Regression cancelled');
        const start = performance.now(), capabilityId = String(row.capabilityId);
        let result = (await this.call(currentRequest, capabilityId, Json.object(row.params), signal)).result;
        if (capabilityId === 'preview.refresh') {
          const operationId = Json.object(result).operationId!, deadline = Date.now() + 30000;
          while (Json.object(result).nativePending && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 100)); result = (await this.call(request, 'preview.refresh.status', { operationId }, signal)).result; }
          if (Json.object(result).status !== 'completed') throw new CocosError('VERIFICATION_FAILED', 'Refresh regression lacks native loaded-byte proof', result);
          const connected = Json.object((await this.call(request, 'preview.runtime.connect', {}, signal)).result);
          currentRequest = { ...request, runtimeInstanceId: Json.string(connected.runtimeInstanceId, 'runtimeInstanceId') };
        }
        const durationMs = performance.now() - start; durations.push(durationMs);
        const frameBefore = Json.object((await this.call(currentRequest, 'preview.status', {}, signal)).result);
        const frameAfter = Json.object((await this.call(currentRequest, 'preview.wait', { afterFrameIndex: frameBefore.frameIndex!, timeoutMs: 5000 }, signal)).result);
        if (frameAfter.runtimeInstanceId !== currentRequest.runtimeInstanceId) throw new CocosError('STALE_HANDLE', 'Preview runtime changed during regression');
        const snapshot = (await this.call(currentRequest, 'runtime.lifecycle.snapshot', {}, signal)).result;
        rows.push({ cycle, capabilityId, durationMs, snapshot, frameEvidence: { before: frameBefore.frameIndex!, after: frameAfter.frameIndex!,
          advanced: Number(frameAfter.frameIndex) > Number(frameBefore.frameIndex), previewSessionId: frameAfter.previewSessionId ?? null } });
      }
    }
    const snapshots = rows.map(row => Json.object(row.snapshot)), warm = snapshots[operations.length - 1] ?? baseline, growth = Number(request.params.maxResourceGrowth ?? 0);
    const checks = ['handles', 'subscriptions', 'runningTasks', 'pendingFrameWaits', 'ownedAssetRefs', 'pendingAssetLoads', 'assetCount'].map(metric => {
      const observed = snapshots.filter((_row, index) => index >= operations.length - 1).map(row => row[metric]);
      return { check: metric, baseline: warm[metric] ?? null, maximum: observed.every(value => typeof value === 'number') ? Math.max(...observed as number[]) : null,
        status: typeof warm[metric] !== 'number' || observed.some(value => typeof value !== 'number') ? 'unknown' : observed.every(value => Number(value) <= Number(warm[metric]) + growth) ? 'passed' : 'failed' };
    });
    const frames = rows.map(row => Json.object(row.frameEvidence));
    // 页面刷新会重置帧计数，必须比较同一次导航内的前后值，不能跨页面比较绝对计数。
    checks.push({ check: 'frame-advances', baseline: null, maximum: null,
      status: frames.length && frames.every(frame => frame.advanced === true) ? 'passed' : 'failed' });
    durations.sort((a, b) => a - b); const percentile = (fraction: number): number | null => durations.length ? durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)]! : null;
    return { rows, checks, passed: checks.every(row => row.status === 'passed'), latencyMs: { p50: percentile(0.5), p95: percentile(0.95), samples: durations.length },
      scope: 'bounded-observation-after-first-cycle-warmup', unavailableMetrics: ['gpu-memory'], baseline };
  }
  async wait(request: ExecutionRequest, signal?: AbortSignal): Promise<JsonObject> {
    const deadline = Date.now() + Number(request.params.timeoutMs ?? 10000); let last: JsonObject = {}, session: JsonValue | undefined;
    const bounded = AbortSignal.any([AbortSignal.timeout(Number(request.params.timeoutMs ?? 10000)), ...(signal ? [signal] : [])]);
    while (Date.now() < deadline) {
      try { last = Json.object((await this.call(request, 'preview.status', {}, bounded)).result); }
      catch (error) {
        if (bounded.aborted) throw new CocosError(signal?.aborted ? 'CANCELLED' : 'TIMEOUT', 'Preview readiness observation ended', last);
        throw error;
      }
      const current = last.previewSessionId ?? last.sessionId;
      if (session === undefined) session = current;
      if (session !== current) throw new CocosError('STALE_HANDLE', 'Preview changed during wait');
      if (request.params.expectedGeneration !== undefined && request.params.expectedGeneration !== last.sceneGeneration) throw new CocosError('STALE_HANDLE', 'Preview scene generation changed', last);
      if (request.params.expectedSceneId !== undefined && request.params.expectedSceneId !== last.currentSceneId) throw new CocosError('VERIFICATION_FAILED', 'Preview current scene differs from strict expectation', last);
      if (last.gameReady === true && (request.params.sceneId === undefined || request.params.sceneId === last.currentSceneId) && (request.params.afterFrameIndex === undefined || Number(last.frameIndex) > Number(request.params.afterFrameIndex))) {
        const checks = request.params.uiChecks ? (await this.call(request, 'runtime.ui.check', { rows: request.params.uiChecks }, bounded)).result : null;
        if (!checks || Json.object(checks).passed === true) return { status: 'completed', ...last, uiChecks: checks, businessOutcomeVerified: false };
        last = { ...last, uiChecks: checks };
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
    }
    throw new CocosError('TIMEOUT', 'Preview readiness or UI condition was not observed', last);
  }
}
