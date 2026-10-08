import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ExternalPreview, ProjectBrowserConnector, type ExternalBrowserPort } from '../extensions/shared/external-preview.js';
import { PreviewRefresh, type PreviewRefreshHost } from '../extensions/shared/preview-refresh.js';
import { PreviewRedaction } from '../extensions/shared/preview-redaction.js';
import { PreviewDiagnosis } from '../extensions/shared/preview-diagnose.js';
import { ManagedPreview, type PreviewWindow } from '../extensions/creator3/src/preview.js';
import type { PreviewDebugger } from '../extensions/creator3/src/preview-diagnostics.js';
import { Creator2PreviewCompiler, type Creator2ProjectCompiler } from '../extensions/creator2/src/preview-compiler.js';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { Json, type JsonObject, type JsonValue } from '../packages/contracts/src/index.js';

class BrowserStub implements ExternalBrowserPort {
  calls: Array<{ method: string; params: JsonObject }> = [];
  connected = true; owned = false; wrongPage = false;
  observed: JsonObject = {};
  async call(method: string, params: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, params });
    return { ...this.observed, sessionId: params.sessionId!, url: this.wrongPage ? 'http://localhost/another-project' : params.url!, tabId: 'tab-1', owned: this.owned, connection: this.connected ? 'connected' : 'disconnected', pageOpened: true, gameReady: false };
  }
}
class Fixture {
  server: Server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<canvas></canvas>'); });
  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    const address = this.server.address(); assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}/`;
  }
  async stop(): Promise<void> { await new Promise<void>(resolve => this.server.close(() => resolve())); }
  async project(): Promise<string> {
    const root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/preview-refresh-'));
    await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets/source.js'), 'const label = "new text";');
    return root;
  }
  async finish(refresh: { execute(method: string, params: JsonObject): Promise<JsonValue> }, operationId: string): Promise<JsonObject> {
    // 等待状态而非固定睡眠；测试有显式 deadline。
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const state = Json.object(await refresh.execute('refresh.status', { operationId }));
      if (state.finishedAt) return state;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error('Refresh fixture deadline exceeded');
  }
}

test('external target never creates Electron; absent connector reports service only', async () => {
  const fixture = new Fixture(), url = await fixture.start();
  try {
    const managed = new ManagedPreview({ create: () => { throw new Error('Must not create embedded window'); } });
    const result = Json.object(await managed.execute('start', { target: 'external-browser', browser: 'chrome', url, sceneId: 'scene' }));
    assert.equal(result.status, 'service-ready'); assert.equal(result.pageReady, false); assert.equal(result.gameReady, false); assert.equal(result.connection, 'disconnected');
    assert.ok(String(result.url).includes('scene=scene'));
  } finally { await fixture.stop(); }
});

test('external state distinguishes launch from current scene and preserves full image and identity while rejecting stale input before dispatch', async () => {
  const fixture = new Fixture(), url = await fixture.start(), browser = new BrowserStub(), preview = new ExternalPreview(browser);
  try {
    browser.observed = { currentSceneId: 'room', sceneGeneration: 4, frameIndex: 10, runtimeInstanceId: 'runtime', dataUrl: 'data:image/png;base64,' + Buffer.alloc(20000).toString('base64'), token: 'secret-account' };
    const start = Json.object(await preview.execute('start', { url, sceneId: 'login' })); assert.equal(start.launchSceneId, 'login'); assert.equal(start.currentSceneId, 'room'); assert.equal(start.sceneGeneration, 4);
    const capture = Json.object(await preview.execute('capture', {})); assert.equal(capture.dataUrl, browser.observed.dataUrl); assert.equal(capture.sessionId, start.sessionId); assert.doesNotMatch(JSON.stringify(capture), /secret-account/);
    await assert.rejects(preview.execute('input', { expectedSceneId: 'login' }), { code: 'VERIFICATION_FAILED' }); assert.equal(browser.calls.filter(row => row.method === 'input').length, 0);
    const call = browser.call.bind(browser); browser.call = async (method, params) => { if (method === 'input') throw new Error('Input acknowledgement lost'); return call(method, params); };
    await assert.rejects(preview.execute('input', { expectedSceneId: 'room' }), { code: 'OUTCOME_UNKNOWN' });
  } finally { await fixture.stop(); }
});

test('scoped connector exports project PNG bytes without allowing screenshot paths outside the project', async () => {
  const root = await new Fixture().project(), directory = join(root, '.codex-work/cache/cocos-mcp'); await mkdir(directory, { recursive: true });
  const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(20, 16); png.writeUInt32BE(10, 20);
  const image = join(root, '.codex-work/artifacts/capture.png'); await mkdir(join(image, '..'), { recursive: true }); await writeFile(image, png);
  let path = '.codex-work/artifacts/capture.png'; const token = 't'.repeat(64);
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`); response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ protocolVersion: 1, projectPath: root, result: { path } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    await writeFile(join(directory, 'browser-connector.json'), JSON.stringify({ protocolVersion: 1, projectPath: root, endpoint: `http://127.0.0.1:${address.port}`, token }));
    const connector = new ProjectBrowserConnector(root), captured = await connector.call('capture', {});
    assert.equal(captured.width, 20); assert.equal(captured.height, 10); assert.equal(Json.object(captured.image).byteLength, png.length);
    assert.equal(captured.dataUrl, 'data:image/png;base64,' + png.toString('base64')); assert.doesNotMatch(JSON.stringify(captured), new RegExp(token));
    path = '../outside.png'; await assert.rejects(connector.call('capture', {}), { code: 'CONTEXT_UNAVAILABLE' });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('embedded refresh uses its own window without a Chrome connector and proves loaded bytes or returns unknown', async () => {
  for (const instrumentation of [true, false]) {
    const fixture = new Fixture(), root = await fixture.project(), compiled = 'compiled text';
    const callbacks = new Map<string, (...args: any[]) => void>(); let attached = false, navigations = 0;
    const debuggerApi: PreviewDebugger = { attach: () => { attached = true; }, detach: () => { attached = false; }, isAttached: () => attached,
      on: (name, fn) => callbacks.set(name, fn), removeListener: name => callbacks.delete(name),
      sendCommand: async method => method === 'Debugger.getScriptSource' ? { scriptSource: compiled } : { identifier: 'bootstrap' } };
    const window: PreviewWindow = { loadURL: async url => {
      navigations++;
      callbacks.get('message')?.({}, 'Page.frameNavigated', { frame: { id: 'main', loaderId: 'navigation-' + navigations, url } });
      callbacks.get('message')?.({}, 'Debugger.scriptParsed', { url: 'http://127.0.0.1:7456/compiled.js', scriptId: 'compiled', length: compiled.length, executionContextAuxData: { frameId: 'main' } });
    }, isDestroyed: () => false, destroy: () => {}, once: () => {}, webContents: { ...(instrumentation ? { debugger: debuggerApi } : {}), isDestroyed: () => false, on: () => {},
      session: { setPermissionRequestHandler: () => {} }, executeJavaScript: async () => ({ ready: true, sceneId: 'scene', sceneGeneration: 1 }),
      capturePage: async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,dGVzdA==', getSize: () => ({ width: 800, height: 600 }) }) } };
    const preview = new ManagedPreview({ create: () => window }, root, 2, { projectPath: root, importResource: async () => null,
      compile: async batch => ({ status: 'completed', sourceRevision: batch.sourceRevision!, errors: [], artifacts: [{ url: '/compiled.js', sha256: createHash('sha256').update(compiled).digest('hex') }] }) });
    await preview.execute('start', { url: 'http://127.0.0.1:7456', sceneId: 'scene' });
    const operation = Json.object(await preview.execute('refresh', { urls: ['db://assets/source.js'], target: 'embedded' }));
    const result = await fixture.finish(preview, String(operation.operationId));
    assert.equal(navigations, 3, 'refresh navigates only the owned embedded window');
    assert.equal(result.status, instrumentation ? 'completed' : 'unknown');
    assert.equal(Json.object(result.binding).target, 'embedded'); preview.dispose();
  }
});

test('source changes during compilation reject stale refresh without reloading', async () => {
  const fixture = new Fixture(), root = await fixture.project(); let reloads = 0;
  const refresh = new PreviewRefresh({ projectPath: root, importResource: async () => null,
    compile: async batch => { await writeFile(join(root, 'assets/source.js'), 'changed during compile'); return { status: 'completed', sourceRevision: batch.sourceRevision!, errors: [], artifacts: [{ url: '/compiled.js', sha256: '1'.repeat(64) }] }; },
    reload: async () => { reloads++; return {}; } });
  const operation = Json.object(await refresh.execute('refresh', { urls: ['db://assets/source.js'] }));
  const result = await fixture.finish(refresh, String(operation.operationId));
  assert.equal(result.status, 'failed'); assert.equal(Json.object(result.error).code, 'STALE_REVISION'); assert.equal(reloads, 0);
});
test('external lifecycle reuses the page, closes only owned tabs, and rejects navigation drift', async () => {
  const fixture = new Fixture(), url = await fixture.start(), browser = new BrowserStub(), preview = new ExternalPreview(browser);
  try {
    await preview.execute('start', { url, sceneId: 's' }); await preview.execute('start', { url, sceneId: 's' });
    assert.equal(browser.calls.filter(row => row.method === 'start').length, 1);
    browser.wrongPage = true; await assert.rejects(preview.execute('capture', {}), /changed/);
    browser.wrongPage = false; browser.connected = false;
    const disconnected = Json.object(await preview.execute('status', {})); assert.equal(disconnected.running, false); assert.equal(disconnected.pageReady, false);
    browser.connected = true; await preview.execute('stop', {}); assert.equal(browser.calls.at(-1)!.params.closeTab, false);
    browser.owned = true; await preview.execute('start', { url, sceneId: 's' }); await preview.execute('stop', {}); assert.equal(browser.calls.at(-1)!.params.closeTab, true);
  } finally { await fixture.stop(); }
});
test('refresh tracks actual imported content and does not pretend a callback proves compilation', async () => {
  const fixture = new Fixture(), root = await fixture.project();
  const refresh = new PreviewRefresh({ projectPath: root, importResource: async () => null });
  const started = Json.object(await refresh.execute('refresh', { urls: ['db://assets/source.js'] }));
  const result = await fixture.finish(refresh, String(started.operationId));
  assert.equal(result.status, 'unknown'); assert.equal(Json.object(result.import).status, 'completed'); assert.match(String(Json.object(result.import).revision), /^[a-f0-9]{64}$/);
  assert.equal(Json.object(result.compile).status, 'unknown'); assert.equal(Json.object(result.preview).revisionMatched, null);
});
test('refresh compile failure preserves file and line and never reloads', async () => {
  const fixture = new Fixture(), root = await fixture.project(); let reloaded = false;
  const refresh = new PreviewRefresh({ projectPath: root, importResource: async () => null, compile: async () => ({ status: 'failed', errors: [{ url: 'db://assets/source.js', line: 2, message: 'Unexpected token' }] }), reload: async () => { reloaded = true; return {}; } });
  const started = Json.object(await refresh.execute('refresh', { urls: ['db://assets/source.js'] }));
  const result = await fixture.finish(refresh, String(started.operationId)); assert.equal(result.status, 'failed'); assert.equal(reloaded, false); assert.equal((Json.object(result.compile).errors as JsonObject[])[0]!.line, 2);
});
test('refresh verifies loaded artifact hashes; revision echo is not accepted', async () => {
  const fixture = new Fixture(), root = await fixture.project(), artifacts = [{ url: '/compiled.js', sha256: createHash('sha256').update('compiled text').digest('hex') }];
  for (const proof of ['echo', 'mismatch', 'match']) {
    const host: PreviewRefreshHost = { projectPath: root, importResource: async () => null,
      compile: async batch => ({ status: 'completed', sourceRevision: batch.sourceRevision!, artifacts, errors: [] }),
      reload: async manifest => proof === 'echo' ? { loadedRevision: manifest.expectedRevision! } : { evidence: 'loaded-script-bytes', navigationId: 'navigation-2', gameReady: true, artifacts: proof === 'match' ? artifacts : [{ ...artifacts[0]!, sha256: '0'.repeat(64) }] } };
    const refresh = new PreviewRefresh(host), started = Json.object(await refresh.execute('refresh', { urls: ['db://assets/source.js'] }));
    const result = await fixture.finish(refresh, String(started.operationId));
    assert.equal(result.status, proof === 'match' ? 'completed' : proof === 'echo' ? 'unknown' : 'failed');
    if (proof === 'match') assert.equal(Json.object(result.preview).expectedRevision, Json.object(result.preview).loadedRevision);
  }
});
test('cancel and timeout stop subsequent stages while preserving in-flight native ownership', async () => {
  const fixture = new Fixture(), root = await fixture.project();
  for (const mode of ['cancel', 'timeout']) {
    let release!: () => void, entered!: () => void, compiled = false;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const refresh = new PreviewRefresh({ projectPath: root, importResource: async () => { entered(); await pending; }, compile: async () => { compiled = true; return {}; } });
    const started = Json.object(await refresh.execute('refresh', { urls: ['db://assets/source.js'], timeoutMs: 100 })); await entry;
    if (mode === 'cancel') await refresh.execute('refresh.cancel', { operationId: started.operationId! });
    else await new Promise(resolve => setTimeout(resolve, 120));
    const state = Json.object(await refresh.execute('refresh.status', { operationId: started.operationId! })); assert.equal(state.status, mode === 'cancel' ? 'cancelled' : 'timeout');
    await assert.rejects(refresh.execute('refresh', { urls: ['db://assets/source.js'] }), /in flight/);
    release(); await fixture.finish(refresh, String(started.operationId)); assert.equal(compiled, false);
  }
});
test('redaction covers headers, query, forms, JSON, credentials and log stacks', () => {
  const redact = new PreviewRedaction(), secrets = ['PW-123', 'TOKEN-123', 'AUTH-123', 'COOKIE-123', 'SIGN-123'];
  const result = redact.value({ headers: { Authorization: 'AUTH-123', Cookie: 'COOKIE-123' }, body: { password: 'PW-123', nested: { accessToken: 'TOKEN-123' } }, form: 'password=PW-123&signature=SIGN-123', url: 'http://localhost/path?token=TOKEN-123', stack: 'failure {"password":"PW-123"}\nAuthorization: Bearer AUTH-123', log: 'token: TOKEN-123' });
  for (const secret of secrets) assert.equal(JSON.stringify(result).includes(secret), false, secret);
});
test('diagnosis distinguishes HTTP/CORS/WS evidence without inventing incompatibility', () => {
  const result = new PreviewDiagnosis().summarize({ connection: 'connected', hasMore: false, rows: [
    { sequence: 1, kind: 'http-error', status: 401 }, { sequence: 2, kind: 'network-failure', corsError: 'MissingAllowOriginHeader' },
    { sequence: 3, requestId: 'socket', kind: 'websocket-handshake', status: 101 }, { sequence: 4, requestId: 'socket', kind: 'websocket-frame', frameType: 'binary', direction: 'sent' },
  ] });
  assert.deepEqual((result.findings as JsonObject[]).map(row => row.code), ['HTTP_ERROR_STATUS', 'CORS_BLOCKED', 'WEBSOCKET_NO_RESPONSE_OBSERVED']); assert.equal(result.applicationProtocol, 'unknown');
});
test('catalog accepts new defaults and rejects unbounded requests', () => {
  const catalog = new CapabilityCatalog();
  catalog.validate('preview.start', {}); catalog.validate('preview.start', { target: 'external-browser', browser: 'chrome', reuseExisting: true });
  catalog.validate('preview.refresh', { urls: ['db://assets/source.js'] });
  assert.throws(() => catalog.validate('preview.refresh', { urls: [], timeoutMs: 999999 }));
});

test('Creator 2 compiler refuses stale source maps and checks import errors before native code clears them', async () => {
  const fixture = new Fixture(), project = await fixture.project(), source = 'const label = "new text";';
  const imported = join(project, '.codex-work/build/import.js');
  await mkdir(join(project, '.codex-work/build'), { recursive: true });
  await mkdir(join(project, 'temp/quick-scripts/dst'), { recursive: true });
  await writeFile(imported + '.map', JSON.stringify({ sourcesContent: [source] }));
  const module = join(project, 'temp/quick-scripts/dst/compiled.js');
  const inline = Buffer.from(JSON.stringify({sourcesContent: [source]})).toString('base64');
  await writeFile(module, source + '\n//# sourceMappingURL=data:application/json;base64,' + inline);
  for (const name of ['__qc_bundle__.js', '__quick_compile__.js']) await writeFile(join(project, 'temp/quick-scripts/dst', name), source);
  let compiled = 0;
  const native: Creator2ProjectCompiler = { errorScripts: {}, compileScripts: async () => { compiled++; }, raw2import: () => imported, raw2dest: () => module, isPlugin: () => false };
  const compiler = new Creator2PreviewCompiler(project, '2.4.15', () => native, () => 'script-uuid', () => 'db://assets/source.js');
  const batch = { sourceRevision: 'source-revision', rows: [{ url: 'db://assets/source.js', sha256: createHash('sha256').update(source).digest('hex') }] };
  assert.equal((await compiler.compile(batch, () => false)).status, 'completed');
  await writeFile(module, 'old code\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify({sourcesContent: ['old text']})).toString('base64'));
  const delayedWrite = new Promise<void>(resolve => setTimeout(() => { void writeFile(module, source + '\n//# sourceMappingURL=data:application/json;base64,' + inline).then(resolve); }, 100));
  assert.equal((await compiler.compile(batch, () => false)).status, 'completed'); await delayedWrite;
  await writeFile(imported + '.map', JSON.stringify({ sourcesContent: ['old text'] }));
  assert.equal((await compiler.compile(batch, () => false)).status, 'unknown');
  native.errorScripts = { 'script-uuid': ['Unexpected token (3:12)'] };
  const failure = await compiler.compile(batch, () => false); assert.equal(compiled, 3); assert.equal(failure.status, 'failed');
  assert.equal((failure.errors as JsonObject[])[0]!.line, 3); assert.equal((failure.errors as JsonObject[])[0]!.column, 12);
});
