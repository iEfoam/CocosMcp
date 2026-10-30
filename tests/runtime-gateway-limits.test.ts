import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RuntimeGateway, type RuntimeGatewayLimits } from '../packages/application/src/runtime-gateway.js';
import { ProjectRegistry } from '../packages/application/src/registry.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';

class GatewayResponse extends EventEmitter {
  destroyed = false;
  status = 0;
  value: JsonObject = {};
  writeHead(status: number): void { this.status = status; }
  setHeader(): void {}
  end(value: string): void { this.value = Json.object(JSON.parse(value)); }
}
class GatewayFixture {
  readonly limits: RuntimeGatewayLimits = { sessionsPerProject: 1, sessions: 2, pendingPerSession: 1, pending: 2, bodyBytes: 512, replyBytes: 1024, bodyTimeoutMs: 30, bodyReaders: 1 };
  readonly gateway = new RuntimeGateway(new ProjectRegistry(), 1000, 30000, Date.now, () => performance.now(), this.limits);
  readonly internal = this.gateway as unknown as { tokens: Map<string, string>; body(request: IncomingMessage): Promise<JsonObject>; handle(request: IncomingMessage, response: ServerResponse): Promise<void>; sessions: Map<string, { wake?: () => void }> };
  constructor() { this.internal.tokens.set('p', 'token'); }
  request(route: string, value: JsonObject, token = 'token'): IncomingMessage {
    return Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), { method: 'POST', url: route, headers: { authorization: `Bearer ${token}` } }) as unknown as IncomingMessage;
  }
  async call(route: string, value: JsonObject, response = new GatewayResponse(), token = 'token'): Promise<GatewayResponse> {
    await this.internal.handle(this.request(route, value, token), response as unknown as ServerResponse); return response;
  }
}

test('runtime rejects unauthenticated bodies, oversized messages and registration overflow', async () => {
  const f = new GatewayFixture();
  assert.equal((await f.call('/runtime/register', { projectId: 'p', padding: 'x'.repeat(600) }, undefined, 'invalid')).status, 403);
  assert.equal((await f.call('/runtime/register', { projectId: 'p', padding: 'x'.repeat(600) })).status, 400);
  assert.equal((await f.call('/runtime/register', { projectId: 'p' })).status, 200);
  assert.equal(Json.object((await f.call('/runtime/register', { projectId: 'p' })).value.error).code, 'RESOURCE_BUSY');
  assert.equal(Json.object((await f.call('/runtime/register', { projectId: 'other' })).value.error).code, 'UNAUTHORIZED');
  await f.gateway.close();
});

test('runtime poll exclusivity, disconnect cleanup and command capacity are bounded', async () => {
  const f = new GatewayFixture();
  const registration = await f.call('/runtime/register', { projectId: 'p' });
  const id = String(registration.value.runtimeInstanceId), body = { projectId: 'p', runtimeInstanceId: id };
  const response = new GatewayResponse(), waiting = f.call('/runtime/poll', body, response);
  try {
    for (let attempts = 0; !f.internal.sessions.get(id)?.wake && attempts < 20; attempts++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.internal.sessions.get(id)?.wake);
    assert.equal(Json.object((await f.call('/runtime/poll', body)).value.error).code, 'RESOURCE_BUSY');
    response.destroyed = true; response.emit('close'); await waiting;
    assert.equal(f.internal.sessions.get(id)?.wake, undefined);
    const cancellation = new AbortController();
    const pending = f.gateway.execute('p', id, 'runtime.query', {}, cancellation.signal);
    const rejected = assert.rejects(pending, { code: 'OUTCOME_UNKNOWN' });
    await assert.rejects(f.gateway.execute('p', id, 'runtime.query', {}), { code: 'RESOURCE_BUSY' });
    cancellation.abort(); await rejected;
  } finally { response.destroyed = true; response.emit('close'); await waiting; await f.gateway.close(); }
});

test('slow runtime body is cancelled and releases reader capacity', async () => {
  const f = new GatewayFixture();
  const stream = Object.assign(new Readable({ read() {} }), { url: '/runtime/register', headers: {} }) as unknown as IncomingMessage;
  await assert.rejects(f.internal.body(stream), { code: 'TIMEOUT' });
  assert.equal((await f.call('/runtime/register', { projectId: 'p' })).status, 200);
  await f.gateway.close();
});

test('global session admission and disconnect release pending capacity without claiming native cancellation', async () => {
  const f = new GatewayFixture(); f.internal.tokens.set('q', 'q-token'); f.internal.tokens.set('r', 'r-token');
  try {
    const p = await f.call('/runtime/register', { projectId: 'p' });
    await f.call('/runtime/register', { projectId: 'q' }, undefined, 'q-token');
    assert.equal(Json.object((await f.call('/runtime/register', { projectId: 'r' }, undefined, 'r-token')).value.error).code, 'RESOURCE_BUSY');
    const id = String(p.value.runtimeInstanceId), pending = f.gateway.execute('p', id, 'runtime.query', {});
    const rejected = assert.rejects(pending, { code: 'OUTCOME_UNKNOWN' });
    assert.equal((await f.call('/runtime/disconnect', { projectId: 'p', runtimeInstanceId: id })).value.disconnected, true);
    await rejected;
    assert.equal((await f.call('/runtime/register', { projectId: 'r' }, undefined, 'r-token')).status, 200);
  } finally { await f.gateway.close(); }
});

test('real HTTP transports image replies and ignores late replies after cancellation without consuming a later command', async () => {
  const f = new GatewayFixture(), port = await f.gateway.start();
  const post = async (route: string, body: JsonObject): Promise<{ status: number; body: JsonObject }> => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: Json.object(await response.json()) };
  };
  try {
    const registered = await post('/runtime/register', { projectId: 'p' }); assert.equal(registered.status, 200);
    const id = String(registered.body.runtimeInstanceId), session = { projectId: 'p', runtimeInstanceId: id };
    const controller = new AbortController(), first = f.gateway.execute('p', id, 'runtime.capture', {}, controller.signal);
    const rejected = assert.rejects(first, { code: 'OUTCOME_UNKNOWN' });
    const old = Json.object((await post('/runtime/poll', session)).body.command);
    controller.abort(); await rejected;
    const second = f.gateway.execute('p', id, 'runtime.capture', {});
    // 在 HTTP 断言失败时也接住挂起任务的拒绝，避免 finally 关闭网关制造未处理异常。
    const secondResult = second.then(result => ({ result }), error => ({ error }));
    const current = Json.object((await post('/runtime/poll', session)).body.command);
    assert.notEqual(current.id, old.id);
    assert.equal((await post('/runtime/reply', { ...session, commandId: old.id!, result: 'stale' })).body.accepted, false);
    assert.equal((await post('/runtime/reply', { ...session, commandId: current.id!, result: 'x'.repeat(1100) })).status, 400);
    const png = Buffer.alloc(480); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    const image = { dataUrl: `data:image/png;base64,${png.toString('base64')}` };
    assert.ok(Buffer.byteLength(JSON.stringify(image)) > f.limits.bodyBytes);
    assert.equal((await post('/runtime/reply', { ...session, commandId: current.id!, result: image })).body.accepted, true);
    const outcome = await secondResult; assert.ok('result' in outcome); assert.deepEqual(outcome.result, image);
    assert.equal((await post('/runtime/reply', { ...session, commandId: current.id!, result: image })).body.accepted, false);
  } finally { await f.gateway.close(); }
});
