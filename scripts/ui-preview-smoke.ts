import assert from 'node:assert/strict';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { Json, CocosError, type JsonObject } from '../packages/contracts/src/index.js';

// 仅验收已打开的专用测试预览；不启动编辑器、不切换或保存场景。
class UiPreviewSmoke {
  async run(project: string, fixturePath: string): Promise<void> {
    const repo = await realpath(process.cwd()), target = await realpath(project), path = relative(repo, target);
    assert.ok(path && path !== '..' && !path.startsWith('../'), 'Test project must be a child of the MCP repository');
    const fixture = Json.object(JSON.parse(await readFile(fixturePath, 'utf8')));
    const sceneId = Json.string(fixture.sceneId, 'sceneId');
    assert.ok(Array.isArray(fixture.viewports) && fixture.viewports.length > 0 && fixture.viewports.length <= 8);
    const registry = new ProjectRegistry(); await registry.add(target);
    const projectId = registry.list().rows[0]!.projectId, app = new CocosApplication(registry);
    const call = async (capabilityId: string, params: JsonObject = {}): Promise<JsonObject> => Json.object((await app.execute({ projectId, capabilityId, params })).result);
    const initial = await call('preview.status');
    assert.equal(initial.running, true, 'Open the dedicated MCP test preview first');
    assert.equal(initial.sceneId, sceneId, 'Wrong preview scene');
    assert.ok(Array.isArray(initial.viewport) && initial.viewport.length === 2);
    const output = join(repo, '.codex-work/logs/ui-preview', randomUUID()); await mkdir(output, { recursive: true });
    const rows: JsonObject[] = []; let failure: unknown;
    try {
      for (const value of fixture.viewports) {
        const viewport = Json.object(value), params = { width: viewport.width!, height: viewport.height! };
        const resized = await call('preview.resize', params);
        assert.deepEqual(resized.viewport, params);
        const captures = [resized];
        // 输入只执行一次；调用失败可能已触发业务，禁止自动重试。
        if (viewport.input) captures.push(await call('preview.input', Json.object(viewport.input)));
        for (const capture of captures) {
          const data = Json.string(capture.dataUrl, 'capture dataUrl');
          assert.ok(data.startsWith('data:image/png;base64,'));
          const imagePath = join(output, `${rows.length}.png`);
          await writeFile(imagePath, Buffer.from(data.split(',')[1]!, 'base64'));
          delete capture.dataUrl; rows.push({ ...capture, imagePath });
        }
      }
    } catch (error) { failure = error; }
    finally {
      // 只恢复窗口尺寸；如果用户已切换场景，保留其当前窗口。
      try {
        const current = await call('preview.status');
        if (current.running && current.sceneId === sceneId) await call('preview.resize', { width: initial.viewport[0]!, height: initial.viewport[1]! });
        else throw new Error('Preview changed; original size was not restored');
      } catch (error) { rows.push({ restoreError: CocosError.from(error).message }); failure ??= error; }
      await writeFile(join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'capture-passed', sceneId, businessOutcomeVerified: false, persistenceVerified: false, rows, ...(failure ? { error: CocosError.from(failure).toJSON() } : {}) }, null, 2));
    }
    console.log(output); if (failure) throw failure;
  }
}
const [project, fixture] = process.argv.slice(2);
if (!project || !fixture) throw new Error('Usage: ui-preview-smoke <repository child test project> <fixture.json>');
await new UiPreviewSmoke().run(resolve(project), resolve(fixture));
