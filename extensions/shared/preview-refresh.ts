import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { ProjectPaths } from '../../packages/application/src/paths.js';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../packages/contracts/src/index.js';
import { PreviewRedaction } from './preview-redaction.js';

export interface PreviewRefreshHost {
  projectPath: string;
  importResource(url: string): Promise<unknown>;
  /** 必须来自 native compiler 完成信号，且产物清单绑定本次源码摘要；缺失时不推测成功。 */
  compile?(batch: JsonObject, cancelled: () => boolean): Promise<JsonObject>;
  reload?(manifest: JsonObject): Promise<JsonObject>;
}
interface RefreshOperation { state: JsonObject; cancelled: boolean; pending: boolean; done: Promise<void> }

export class PreviewRefresh {
  private readonly operations = new Map<string, RefreshOperation>();
  private active: RefreshOperation | undefined;
  private readonly redact = new PreviewRedaction();
  constructor(private readonly host: PreviewRefreshHost) {}
  async execute(method: string, params: JsonObject): Promise<JsonValue> {
    if (method !== 'refresh') {
      const operation = this.operations.get(Json.string(params.operationId, 'operationId'));
      if (!operation) throw new CocosError('NOT_FOUND', 'Refresh operation not found in this editor instance');
      if (method === 'refresh.cancel' && operation.pending) {
        operation.cancelled = true;
        operation.state.status = 'cancelled'; operation.state.reason = 'Cancellation requested; an in-flight native import may still finish';
      }
      return Json.value(operation.state);
    }
    if (this.active?.pending) throw new CocosError('RESOURCE_BUSY', 'A native refresh is still in flight; inspect its operation before retrying');
    if (!Array.isArray(params.urls) || !params.urls.length || params.urls.length > 100 || params.urls.some(url => typeof url !== 'string')) throw new CocosError('INVALID_ARGUMENT', 'Expected 1..100 asset URLs');
    const timeout = Number(params.timeoutMs ?? 30000);
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000) throw new CocosError('INVALID_ARGUMENT', 'Refresh timeout must be 100..120000 ms');
    const paths = await ProjectPaths.open(this.host.projectPath);
    for (const url of params.urls) await paths.asset(String(url));
    const operationId = randomBytes(16).toString('hex');
    const state: JsonObject = { operationId, binding: params.binding ?? null, status: 'pending', nativePending: true, phase: 'import', import: { status: 'pending' }, compile: { status: 'pending', errors: [] }, preview: { status: 'unknown', expectedRevision: null, loadedRevision: null, revisionMatched: null }, startedAt: new Date().toISOString() };
    const operation: RefreshOperation = { state, cancelled: false, pending: true, done: Promise.resolve() };
    if (this.operations.size >= 100) this.operations.delete(this.operations.keys().next().value!);
    this.operations.set(operationId, operation); this.active = operation;
    const timer = setTimeout(() => { if (operation.cancelled) return; operation.cancelled = true; state.status = 'timeout'; state.reason = `Timed out during ${String(state.phase)}; in-flight native work may still finish`; }, timeout);
    operation.done = this.run(operation, [...new Set(params.urls as string[])], params.reload !== false, paths).catch(error => {
      if (!operation.cancelled) { state.status = 'failed'; state.error = this.redact.value(CocosError.from(error).toJSON()); const phase = String(state.phase); state[phase] = { ...Json.object(state[phase]), status: 'failed', error: state.error }; }
    }).finally(() => { clearTimeout(timer); operation.pending = false; state.nativePending = false; state.finishedAt = new Date().toISOString(); });
    // 异步句柄释放现有工程串行队列，status/cancel 才能在 native callback 之前被处理。
    return Json.value(state);
  }
  private async fingerprint(paths: ProjectPaths, urls: string[]): Promise<JsonObject[]> {
    const rows: JsonObject[] = [];
    for (const url of [...urls].sort()) {
      const path = await paths.asset(url), info = await stat(path);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new CocosError('INVALID_ARGUMENT', 'Revision tracking requires regular assets no larger than 16 MiB', { url });
      rows.push({ url, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    }
    return rows;
  }
  private async run(operation: RefreshOperation, urls: string[], reload: boolean, paths: ProjectPaths): Promise<void> {
    const state = operation.state, check = (): boolean => !operation.cancelled;
    const before = await this.fingerprint(paths, urls), imported: JsonObject[] = [];
    for (const url of urls) {
      if (!check()) return;
      try { await this.host.importResource(url); }
      catch (error) { state.import = { status: 'failed', rows: imported, url, error: this.redact.value(CocosError.from(error).toJSON()) }; throw error; }
      if (!check()) return;
      imported.push({ url, status: 'completed', signal: 'asset-db-callback' });
      state.import = { status: 'running', rows: [...imported] };
    }
    const after = await this.fingerprint(paths, urls);
    if (!check()) return;
    if (Json.canonical(before) !== Json.canonical(after)) throw new CocosError('STALE_REVISION', 'Assets changed while importing; no browser reload was issued');
    const revision = createHash('sha256').update(Json.canonical(after)).digest('hex');
    state.import = { status: 'completed', rows: imported, revision, sources: after };
    state.phase = 'compile';
    if (!this.host.compile) { state.compile = { status: 'unknown', errors: [], reason: 'Native compiler completion adapter unavailable; import completion is not compilation proof' }; state.status = 'unknown'; return; }
    const compile = await this.host.compile({ operationId: state.operationId!, sourceRevision: revision, rows: after }, () => operation.cancelled);
    if (!check()) return;
    if (Json.canonical(after) !== Json.canonical(await this.fingerprint(paths, urls))) throw new CocosError('STALE_REVISION', 'Assets changed while compiling; no preview reload was issued');
    state.compile = this.redact.value(compile);
    if (compile.status === 'failed' || (Array.isArray(compile.errors) && compile.errors.length)) { state.status = 'failed'; return; }
    if (compile.status !== 'completed' || compile.sourceRevision !== revision || !Array.isArray(compile.artifacts) || !compile.artifacts.length) { state.status = 'unknown'; return; }
    const artifacts = compile.artifacts.map(row => Json.object(row));
    if (artifacts.some(row => typeof row.url !== 'string' || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) || new Set(artifacts.map(row => row.url)).size !== artifacts.length) throw new CocosError('VERIFICATION_FAILED', 'Compiler returned an invalid artifact manifest');
    const expectedRevision = createHash('sha256').update(Json.canonical([...artifacts].sort((a, b) => String(a.url).localeCompare(String(b.url))))).digest('hex');
    state.preview = { status: 'unknown', expectedRevision, loadedRevision: null, revisionMatched: null };
    if (!reload || !this.host.reload) { state.status = 'unknown'; return; }
    state.phase = 'preview';
    let loaded: JsonObject;
    try { loaded = await this.host.reload({ artifacts, binding: state.binding!, expectedRevision, sourceRevision: revision, operationId: state.operationId! }); }
    catch (error) {
      if (!check()) return;
      const failure = CocosError.from(error);
      if (!['CONTEXT_UNAVAILABLE', 'OUTCOME_UNKNOWN', 'TIMEOUT'].includes(failure.code)) throw error;
      state.preview = { ...Json.object(state.preview), reason: this.redact.text(failure.message), connection: 'disconnected' }; state.status = 'unknown'; return;
    }
    if (!check()) return;
    // 不接受 URL 参数或注入的 revision 变量；连接器必须从本次导航实际加载的脚本字节取摘要。
    if (Json.canonical(after) !== Json.canonical(await this.fingerprint(paths, urls))) throw new CocosError('STALE_REVISION', 'Assets changed during preview reload');
    if (!['loaded-script-bytes', 'loaded-artifact-bytes'].includes(String(loaded.evidence)) || !loaded.navigationId || !Array.isArray(loaded.artifacts)) { state.status = 'unknown'; return; }
    const actual = loaded.artifacts.map(row => Json.object(row));
    const selected = artifacts.map(expected => actual.find(row => row.url === expected.url || (loaded.url && row.url === new URL(String(expected.url), String(loaded.url)).href)));
    if (selected.some(row => !row)) { state.preview = { ...Json.object(state.preview), reason: 'Actual loaded bytes were not observed for every artifact',
      expectedArtifacts: artifacts, observedArtifacts: actual, navigationId: loaded.navigationId, gameReady: loaded.gameReady ?? null }; state.status = 'unknown'; return; }
    const matched = selected.every((row, index) => row?.sha256 === artifacts[index]!.sha256 && (artifacts[index]!.kind !== 'resource' || row?.kind === 'resource'));
    state.preview = { status: matched && loaded.gameReady === true ? 'ready' : 'unknown', expectedRevision, loadedRevision: matched ? expectedRevision : null, revisionMatched: matched, navigationId: loaded.navigationId, url: loaded.url ?? null };
    state.status = matched && loaded.gameReady === true ? 'completed' : 'failed';
  }
  dispose(): void { if (this.active?.pending) { this.active.cancelled = true; this.active.state.status = 'cancelled'; } }
}
