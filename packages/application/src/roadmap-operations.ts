import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CocosError, Json, type ExecutionRequest, type ExecutionResult, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import type { CocosApplication, WorkflowStep } from './index.js';
import { AtomicJson } from './atomic-json.js';
import { EvidenceStore } from './evidence-store.js';
import { ProjectQueue } from './queue.js';

interface Run { controller: AbortController; done: Promise<void> }

/** 配方复用工作流；组合能力在应用串行队列之外调度，避免子步骤等待自己的父操作。 */
export class RoadmapOperations {
  private readonly files = new AtomicJson();
  private readonly evidence = new EvidenceStore();
  private readonly queue = new ProjectQueue();
  private readonly runs = new Map<string, Run>();
  private readonly creatingFixtures = new Set<string>();
  constructor(private readonly app: CocosApplication) {}
  owns(id: string): boolean { return /^(acceptance|fixture)\./.test(id) || ['preview.regression', 'preview.wait', 'runtime.ui.click'].includes(id); }
  private hash(value: JsonValue): string { return createHash('sha256').update(Json.canonical(value)).digest('hex'); }
  private async path(request: ExecutionRequest, kind: 'fixture' | 'acceptance', id: string): Promise<string> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new CocosError('INVALID_ARGUMENT', 'Invalid stored operation identity');
    const paths = this.app.projects.paths(request.projectId);
    const directory = await paths.resolve(kind === 'fixture' ? '.codex-work/cache/cocos-mcp/fixtures' : '.codex-work/artifacts/cocos-mcp/acceptance');
    await mkdir(directory, { recursive: true }); return paths.resolve(join(directory, `${id}.json`));
  }
  private async state(request: ExecutionRequest, kind: 'fixture' | 'acceptance', id: string): Promise<JsonObject> {
    try { return Json.object(JSON.parse(await readFile(await this.path(request, kind, id), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CocosError('NOT_FOUND', `${kind} record not found`); throw error; }
  }
  private call(request: ExecutionRequest, capabilityId: string, params: JsonObject, signal?: AbortSignal): Promise<ExecutionResult> {
    return this.app.execute({ projectId: request.projectId, capabilityId, params, operationId: randomUUID(),
      ...(request.instanceId ? { instanceId: request.instanceId } : {}), ...(request.runtimeInstanceId ? { runtimeInstanceId: request.runtimeInstanceId } : {}) }, signal);
  }
  private async fixturePlan(request: ExecutionRequest): Promise<JsonObject> {
    const { planHash: _ignored, ...p } = request.params;
    for (const origin of p.allowedOrigins as string[] ?? []) {
      const parsed = new URL(origin);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) throw new CocosError('INVALID_ARGUMENT', 'Fixture permissions require exact origins without credentials or paths');
    }
    const native = await this.call(request, 'ui.plan', { parentId: p.parentId!, document: p.document! });
    return { planHash: this.hash({ projectId: request.projectId, params: p, nativePlanHash: Json.object(native.result).planHash! }),
      rows: Json.object(native.result).rows ?? [], uiPlanHash: Json.object(native.result).planHash!, scope: 'new-ui-subtree',
      dataSource: 'explicit-synthetic-document', network: { default: 'deny', allowedOrigins: p.allowedOrigins ?? [] },
      ttlMs: p.ttlMs ?? 3600000, cleanup: 'native-snapshot-parent-position-and-surviving-reference-guard' };
  }
  private async createFixture(request: ExecutionRequest): Promise<JsonObject> {
    const plan = await this.fixturePlan(request);
    if (plan.planHash !== request.params.planHash) throw new CocosError('STALE_REVISION', 'Fixture plan changed; review it again');
    const fixtureId = randomUUID(), path = await this.path(request, 'fixture', fixtureId), startedAt = new Date().toISOString();
    let state: JsonObject = { fixtureId, projectId: request.projectId, mode: 'fixture', label: request.params.label!, scope: 'new-ui-subtree',
      dataSource: 'explicit-synthetic-document', status: 'creating', startedAt, expiresAt: new Date(Date.now() + Number(plan.ttlMs)).toISOString(), network: plan.network!,
      inputHash: this.hash(request.params), ownedAssets: [], cleanup: { status: 'pending' } };
    await this.files.write(path, state, true);
    this.creatingFixtures.add(fixtureId);
    try {
      const build = await this.call(request, 'ui.build', { parentId: request.params.parentId!, document: request.params.document!, planHash: plan.uiPlanHash! });
      const built = Json.object(build.result), rootId = Json.string(built.rootId, 'fixture root');
      // 原生创建已成功时先保存根节点；后续快照失败或服务中断仍能定位原操作，不能重建第二份夹具。
      state = { ...state, rootId, rows: built.rows ?? [], instanceId: build.instanceId ?? null, phase: 'ownership-snapshot' };
      await this.files.write(path, state);
      const snapshot = Json.object((await this.call(request, 'ui.owned_snapshot', { rootId })).result).snapshot!;
      state = { ...state, status: 'active', rootId, rows: built.rows ?? [], instanceId: build.instanceId ?? null,
        snapshot, snapshotHash: this.hash(snapshot), needsSave: true, completedAt: new Date().toISOString() };
      await this.files.write(path, state); return state;
    } catch (error) {
      const failure = CocosError.from(error), saved = await this.evidence.save(this.app.projects.paths(request.projectId), fixtureId, Json.value(failure.toJSON()));
      await this.files.write(path, { ...state, status: 'unknown', error: saved.result, recovery: 'Inspect pending native work and created root; never replay fixture.create blindly' }); throw failure;
    } finally { this.creatingFixtures.delete(fixtureId); }
  }
  private async cleanupFixture(request: ExecutionRequest, fixtureId: string): Promise<JsonObject> {
    const state = await this.state(request, 'fixture', fixtureId);
    if (state.status === 'cleaned') return state;
    if (state.status !== 'active' || typeof state.rootId !== 'string' || !state.snapshot) throw new CocosError('OUTCOME_UNKNOWN', 'Fixture ownership is incomplete; inspect original operation', { fixtureId });
    try {
      const cleanup = (await this.call(request, 'ui.owned_remove', { rootId: state.rootId, expectedSnapshot: state.snapshot })).result;
      const after = { ...state, status: 'cleaned', cleanup: { status: 'completed', result: cleanup }, needsSave: true, cleanedAt: new Date().toISOString() };
      await this.files.write(await this.path(request, 'fixture', fixtureId), after); return after;
    } catch (error) {
      const failure = CocosError.from(error);
      const conflict = failure.code === 'STALE_REVISION' || failure.code === 'OPERATION_CONFLICT';
      await this.files.write(await this.path(request, 'fixture', fixtureId), { ...state, status: conflict ? state.status! : 'cleanup-unknown',
        cleanup: { status: conflict ? 'blocked' : 'unknown', error: Json.value(failure.toJSON()) } }); throw failure;
    }
  }
  private steps(request: ExecutionRequest): WorkflowStep[] {
    return (request.params.steps as JsonObject[]).map(row => ({ ...row, ...(request.instanceId ? { instanceId: request.instanceId } : {}),
      ...(!row.runtimeRef && request.runtimeInstanceId ? { runtimeInstanceId: request.runtimeInstanceId } : {}) } as unknown as WorkflowStep));
  }
  private async acceptancePlan(request: ExecutionRequest): Promise<JsonObject> {
    const p = request.params, steps = this.steps(request), plan = Json.object(this.app.plan(request.projectId, steps));
    if (!plan.valid) throw new CocosError('INVALID_ARGUMENT', 'Acceptance recipe contains invalid steps', plan);
    // 任意脚本执行器、属性调用和嵌套配方不能混入验收；资金业务输入仍须调用者单独授权。
    const safe = /^(editor\.status|scene\.(query|hierarchy|validate|references|snapshot|save)|asset\.(info|resolve|dependencies|references\.audit)|preview\.(start|status|stop|capture|resize|validate_viewports|wait|runtime\.connect|logs|network|websocket|diagnose)|runtime\.(query|hierarchy|statistics|lifecycle\.snapshot|view\.(inspect|configure|restore)|ui\.(select|check|assert|inspect|hit_test|click)|control\.(inspect|text)|resources\.(snapshot|diff|trend))|fixture\.(status|cleanup))$/;
    for (const step of steps) {
      if (!safe.test(step.capabilityId)) throw new CocosError('UNAUTHORIZED', 'Capability is outside the finite acceptance recipe', { capabilityId: step.capabilityId });
      if (['runtime.ui.click', 'runtime.control.text'].includes(step.capabilityId) && p.allowInputs !== true) throw new CocosError('UNAUTHORIZED', 'Recipe input steps require explicit allowInputs');
      if (p.mode === 'fixture' && step.capabilityId === 'preview.start' && (step.params.fixtureId !== p.fixtureId || step.paramRefs?.fixtureId)) throw new CocosError('INVALID_ARGUMENT', 'Fixture preview must be bound to the reviewed fixtureId');
    }
    let fixture: JsonObject | null = null;
    if (p.mode === 'fixture') {
      fixture = await this.state(request, 'fixture', Json.string(p.fixtureId, 'fixtureId'));
      if (fixture.status !== 'active' || Date.parse(String(fixture.expiresAt)) <= Date.now()) throw new CocosError('STALE_HANDLE', 'Fixture is expired or inactive');
    }
    const { planHash: _ignored, ...params } = p;
    return { planHash: this.hash({ projectId: request.projectId, params, rows: plan.rows!, fixtureHash: fixture?.snapshotHash ?? null }), mode: p.mode!,
      fixtureId: p.fixtureId ?? null, rows: plan.rows!, inputSummary: { steps: steps.length, allowInputs: p.allowInputs === true, inputHash: this.hash(params) },
      realBusinessOutcomeVerified: false, network: fixture?.network ?? { default: 'project-policy', scope: 'live' }, cleanup: fixture ? 'guarded-owned-fixture-and-created-preview' : 'explicit-recipe-steps-only' };
  }
  private async startAcceptance(request: ExecutionRequest, signal?: AbortSignal): Promise<JsonObject> {
    if (this.runs.size >= 8) throw new CocosError('RESOURCE_BUSY', 'At most eight acceptance runs may be active');
    const plan = await this.acceptancePlan(request);
    if (plan.planHash !== request.params.planHash) throw new CocosError('STALE_REVISION', 'Acceptance plan changed; review it again');
    const runId = randomUUID(), path = await this.path(request, 'acceptance', runId), controller = new AbortController();
    const initial = { runId, projectId: request.projectId, status: 'running', mode: request.params.mode!, fixtureId: request.params.fixtureId ?? null,
      planHash: plan.planHash!, inputSummary: plan.inputSummary!, startedAt: new Date().toISOString(), rows: [], evidenceRefs: [], cleanup: [], realBusinessOutcomeVerified: false };
    await this.files.write(path, initial, true);
    const run: Run = { controller, done: Promise.resolve() }; this.runs.set(runId, run);
    const deadline = AbortSignal.timeout(Number(request.params.timeoutMs ?? 120000));
    const combined = AbortSignal.any([controller.signal, deadline, ...(signal ? [signal] : [])]);
    run.done = this.performAcceptance(request, runId, path, initial, combined).finally(() => this.runs.delete(runId));
    // 完成错误已写进证据包；后台 Promise 不制造未处理拒绝。
    void run.done.catch(() => {});
    return { runId, status: 'running', mode: request.params.mode!, evidencePath: path, planHash: plan.planHash! };
  }
  private async performAcceptance(request: ExecutionRequest, runId: string, path: string, initial: JsonObject, signal: AbortSignal): Promise<void> {
    let state: JsonObject = initial, previewBefore: JsonObject | undefined, createdPreviewSession: JsonValue | undefined;
    const evidenceRefs: JsonObject[] = [], cleanup: JsonObject[] = [];
    try {
      const versions = await this.call(request, 'editor.status', {});
      previewBefore = Json.object((await this.call(request, 'preview.status', {})).result);
      if (previewBefore.running && this.steps(request).some(step => step.capabilityId === 'preview.start')) throw new CocosError('RESOURCE_BUSY', 'An existing preview must not be adopted by an acceptance run');
      state = { ...state, versions: (await this.evidence.save(this.app.projects.paths(request.projectId), runId, versions.result)).result };
      await this.files.write(path, state);
      const result = await this.app.executeWorkflow(request.projectId, this.steps(request), signal, false, runId, async (result, index) => {
        if (result.capabilityId === 'preview.start') createdPreviewSession = Json.object(result.result).previewSessionId ?? Json.object(result.result).diagnosticSessionId;
        const saved = await this.evidence.save(this.app.projects.paths(request.projectId), `${runId}-${index}`, result.result);
        evidenceRefs.push(...saved.evidenceRefs);
        const observed = Json.object(saved.result);
        if ((result.capabilityId.includes('.check') || result.capabilityId.includes('.assert')) && (observed.passed === false || observed.valid === false)) throw new CocosError('VERIFICATION_FAILED', 'Acceptance assertion failed', { observedResult: observed });
        return { ...result, result: saved.result };
      });
      const workflow = Json.object(result);
      state = { ...state, status: signal.aborted ? controllerStatus(signal) : workflow.status!, workflowId: runId, rows: workflow.rows!, evidenceRefs };
    } catch (error) {
      const failure = CocosError.from(error), saved = await this.evidence.save(this.app.projects.paths(request.projectId), `${runId}-error`, Json.value(failure.toJSON()));
      state = { ...state, status: failure.code === 'OUTCOME_UNKNOWN' ? 'unknown' : signal.aborted ? controllerStatus(signal) : 'failed', error: saved.result, evidenceRefs };
    } finally {
      if (createdPreviewSession && !previewBefore?.running) {
        try {
          const current = Json.object((await this.call(request, 'preview.status', {})).result);
          if ((current.previewSessionId ?? current.diagnosticSessionId) === createdPreviewSession) cleanup.push({ scope: 'owned-preview', status: 'completed', result: (await this.call(request, 'preview.stop', {})).result });
          else cleanup.push({ scope: 'owned-preview', status: 'skipped', reason: 'Preview identity changed; current window was preserved' });
        } catch (error) { cleanup.push({ scope: 'owned-preview', status: 'unknown', error: Json.value(CocosError.from(error).toJSON()) }); }
      }
      if (request.params.mode === 'fixture' && request.params.fixtureId) {
        try { cleanup.push({ scope: 'owned-fixture', status: 'completed', result: await this.queue.run(request.projectId, () => this.cleanupFixture(request, String(request.params.fixtureId))) }); }
        catch (error) { cleanup.push({ scope: 'owned-fixture', status: 'blocked', error: Json.value(CocosError.from(error).toJSON()) }); }
      }
      if (cleanup.some(row => !['completed', 'skipped'].includes(String(row.status))) && state.status === 'succeeded') state.status = 'incomplete';
      await this.files.write(path, { ...state, cleanup, completedAt: new Date().toISOString(), evidencePath: path });
    }
    function controllerStatus(signal: AbortSignal): string { return signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled'; }
  }
  private async click(request: ExecutionRequest, signal?: AbortSignal): Promise<JsonObject> {
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
  private async regression(request: ExecutionRequest, signal?: AbortSignal): Promise<JsonObject> {
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
  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<JsonValue> {
    const id = request.capabilityId;
    if (id === 'fixture.plan') return this.fixturePlan(request);
    if (id === 'fixture.create') return this.queue.run(request.projectId, () => this.createFixture(request), signal);
    if (id === 'fixture.cleanup') return this.queue.run(request.projectId, () => this.cleanupFixture(request, String(request.params.fixtureId)), signal);
    if (id === 'fixture.status') {
      const state = await this.state(request, 'fixture', String(request.params.fixtureId));
      const { snapshot: _snapshot, ...metadata } = state;
      return { ...metadata, ...(state.status === 'creating' && !this.creatingFixtures.has(String(state.fixtureId))
        ? { status: 'unknown', recovery: 'Service restarted during creation; inspect original root and operation before any retry' } : {}),
        expired: Date.parse(String(state.expiresAt)) <= Date.now() };
    }
    if (id === 'acceptance.plan') return this.acceptancePlan(request);
    if (id === 'acceptance.run') return this.startAcceptance(request, signal);
    if (id === 'acceptance.cancel') this.runs.get(String(request.params.runId))?.controller.abort(new CocosError('CANCELLED', 'Acceptance cancelled by caller'));
    if (id === 'acceptance.status' || id === 'acceptance.cancel') {
      const state = await this.state(request, 'acceptance', String(request.params.runId));
      return state.status === 'running' && !this.runs.has(String(request.params.runId)) ? { ...state, status: 'unknown', recovery: 'Service restarted; query workflow and native state. Writes were not replayed' } : { ...state, cancellationRequested: id === 'acceptance.cancel' };
    }
    if (id === 'runtime.ui.click') return this.click(request, signal);
    if (id === 'preview.wait') {
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
    if (id === 'preview.regression') return this.regression(request, signal);
    throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown application capability ${id}`);
  }
}
