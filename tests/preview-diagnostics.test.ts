import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { PreviewDiagnostics, type PreviewDebugger } from '../extensions/creator3/src/preview-diagnostics.js';
import type { JsonObject } from '../packages/contracts/src/index.js';
import { createHash } from 'node:crypto';
class DebuggerStub implements PreviewDebugger {
  attached = false; commands: Array<{method: string; params?: Record<string, unknown>}> = []; callbacks = new Map<string, (...args: any[]) => void>();
  attach(): void { this.attached = true; } detach(): void { this.attached = false; } isAttached(): boolean { return this.attached; }
  on(event: string, callback: (...args: any[]) => void): void { this.callbacks.set(event, callback); }
  removeListener(event: string): void { this.callbacks.delete(event); }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> { this.commands.push({method, ...(params ? {params} : {})}); return {identifier:'source'}; }
  emit(method: string, params: unknown): void { this.callbacks.get('message')?.({}, method, params); }
}
test('page listeners preserve default handling and emit structured errors and promise stacks before navigation', async () => {
  const log = new PreviewDiagnostics(), d = new DebuggerStub(); await log.attach(d);
  const binding = d.commands.find(c=>c.method==='Runtime.addBinding')!.params!.name as string;
  const source = d.commands.find(c=>c.method==='Page.addScriptToEvaluateOnNewDocument')!.params!.source as string;
  const listeners = new Map<string, (event: unknown) => void>();
  const context = { addEventListener: (name: string, cb: (event: unknown)=>void) => listeners.set(name,cb), location:{href:'http://localhost/game?token=secret'}, [binding]: (payload: string)=>d.emit('Runtime.bindingCalled',{name:binding,payload}) };
  runInNewContext(source, context);
  const error = {message:'broken',filename:'http://localhost/a.js?token=secret',lineno:12,colno:4,error:{stack:'Error: broken\n at f (a.js:12:4)'},preventDefault:()=>assert.fail('must not suppress errors')};
  listeners.get('error')!(error); listeners.get('unhandledrejection')!({reason:{message:'rejected',stack:'Promise stack'}});
  const rows=(await log.query({})).rows as JsonObject[];
  assert.equal(rows[0]!.line,12);assert.equal(rows[0]!.column,4);assert.equal(rows[0]!.url,'http://localhost/a.js');assert.equal(rows[1]!.stack,'Promise stack');assert.match(String(rows[0]!.occurredAt),/Z$/);
  log.dispose();assert.equal(d.attached,false);
});
test('network failures and HTTP errors are bounded, sanitized and persisted for cursor pagination after restart', async () => {
  const project = await mkdtemp(join(process.cwd(),'.codex-work/tmp/web-logs-'));
  const log=new PreviewDiagnostics(project), d=new DebuggerStub();await log.attach(d);
  d.emit('Network.requestWillBeSent',{requestId:'a',request:{url:'http://user:password@localhost/data?secret=1',method:'GET',headers:{Authorization:'secret'}}});
  d.emit('Network.loadingFailed',{requestId:'a',errorText:'net::ERR_FAILED'});
  d.emit('Network.responseReceived',{requestId:'b',response:{status:500,url:'http://localhost/fail'}});
  log.record({kind:'error',message:'third',stack:'x'.repeat(70000)});
  const page=await log.query({limit:1});assert.equal(page.hasMore,true);assert.ok(!JSON.stringify(page).includes('password'));
  const second=await log.query({cursor:page.nextCursor!,limit:1});assert.equal((second.rows as JsonObject[])[0]!.kind,'http-error');
  await log.flush();const reopened=new PreviewDiagnostics(project);const saved=await reopened.query({sessionId:log.sessionId});
  assert.equal((saved.rows as JsonObject[]).length,3);assert.equal((saved.rows as JsonObject[])[2]!.truncated,true);
  await assert.rejects(reopened.query({sessionId:'../escape'})); await assert.rejects(log.query({limit:501}));
  d.callbacks.get('detach')!({},'devtools');assert.equal(((await log.query({kind:'capture-gap'})).rows as JsonObject[]).length,1);
  log.dispose();reopened.dispose();await log.flush();await reopened.flush();
});
test('capture does not detach another debugger and reports missing instrumentation explicitly', async()=>{
 const d=new DebuggerStub();d.attached=true;const log=new PreviewDiagnostics();await log.attach(d);log.dispose();assert.equal(d.attached,true);assert.equal(d.commands.length,0);
 assert.equal(((await log.query({})).rows as JsonObject[])[0]!.kind,'capture-gap');
});

test('WebSocket capture retains only frame metadata and distinguishes explicit CORS errors', async () => {
  const log = new PreviewDiagnostics(), d = new DebuggerStub(); await log.attach(d);
  d.emit('Network.webSocketCreated', { requestId: 'ws', url: 'ws://localhost/socket?token=TOKEN-WS' });
  d.emit('Network.webSocketHandshakeResponseReceived', { requestId: 'ws', response: { status: 101, headers: { Cookie: 'COOKIE-WS' } } });
  d.emit('Network.webSocketFrameSent', { requestId: 'ws', response: { opcode: 2, payloadData: Buffer.from('password=PASSWORD-WS').toString('base64') } });
  d.emit('Network.webSocketFrameReceived', { requestId: 'ws', response: { opcode: 1, payloadData: '{"token":"TOKEN-WS"}' } });
  d.emit('Network.webSocketFrameReceived', { requestId: 'ws', response: { opcode: 8, payloadData: Buffer.from([3, 232]).toString('base64') } });
  d.emit('Network.loadingFailed', { requestId: 'http', errorText: 'net::ERR_FAILED', corsErrorStatus: { corsError: 'MissingAllowOriginHeader' } });
  const sockets = await log.query({ category: 'websocket' }), network = await log.query({ category: 'network' });
  assert.equal((sockets.rows as JsonObject[]).length, 5);
  const frames = (sockets.rows as JsonObject[]).filter(row => row.kind === 'websocket-frame');
  assert.equal(frames[0]!.frameType, 'binary'); assert.equal(frames[0]!.size, 20); assert.equal(frames[2]!.closeCode, 1000);
  assert.equal((network.rows as JsonObject[])[0]!.corsError, 'MissingAllowOriginHeader');
  for (const secret of ['PASSWORD-WS', 'TOKEN-WS', 'COOKIE-WS', Buffer.from('password=PASSWORD-WS').toString('base64')]) assert.ok(!JSON.stringify(sockets).includes(secret));
  log.record({ kind: 'console', message: 'password=PASSWORD-WS; token=TOKEN-WS', stack: 'Authorization: Bearer SECRET-AUTH' });
  const all = await log.query({}); assert.equal(all.connection, 'connected'); assert.ok(!JSON.stringify(all).includes('SECRET-AUTH')); assert.ok(!JSON.stringify(all).includes('PASSWORD-WS'));
  const at = (all.rows as JsonObject[])[0]!.occurredAt!;
  assert.equal((await log.query({ to: at })).retained, 7);
  assert.equal(((await log.query({ to: at })).rows as JsonObject[]).length, 0);
  await assert.rejects(log.query({ from: '2026-09-22T12:00:00' }), /timezone/);
  d.callbacks.get('detach')!({}, 'lost'); assert.equal((await log.query({})).connection, 'disconnected'); log.dispose();
});

test('loaded script digests belong to a new native navigation and never persist script bodies', async () => {
  const log = new PreviewDiagnostics(), d = new DebuggerStub(); await log.attach(d);
  const source = 'const token = "source-must-not-be-logged";', url = 'http://localhost:7456/compiled.js';
  d.sendCommand = async method => method === 'Debugger.getScriptSource' ? { scriptSource: source } : {};
  const id = await log.beginRevision([{ url: '/compiled.js', sha256: 'expected' }], 'http://localhost:7456');
  const script = { url, scriptId: 'script', length: source.length, executionContextAuxData: { frameId: 'main' } };
  d.emit('Debugger.scriptParsed', script); assert.deepEqual((await log.revision(id)).artifacts, []);
  d.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'real-navigation', url: 'http://localhost:7456/?scene=s' } });
  d.emit('Debugger.scriptParsed', { ...script, executionContextAuxData: { frameId: 'other-frame' } });
  assert.deepEqual((await log.revision(id)).artifacts, []);
  d.emit('Debugger.scriptParsed', script);
  const proof = await log.revision(id); assert.equal(proof.navigationId, 'real-navigation');
  assert.deepEqual(proof.artifacts, [{ url, sha256: createHash('sha256').update(source).digest('hex') }]);
  assert.doesNotMatch(JSON.stringify(await log.query({})), /source-must-not-be-logged/);
  await assert.rejects(log.beginRevision([{ url: 'http://other-project/compiled.js' }], 'http://localhost:7456'), { code: 'UNAUTHORIZED' });
  log.dispose();
});

test('resource byte observation is restricted to reviewed artifacts and the exact native navigation', async () => {
  const log = new PreviewDiagnostics(), d = new DebuggerStub(); await log.attach(d);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), origin = 'http://localhost:7457', url = `${origin}/assets/image.png`;
  d.sendCommand = async method => method === 'Network.getResponseBody' ? { body: png.toString('base64'), base64Encoded: true } : {};
  const id = await log.beginRevision([{ url: '/assets/image.png', kind: 'resource' }], origin);
  d.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'navigation-1', url: origin } });
  const request = { requestId: 'asset', loaderId: 'navigation-1', frameId: 'main', timestamp: 1, wallTime: 1791420000, request: { url, method: 'GET' } };
  d.emit('Network.requestWillBeSent', { ...request, requestId: 'business', request: { url: `${origin}/login`, method: 'POST', postData: 'password=do-not-record' } });
  d.emit('Network.loadingFinished', { requestId: 'business', encodedDataLength: 20 });
  assert.equal(d.commands.filter(row => row.method === 'Network.getResponseBody').length, 0);
  d.emit('Network.requestWillBeSent', request);
  d.emit('Network.responseReceived', { requestId: 'asset', frameId: 'main', loaderId: 'navigation-1', response: { url, status: 200 } });
  d.emit('Network.loadingFinished', { requestId: 'asset', encodedDataLength: png.length });
  const proof = await log.revision(id); assert.equal(proof.evidence, 'loaded-artifact-bytes'); assert.equal(proof.navigationId, 'navigation-1');
  assert.deepEqual(proof.artifacts, [{ url, kind: 'resource', sha256: createHash('sha256').update(png).digest('hex') }]);
  assert.doesNotMatch(JSON.stringify(await log.query({})), /do-not-record|base64|iVBOR/);
  log.endRevision(); await assert.rejects(log.revision(id), { code: 'STALE_HANDLE' }); log.dispose();
});

test('Creator 2 current-scene snapshot interception changes only its owned scene request', async () => {
  const log = new PreviewDiagnostics(), d = new DebuggerStub(); await log.attach(d);
  const data = '{"scene":"native-current-snapshot"}';
  await log.prepareScene({ sceneId: 'scene', data }, 'http://127.0.0.1:7458');
  d.emit('Fetch.requestPaused', { requestId: 'scene', request: { url: 'http://127.0.0.1:7458/preview-scene.json', method: 'GET' } });
  d.emit('Fetch.requestPaused', { requestId: 'business', request: { url: 'http://elsewhere/login', method: 'POST' } });
  const fulfilled = d.commands.find(row => row.method === 'Fetch.fulfillRequest')!;
  assert.equal(Buffer.from(String(fulfilled.params!.body), 'base64').toString(), data);
  assert.equal(d.commands.filter(row => row.method === 'Fetch.fulfillRequest').length, 1);
  assert.equal(d.commands.find(row => row.method === 'Fetch.continueRequest')!.params!.requestId, 'business');
  assert.doesNotMatch(JSON.stringify(await log.query({})), /native-current-snapshot/); log.dispose();
});

test('resource proof maps native UUID files across Bundle prefixes while excluding wrong UUIDs and origins', async () => {
  const log = new PreviewDiagnostics(), d = new DebuggerStub(), body = 'native bytes'; await log.attach(d);
  const file = 'ab000000-0000-0000-0000-000000000001.json', origin = 'http://127.0.0.1:7458', canonical = `/assets/others/import/ab/${file}`;
  d.sendCommand = async method => method === 'Network.getResponseBody' ? { body, base64Encoded: false } : {};
  const id = await log.beginRevision([{ url: canonical, kind: 'resource', nativeFile: file }], origin);
  d.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'navigation', url: origin } });
  for (const [index, url] of [`http://elsewhere/assets/main/import/ab/${file}`, `${origin}/assets/main/import/ac/${file}`, `${origin}/assets/main/import/ab/${file}?v=2`].entries()) {
    const requestId = String(index);
    d.emit('Network.requestWillBeSent', { requestId, loaderId: 'navigation', frameId: 'main', request: { url, method: 'GET' } });
    d.emit('Network.responseReceived', { requestId, loaderId: 'navigation', frameId: 'main', response: { url, status: 200 } });
    d.emit('Network.loadingFinished', { requestId, encodedDataLength: body.length });
  }
  const proof = await log.revision(id), artifacts = proof.artifacts as JsonObject[];
  assert.equal(artifacts.length, 1); assert.equal(artifacts[0]!.url, origin + canonical); assert.equal(artifacts[0]!.sha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(artifacts[0]!.mapping, 'native-uuid-file-in-same-preview-origin'); log.dispose();
});

test('old Electron script events use native execution context identity and ignore destroyed or child contexts', async () => {
  const log = new PreviewDiagnostics(), d = new DebuggerStub(); await log.attach(d); const source = 'compiled native source', origin = 'http://127.0.0.1:7458';
  d.sendCommand = async method => method === 'Debugger.getScriptSource' ? { scriptSource: source } : {};
  const id = await log.beginRevision([{ url: '/compiled.js' }], origin);
  d.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'navigation', url: origin } });
  d.emit('Runtime.executionContextCreated', { context: { id: 1, auxData: { frameId: 'child' } } });
  d.emit('Debugger.scriptParsed', { url: origin + '/compiled.js', scriptId: 'wrong', executionContextId: 1 }); assert.deepEqual((await log.revision(id)).artifacts, []);
  d.emit('Runtime.executionContextCreated', { context: { id: 2, auxData: { frameId: 'main' } } });
  d.emit('Debugger.scriptParsed', { url: origin + '/compiled.js', scriptId: 'correct', executionContextId: 2 });
  const proof = await log.revision(id); assert.deepEqual(proof.artifacts, [{ url: origin + '/compiled.js', sha256: createHash('sha256').update(source).digest('hex') }]); assert.equal(proof.navigationId, 'navigation');
  log.endRevision(); const next = await log.beginRevision([{ url: '/compiled.js' }], origin);
  d.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'next', url: origin } });
  d.emit('Runtime.executionContextsCleared', {}); d.emit('Debugger.scriptParsed', { url: origin + '/compiled.js', scriptId: 'stale', executionContextId: 2 }); assert.deepEqual((await log.revision(next)).artifacts, []); log.dispose();
});

test('Creator 2 anonymous eval proof requires the reviewed native source map digest and hashes actual VM bytes', async () => {
  const log = new PreviewDiagnostics(), d = new DebuggerStub(); await log.attach(d);
  const origin = 'http://127.0.0.1:7458', sourceMap = 'data:application/json;base64,e30=', source = 'requested compiled module'; let reads = 0;
  d.sendCommand = async method => { if (method === 'Debugger.getScriptSource') { reads++; return { scriptSource: source }; } return {}; };
  const id = await log.beginRevision([{ url: '/preview-scripts/assets/Test.js', sourceMapSha256: createHash('sha256').update(sourceMap).digest('hex') }], origin);
  d.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'navigation', url: origin } });
  d.emit('Runtime.executionContextCreated', { context: { id: 1, auxData: { frameId: 'main' } } });
  d.emit('Debugger.scriptParsed', { url: '', scriptId: 'business', sourceMapURL: 'unreviewed', executionContextId: 1 }); assert.equal(reads, 0);
  d.emit('Debugger.scriptParsed', { url: '', scriptId: 'requested', sourceMapURL: sourceMap, executionContextId: 1 });
  const artifacts = (await log.revision(id)).artifacts as JsonObject[]; assert.equal(reads, 1); assert.equal(artifacts[0]!.sha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(artifacts[0]!.mapping, 'native-inline-source-map-digest'); assert.doesNotMatch(JSON.stringify(await log.query({})), /requested compiled module|e30=/); log.dispose();
});
