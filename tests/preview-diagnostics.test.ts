import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { PreviewDiagnostics, type PreviewDebugger } from '../extensions/creator3/src/preview-diagnostics.js';
import type { JsonObject } from '../packages/contracts/src/index.js';
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
