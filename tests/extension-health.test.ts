import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ExtensionHealth } from '../packages/native-adapters/src/extension-health.js';
import { ExtensionInstaller } from '../packages/native-adapters/src/installer.js';
import { GithubUpdate } from '../packages/native-adapters/src/github-update.js';
import { ExtensionUpdate } from '../extensions/shared/extension-update.js';
import files from '../packages/native-adapters/src/extension-files.json' with { type: 'json' };

class HealthFixture {
  async project(): Promise<string> { return mkdtemp(resolve('.codex-work/tmp/extension-health-')); }
  async source(root: string, major: 2 | 3): Promise<string> {
    const source = join(root, `extensions/creator${major}`);
    await cp(resolve(`.codex-work/build/extensions/creator${major}`), source, { recursive: true }); return source;
  }
  async release(major: 2 | 3) {
    const source = resolve(`.codex-work/build/extensions/creator${major}`), manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const buildId = `v${manifest.version}`;
    const rows = await Promise.all([...files[major], ...files.presentation].map(async path => ({ path, content: (path === 'package.json' ? Buffer.from(JSON.stringify({ ...manifest, buildId })) : await readFile(join(source, path))).toString('base64') })));
    const bytes = Buffer.from(JSON.stringify({ major, version: manifest.version, buildId, rows }));
    let downloads = 0;
    const updater = new GithubUpdate(async input => {
      if (String(input).includes('api.github.com')) return new Response(JSON.stringify({ tag_name: buildId, assets: [{ name: `cocos-mcp-creator${major}.full.json`, browser_download_url: `https://github.com/iEfoam/CocosMcp/releases/download/test/cocos-mcp-creator${major}.full.json`, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }] }));
      downloads++; return new Response(bytes);
    });
    return { updater, downloads: () => downloads };
  }
}

test('both Creator bundles include runtime; local installation rejects corruption before replacing the old extension', async () => {
  for (const major of [2, 3] as const) {
    assert.ok(files[major].includes('dist/runtime.js'));
    const fixture = new HealthFixture(), project = await fixture.project(), build = await fixture.project(), source = await fixture.source(build, major);
    const target = join(project, `${major === 2 ? 'packages' : 'extensions'}/cocos-mcp-creator${major}`);
    await mkdir(target, { recursive: true }); await writeFile(join(target, 'package.json'), JSON.stringify({ name: `cocos-mcp-creator${major}`, version: 'old' }));
    await unlink(join(source, 'dist/runtime.js'));
    await assert.rejects(new ExtensionInstaller().install(project, major, build), { code: 'VERIFICATION_FAILED' });
    assert.equal(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).version, 'old');
    await writeFile(join(source, 'dist/runtime.js'), 'mixed build');
    assert.equal(new ExtensionHealth().inspect(source, major).rows.find(row => row.path === 'dist/runtime.js')!.reason, 'digest-mismatch');
    await assert.rejects(new ExtensionInstaller().install(project, major, build), { code: 'VERIFICATION_FAILED' });
  }
});

test('same-version missing and mixed runtime files trigger whole-package repair on both versions', async () => {
  for (const major of [2, 3] as const) {
    const fixture = new HealthFixture(), project = await fixture.project(), source = await fixture.source(project, major);
    const target = join(project, `${major === 2 ? 'packages' : 'extensions'}/cocos-mcp-creator${major}`);
    await mkdir(join(project, major === 2 ? 'packages' : 'extensions'), { recursive: true }); await rename(source, target);
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')); manifest.buildId = `v${manifest.version}`; await writeFile(join(target, 'package.json'), JSON.stringify(manifest));
    const release = await fixture.release(major); await release.updater.install(project, major); assert.equal(release.downloads(), 0);
    await unlink(join(target, 'dist/runtime.js')); await release.updater.install(project, major); assert.equal(release.downloads(), 1);
    assert.equal(new ExtensionHealth().inspect(target, major, true).health, 'healthy');
    await writeFile(join(target, 'dist/runtime.js'), 'mixed runtime'); await release.updater.install(project, major); assert.equal(release.downloads(), 2);
    assert.equal(new ExtensionHealth().inspect(target, major, true).health, 'healthy');
  }
});

test('legacy Creator 2 seven-file package uses controlled whole installation with a recoverable backup', async () => {
  const fixture = new HealthFixture(), project = await fixture.project(), source = await fixture.project(); await fixture.source(source, 2);
  const target = join(project, 'packages/cocos-mcp-creator2'); await mkdir(target, { recursive: true });
  await writeFile(join(target, 'package.json'), JSON.stringify({ name: 'cocos-mcp-creator2', version: 'legacy' }));
  await writeFile(join(target, 'legacy-marker'), 'retain');
  const installed = await new ExtensionInstaller().install(project, 2, source);
  assert.equal(new ExtensionHealth().inspect(installed.installedPath, 2, true).health, 'healthy');
  assert.equal(await readFile(join(installed.backupPath!, 'legacy-marker'), 'utf8'), 'retain');
  await rename(target, join(project, '.codex-work/tmp/candidate')); await rename(installed.backupPath!, target);
  assert.equal(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).version, 'legacy');
});

test('required-file symlinks and empty files are rejected, legacy digest absence remains unknown', async () => {
  const fixture = new HealthFixture(), root = await fixture.project(), source = await fixture.source(root, 2);
  const runtime = join(source, 'dist/runtime.js'); await unlink(runtime); await symlink(resolve('.codex-work/build/extensions/creator2/dist/runtime.js'), runtime);
  assert.equal(new ExtensionHealth().inspect(source, 2).health, 'degraded');
  await unlink(runtime); await writeFile(runtime, ''); assert.equal(new ExtensionHealth().inspect(source, 2).health, 'degraded');
  await writeFile(runtime, await readFile('.codex-work/build/extensions/creator2/dist/runtime.js'));
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')); delete manifest.fileHashes; await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
  assert.equal(new ExtensionHealth().inspect(source, 2).health, 'unknown');
});

test('same-build disk repair requires a reload and missing installed manifest remains diagnosable', async () => {
  const fixture = new HealthFixture(), root = await fixture.project(), source = await fixture.source(root, 2);
  const updater = new ExtensionUpdate(root, source, 2); assert.equal(updater.snapshot().integrity.health, 'healthy');
  await writeFile(join(source, 'dist/runtime.js'), 'broken');
  assert.equal(updater.snapshot().reloadRequired, true); assert.equal(updater.snapshot().integrity.health, 'degraded');
  await unlink(join(source, 'package.json')); assert.equal(updater.snapshot().integrity.health, 'degraded'); assert.equal(updater.snapshot().installedVersion, '');
});
