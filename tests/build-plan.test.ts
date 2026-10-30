import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildPlan } from '../scripts/build-plan.mjs';

test('release remains the full default and native profiles select one compatible installation chain', () => {
  const release = new BuildPlan();
  assert.equal(release.profile, 'release'); assert.deepEqual(release.majors, [2, 3]);
  assert.deepEqual(release.targets, ['server', 'client', 'runtime', 'smoke']);
  for (const major of ['2', '3']) {
    const native = new BuildPlan(['--profile', 'native', '--major', major]);
    assert.deepEqual(native.majors, [Number(major)]); assert.equal(native.output, '.codex-work/build');
    assert.ok(native.includes('server') && native.includes('client') && native.includes('runtime'));
  }
});

test('development targets are isolated and invalid combinations fail before writing build output', () => {
  const dev = new BuildPlan(['--profile', 'dev', '--targets', 'server,runtime']);
  assert.equal(dev.output, '.codex-work/build/profiles/dev'); assert.deepEqual(dev.majors, []);
  assert.ok(!dev.includes('client'));
  for (const args of [ ['--profile', 'native'], ['--profile', 'native', '--major', '4'], ['--profile', 'release', '--targets', 'server'],
    ['--profile', 'dev', '--targets', '../server'], ['--profile', 'dev', '--targets', 'server,server'], ['--profile', 'dev', '--major', '3'], ['--unknown', 'value'], ['--profile', 'dev', '--profile', 'release'] ]) {
    assert.throws(() => new BuildPlan(args));
  }
});

test('release admission rejects partial, failed and stale builds even when old outputs remain', () => {
  const valid = { profile: 'release', state: 'completed', sourceFingerprint: 'current', majors: [2, 3], targets: ['server', 'client', 'runtime', 'smoke'] };
  BuildPlan.assertRelease(valid, 'current');
  for (const change of [{ profile: 'native' }, { profile: 'dev' }, { state: 'building' }, { state: 'failed' }, { majors: [3] }, { targets: ['server'] }, { sourceFingerprint: 'old' }]) {
    assert.throws(() => BuildPlan.assertRelease({ ...valid, ...change }, 'current'), /full release build/);
  }
  assert.throws(() => BuildPlan.assertRelease(null, 'current'), /full release build/);
});
