import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv } from 'ajv';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import type { Capability } from '../packages/contracts/src/index.js';

test('deferred validation reuses canonical field sets, bounds AJV entries and retains argument validation', t => {
  const capabilities: Capability[] = Array.from({ length: 130 }, (_, i) => ({
    id: `custom.${i}`, title: 'test', description: 'Cache regression fixture', outputSchema: {}, module: 'custom', context: 'editor', effect: 'read', versions: [3], supportedMajors: [3],
    implementation: 'implemented', verification: 'unverified', inputSchema: { type: 'object', properties: { target: { type: 'string' }, count: { type: 'integer', minimum: 1 } }, required: ['target', 'count'], additionalProperties: false },
  }));
  const catalog = new CapabilityCatalog(capabilities);
  const compile = t.mock.method(Ajv.prototype, 'compile');
  const remove = t.mock.method(Ajv.prototype, 'removeSchema');
  catalog.validateDeferred('custom.0', {}, ['target', 'count']);
  catalog.validateDeferred('custom.0', {}, ['count', 'target']);
  assert.equal(compile.mock.callCount(), 1);
  assert.throws(() => catalog.validateDeferred('custom.0', { count: 0 }, ['target']), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => catalog.validateDeferred('custom.0', { target: 'duplicate' }, ['target']), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => catalog.validateDeferred('custom.0', {}, ['unknown']), { code: 'INVALID_ARGUMENT' });
  for (let i = 1; i < 130; i++) catalog.validateDeferred(`custom.${i}`, { count: 1 }, ['target']);
  assert.ok(remove.mock.callCount() >= 2);
  const compiled = compile.mock.callCount();
  catalog.validateDeferred('custom.129', { count: 1 }, ['target']); assert.equal(compile.mock.callCount(), compiled);
  catalog.validateDeferred('custom.0', {}, ['target', 'count']); assert.equal(compile.mock.callCount(), compiled + 1);
});
