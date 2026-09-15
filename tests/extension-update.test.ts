import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GithubUpdate } from '../packages/native-adapters/src/github-update.js';
import { ExtensionUpdate } from '../extensions/shared/extension-update.js';

class UpdateFixture {
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

test('extension update reports missing configuration without changing installed version', async () => {
  const {project, root} = await new UpdateFixture().create();
  await writeFile(join(root, 'service-config.json'), '{}');
  const updater = new ExtensionUpdate(project, root, 3);
  await assert.rejects(updater.update(), /尚未配置/);
  assert.equal(updater.snapshot().updating, false);
  assert.equal(updater.snapshot().installedVersion, '0.0.0');
  assert.match(updater.snapshot().message!, /尚未配置/);
});
