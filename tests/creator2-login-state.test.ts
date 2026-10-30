import test from 'node:test';
import assert from 'node:assert/strict';
import { Creator2LoginState } from '../extensions/creator2/src/login-state.js';
import { Creator2Adapter, type Creator2Port } from '../packages/creator2-adapter/src/index.js';

test('Creator 2 login status accepts only native booleans and preserves receiver', async () => {
  const reader = new Creator2LoginState();
  for (const value of [true, false, undefined, null, 1, 'true', {}]) {
    const user = { value, isLoggedIn() { assert.equal(this, user); return this.value; } };
    assert.equal(await reader.query('2.4.15', user), value === true ? 'logged-in' : value === false ? 'logged-out' : 'unknown');
  }
  assert.equal(await reader.query('2.4.15', { isLoggedIn: async () => true }), 'logged-in');
  let calls = 0;
  assert.equal(await reader.query('2.4.14', { isLoggedIn() { calls++; return true; } }), 'unknown');
  assert.equal(calls, 0);
  assert.equal(await reader.query('2.4.15'), 'unknown');
});

test('Creator 2 login failures and timeout remain unknown without leaking native errors', async () => {
  const reader = new Creator2LoginState(10);
  assert.equal(await reader.query('2.4.15', { isLoggedIn() { throw new Error('private-login-details'); } }), 'unknown');
  assert.equal(await reader.query('2.4.15', { isLoggedIn: async () => { throw new Error('private-login-details'); } }), 'unknown');
  assert.equal(await reader.query('2.4.15', { isLoggedIn: () => new Promise(() => {}) }), 'unknown');
});

test('Creator 2 adapter exposes native login status and keeps old ports unknown', async () => {
  const port: Creator2Port = { version: '2.4.15', projectPath: '.', scene: async () => null,
    asset: async () => null, selection: () => [], ipc: async () => null };
  assert.equal(await new Creator2Adapter(port).loginState(), 'unknown');
  for (const state of ['logged-in', 'logged-out', 'unknown'] as const) {
    port.loginState = async () => state;
    assert.equal(await new Creator2Adapter(port).loginState(), state);
  }
});
