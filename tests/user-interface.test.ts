import assert from 'node:assert/strict';
import test from 'node:test';
import { UserInterfaceInspection } from '../extensions/shared/user-interface.js';

test('user interface inspection never reads credentials or invokes getters and callbacks', () => {
  let calls = 0;
  const user = { token: 'secret-fixture', isLoggedIn() { calls++; return true; }, get account() { calls++; throw new Error('must not run'); } };
  const result = new UserInterfaceInspection().inspect({ User: user });
  assert.deepEqual(result.rows, [{ name: 'account', kind: 'accessor' }, { name: 'isLoggedIn', kind: 'method' }, { name: 'token', kind: 'value' }]);
  assert.equal(calls, 0); assert.ok(!JSON.stringify(result).includes('secret-fixture'));
  assert.equal(new UserInterfaceInspection().inspect({ get User() { calls++; throw new Error('must not run'); } }).available, false);
  assert.equal(calls, 0);
});

test('user interface inspection bounds members and prototype traversal', () => {
  const inspect = new UserInterfaceInspection();
  assert.equal(inspect.inspect({ User: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`m${i}`, i])) }).rows.length, 128);
  let user = {};
  for (let i = 0; i < 5; i++) user = Object.create(user);
  assert.equal(inspect.inspect({ User: user }).truncated, true);
  assert.equal(inspect.inspect({}).available, false);
});
