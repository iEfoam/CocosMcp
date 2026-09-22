import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GithubUpdate } from '../packages/native-adapters/src/github-update.js';
import { ExtensionUpdate } from '../extensions/shared/extension-update.js';
import files from '../packages/native-adapters/src/extension-files.json' with { type: 'json' };

class UpdateFixture {
  async bundle(major: 2 | 3, full: boolean) {
    const root = `.codex-work/build/extensions/creator${major}`;
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const buildId = `v${manifest.version}`;
    const rows = await Promise.all([...files[major], ...(full ? files.presentation : [])].map(async path => ({
      path, content: (path === 'package.json' ? Buffer.from(JSON.stringify({ ...manifest, buildId })) : await readFile(join(root, path))).toString('base64'),
    })));
    return { major, version: manifest.version as string, buildId, rows };
  }
  release(bundle: {major: number; version: string; buildId: string}, data: Buffer, full: boolean) {
    return { version: bundle.version, buildId: bundle.buildId,
      url: `https://github.com/iEfoam/CocosMcp/releases/download/test/cocos-mcp-creator${bundle.major}${full ? '.full' : ''}.json`,
      digest: createHash('sha256').update(data).digest('hex') };
  }
  async create() {
    const project = await mkdtemp(resolve('.codex-work/tmp/update-test-'));
    const root = join(project, 'extensions/cocos-mcp-creator3');
    await mkdir(root, {recursive: true});
    await writeFile(join(project, '.gitignore'), '.codex-work/\n');
    await writeFile(join(root, 'package.json'), JSON.stringify({name: 'cocos-mcp-creator3', version: '0.0.0', buildId: 'old'}));
    await writeFile(join(root, 'service-config.json'), JSON.stringify({nodeExecutable: process.execPath, buildRoot: resolve('.codex-work/build')}));
    return {project, root};
  }
}

test('GitHub update validates release and installs while retaining running version', async () => {
  const {project, root} = await new UpdateFixture().create();
  const updater = new ExtensionUpdate(project, root, 3);
  const manifest = JSON.parse(await readFile('.codex-work/build/extensions/creator3/package.json', 'utf8'));
  const rows = [];
  for (const path of ['package.json','LICENSE','dist/main.cjs','dist/scene.cjs','dist/panel.cjs','dist/service.mjs','dist/update.mjs','dist/runtime.js']) rows.push({path, content: (await readFile(join('.codex-work/build/extensions/creator3',path))).toString('base64')});
  const data = Buffer.from(JSON.stringify({version: manifest.version, buildId: `v${manifest.version}`, major: 3, rows: rows.map(row => row.path === 'package.json' ? {path: row.path, content: Buffer.from(JSON.stringify({...manifest,buildId: `v${manifest.version}`})).toString('base64')} : row)}));
  const digest = createHash('sha256').update(data).digest('hex');
  const request: typeof fetch = async input => String(input).includes('api.github.com') ? new Response(JSON.stringify({tag_name: `v${manifest.version}`,assets:[{name:'cocos-mcp-creator3.json',browser_download_url:'https://github.com/iEfoam/CocosMcp/releases/download/test/cocos-mcp-creator3.json',digest:`sha256:${digest}`}]})) : new Response(data);
  const github = new GithubUpdate(request);
  await github.install(project, 3);
  assert.equal(updater.snapshot().version, '0.0.0');
  assert.equal(updater.snapshot().reloadRequired, true);
  assert.equal(new ExtensionUpdate(project, root, 3).snapshot().reloadRequired, false);
  await github.install(project, 3);
  assert.deepEqual(await readFile(join(root, 'dist/runtime.js')), await readFile('.codex-work/build/extensions/creator3/dist/runtime.js'));
  const release = await github.latest(3);
  const missingRuntime = JSON.parse(data.toString());
  missingRuntime.rows = missingRuntime.rows.filter((row: {path: string}) => row.path !== 'dist/runtime.js');
  const incomplete = Buffer.from(JSON.stringify(missingRuntime));
  assert.throws(() => github.validate(incomplete, {...release, digest:createHash('sha256').update(incomplete).digest('hex')}, 3), /结构不匹配/);
  assert.throws(() => github.validate(Buffer.from('tampered'), release, 3), /SHA-256/);
  const malicious = JSON.parse(data.toString()); malicious.rows[0].path = '../outside';
  const invalid = Buffer.from(JSON.stringify(malicious));
  assert.throws(() => github.validate(invalid, {...release, digest:createHash('sha256').update(invalid).digest('hex')}, 3), /非法/);
});

test('full update repairs same-version legacy installation and preserves bilingual presentation files', async () => {
  const fixture = new UpdateFixture(), { project, root } = await fixture.create();
  const legacy = await fixture.bundle(3, false), full = await fixture.bundle(3, true);
  const legacyData = Buffer.from(JSON.stringify(legacy)), fullData = Buffer.from(JSON.stringify(full));
  const legacyRelease = fixture.release(legacy, legacyData, false), fullRelease = fixture.release(full, fullData, true);
  let publishFull = false, downloads = 0;
  const request: typeof fetch = async input => {
    if (String(input).includes('api.github.com')) {
      const versions = publishFull ? [legacyRelease, fullRelease] : [legacyRelease];
      return new Response(JSON.stringify({ tag_name: full.buildId, assets: versions.map(row => ({
        name: row.url.split('/').pop(), browser_download_url: row.url, digest: `sha256:${row.digest}`,
      })) }));
    }
    downloads++;
    return new Response(String(input).endsWith('.full.json') ? fullData : legacyData);
  };
  const github = new GithubUpdate(request);
  await github.install(project, 3);
  await assert.rejects(readFile(join(root, 'README.en.md')), { code: 'ENOENT' });
  publishFull = true;
  assert.equal((await github.latest(3)).url, fullRelease.url);
  await github.install(project, 3);
  for (const path of files.presentation) {
    assert.deepEqual(await readFile(join(root, path)), await readFile(join('.codex-work/build/extensions/creator3', path)));
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.author, 'iefoam@foxmail.com');
  assert.match(manifest.buildTime, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  const english = await readFile(join(root, 'README.en.md'), 'utf8');
  assert.ok(english.includes(manifest.buildTime));
  assert.doesNotMatch(english, /\{\{/);
  await github.install(project, 3);
  assert.equal(downloads, 2, 'a complete same-version installation must not be downloaded again');
});

test('full update validates complete manifests for both Creator versions without weakening path guards', async () => {
  const fixture = new UpdateFixture(), github = new GithubUpdate();
  for (const major of [2, 3] as const) {
    const bundle = await fixture.bundle(major, true);
    const data = Buffer.from(JSON.stringify(bundle));
    assert.equal(github.validate(data, fixture.release(bundle, data, true), major).rows.length, files[major].length + files.presentation.length);
    const variants = [
      { ...bundle, rows: bundle.rows.filter(row => row.path !== 'README.zh.md') },
      { ...bundle, rows: bundle.rows.filter(row => files[major].includes(row.path)) },
      { ...bundle, rows: bundle.rows.map(row => row.path === 'logo.png' ? { ...row, path: '../logo.png' } : row) },
      { ...bundle, rows: bundle.rows.map(row => row.path === 'logo.png' ? { ...row, path: 'README.en.md' } : row) },
      { ...bundle, rows: bundle.rows.filter(row => files[major].includes(row.path)).map(row => row.path === 'dist/service.mjs' ? { ...row, path: 'README.en.md' } : row) },
    ];
    for (const invalid of variants) {
      const bytes = Buffer.from(JSON.stringify(invalid));
      assert.throws(() => github.validate(bytes, fixture.release(invalid, bytes, true), major), /结构不匹配|非法或重复/);
    }
  }
});

test('extension update reports missing configuration without changing installed version', async () => {
  const {project, root} = await new UpdateFixture().create();
  await writeFile(join(root, 'service-config.json'), '{}');
  const updater = new ExtensionUpdate(project, root, 3);
  await assert.rejects(updater.update(), /尚未配置/);
  assert.equal(updater.snapshot().updating, false);
  assert.equal(updater.snapshot().installedVersion, '0.0.0');
  assert.match(updater.snapshot().message!, /尚未配置/);
});

test('stable updater refuses prereleases and drafts even when returned by latest endpoint', async () => {
  for (const flags of [{ prerelease: true }, { draft: true }]) {
    const github = new GithubUpdate(async () => new Response(JSON.stringify({ tag_name: 'v0.1.0-dev.1', assets: [], ...flags })));
    await assert.rejects(github.latest(3), /refuses development or draft/);
  }
});
