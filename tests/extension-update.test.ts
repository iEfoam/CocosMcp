import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

test('extension update installs with backup while keeping running version until reload', async () => {
  const {project, root} = await new UpdateFixture().create();
  const updater = new ExtensionUpdate(project, root, 3);
  const first = updater.update();
  assert.equal(updater.update(), first);
  await first;
  const installed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(updater.snapshot().version, '0.0.0');
  assert.equal(updater.snapshot().installedBuildId, installed.buildId);
  assert.equal(updater.snapshot().reloadRequired, true);
  await updater.update();
  assert.match(updater.snapshot().message!, /重载/);
  const reloaded = new ExtensionUpdate(project, root, 3);
  assert.equal(reloaded.snapshot().reloadRequired, false);
  await reloaded.update();
  assert.match(reloaded.snapshot().message!, /最新版本/);
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
