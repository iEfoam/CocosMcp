import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { CocosError, Json, type JsonValue } from '../packages/contracts/src/index.js';

test('serialized editor errors preserve validated codes and partial outcomes across IPC', () => {
  const restored = CocosError.from({ code: 'OUTCOME_UNKNOWN', message: 'Structure interrupted', details: { completed: ['a'], pending: ['b'] } });
  assert.equal(restored.code, 'OUTCOME_UNKNOWN'); assert.equal(restored.message, 'Structure interrupted');
  assert.deepEqual(restored.details, { completed: ['a'], pending: ['b'] });
  assert.equal(CocosError.from({ code: 'NOT_A_PROTOCOL_CODE', message: 'native failure' }, 'EDITOR_ERROR').code, 'EDITOR_ERROR');
  assert.equal(CocosError.from(new Error('ordinary')).message, 'ordinary');
});
import { ProjectPaths } from '../packages/application/src/paths.js';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimePolicy } from '../packages/runtime3-bridge/src/access.js';
import { CatalogGenerator } from '../packages/catalog-generator/src/index.js';
import { Creator2Adapter } from '../packages/creator2-adapter/src/index.js';
import { Creator3Adapter } from '../packages/creator3-adapter/src/index.js';

const project = async (): Promise<ProjectPaths> => {
  const root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/test-project-'));
  await mkdir(join(root, 'assets'), { recursive: true }); await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  return ProjectPaths.open(root);
};

test('capability catalog contains all proposal modules and executable operations', () => {
  const catalog = new CapabilityCatalog();
  const coverage = catalog.coverage().rows;
  assert.equal(coverage.length, 54);
  assert.equal(catalog.search().total >= 70, true);
  assert.equal(catalog.describe('scene.open').versions.includes(2), true);
  assert.deepEqual(catalog.describe('runtime.invoke').platforms, ['development-runtime']);
  assert.equal(catalog.describe('ui.build').implementation, 'implemented');
  assert.equal(typeof catalog.coverage().rows[0]!.verification, 'object');
  assert.throws(() => catalog.validate('scene.open', {}), (error: unknown) => error instanceof CocosError && error.code === 'INVALID_ARGUMENT');
});

test('runtime policy blocks host escape paths and bounds invocation arguments', () => {
  const policy = new RuntimePolicy(2);
  assert.deepEqual(policy.path('node.position.x'), ['node', 'position', 'x']);
  assert.throws(() => policy.path('node.__proto__'), (error: unknown) => error instanceof CocosError && error.code === 'UNAUTHORIZED');
  assert.throws(() => policy.method('constructor'), (error: unknown) => error instanceof CocosError && error.code === 'UNAUTHORIZED');
  assert.throws(() => policy.method('destroy'), (error: unknown) => error instanceof CocosError && error.code === 'UNAUTHORIZED');
  assert.throws(() => policy.arguments([1, 2, 3]), (error: unknown) => error instanceof CocosError && error.code === 'INVALID_ARGUMENT');
});

test('workflow planning validates every step before execution', async () => {
  const root = await mkdtemp(join(process.cwd(), '.codex-work/tmp/workflow-project-'));
  const registry = new ProjectRegistry(); const registered = await registry.add(root);
  const application = new CocosApplication(registry);
  const plan = Json.object(application.plan(registered.projectId, [
    { capabilityId: 'scene.query', params: {} },
    { capabilityId: 'scene.open', params: {} },
  ]));
  assert.equal(plan.valid, false);
  assert.equal(Json.object((plan.rows as JsonValue[])[0]!).valid, true);
  assert.equal(Json.object((plan.rows as JsonValue[])[1]!).valid, false);
  const planned = Json.object(application.plan(registered.projectId, [{ capabilityId: 'ui.build', params: { tree: {} } }]))
    .rows as JsonValue[];
  assert.equal(Json.object(planned[0]!).valid, false);
  const external = Json.object(application.plan(registered.projectId, [{ capabilityId: 'scene.script', params: { extension: 'x', method: 'y' } }])).rows as JsonValue[];
  assert.equal(Json.object(external[0]!).valid, false);
});

test('engine source catalog classifies internal APIs and platform conditions', () => {
  const rows = new CatalogGenerator().parse('cocos/physics/framework/example.ts', `
    /** @internal */ export class InternalWorld { private secret = 1; public raycast(): void {} }
    export class PublicWorld { public step(): void {} }
    const nativeOnly = NATIVE && JSB;
  `);
  const internal = rows.find(row => row.name === 'InternalWorld');
  const publicRow = rows.find(row => row.name === 'PublicWorld');
  assert.equal(internal?.internal, true);
  assert.equal(internal?.public, false);
  assert.deepEqual(publicRow?.platforms, ['all']);
  assert.deepEqual(publicRow?.conditions, []);
});

test('adapter capability lists do not advertise handlers that are absent', () => {
  const creator2 = new Creator2Adapter({} as ConstructorParameters<typeof Creator2Adapter>[0]);
  const creator3 = new Creator3Adapter({} as ConstructorParameters<typeof Creator3Adapter>[0]);
  assert.equal(creator2.supportedCapabilities().includes('ui.build'), false);
  assert.equal(creator3.supportedCapabilities().includes('ui.build'), false);
  assert.equal(creator2.supportedCapabilities().includes('preview.start'), false);
  const ready2 = new Creator2Adapter({ version: '2.4.15', preview: async () => null, previewUrl: async () => 'http://127.0.0.1:7456/' } as unknown as ConstructorParameters<typeof Creator2Adapter>[0]);
  assert.equal(ready2.supportedCapabilities().includes('ui.build'), true);
  assert.equal(ready2.supportedCapabilities().includes('preview.start'), true);
  assert.equal(creator3.supportedCapabilities().includes('preview.start'), false);
});

test('JSON validation blocks prototype pollution paths and preserves canonical ordering', () => {
  assert.throws(() => Json.safePath('__proto__.x'), /Unsafe property path/);
  assert.equal(Json.canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.deepEqual(Json.object({ key: 'value' }), { key: 'value' });
  assert.deepEqual(Json.diff({ a: 1, nested: { x: true } }, { a: 2, nested: { x: true }, b: 'new' }), [
    { kind: 'changed', path: 'a', before: 1, after: 2 },
    { kind: 'added', path: 'b', after: 'new' },
  ]);
});

test('project path refuses traversal and symlink escape', async () => {
  const paths = await project();
  await assert.rejects(paths.resolve('../outside'), (error: unknown) => error instanceof CocosError && error.code === 'PATH_OUTSIDE_PROJECT');
  const outside = await mkdtemp(join(process.cwd(), '.codex-work/tmp/outside-'));
  await symlink(outside, join(paths.root, 'assets', 'escape'));
  await assert.rejects(paths.resolve('assets/escape/file.txt'), (error: unknown) => error instanceof CocosError && error.code === 'PATH_OUTSIDE_PROJECT');
  await assert.rejects(paths.asset('db://assets/../outside.txt'), (error: unknown) => error instanceof CocosError && error.code === 'PATH_OUTSIDE_PROJECT');
});
