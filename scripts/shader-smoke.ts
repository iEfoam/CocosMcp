import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CocosApplication, ProjectRegistry, ProjectPaths } from '../packages/application/src/index.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';

/** 在用户指定的测试工程创建独立样例；保留资源和报告供编辑器内复查。 */
class ShaderSmoke {
  private readonly rows: JsonObject[] = [];
  async run(projectRoot: string): Promise<void> {
    const registry = new ProjectRegistry(); await registry.add(projectRoot);
    const projectId = registry.list().rows[0]!.projectId;
    const application = new CocosApplication(registry);
    const paths = await ProjectPaths.open(projectRoot);
    const log = join(await paths.work('logs', 'shader'), `smoke-${randomBytes(6).toString('hex')}.json`);
    const prefix = `MCP_Shader_Check_${randomBytes(4).toString('hex')}`;
    const call = async (capabilityId: string, params: JsonObject): Promise<JsonObject> => {
      const response = await application.execute({ projectId, capabilityId, params });
      const result = Json.object(response.result); this.rows.push({ capabilityId, result }); return result;
    };
    try {
      await call('shader.environment', {});
      for (const sample of ['unlit-gradient', 'sprite-dissolve']) {
        const url = Json.string((await call('asset.location', { url: `db://assets/${prefix}_${sample}.effect` })).url, 'shader URL');
        const content = await readFile(join(process.cwd(), 'examples/shaders', `${sample}.effect`), 'utf8');
        const created = await call('shader.create', { url, content });
        const compilation = await call('shader.compile', { url }); assert.equal(compilation.status, 'passed', JSON.stringify(compilation.rows));
        const materialUrl = Json.string((await call('asset.location', { url: `db://assets/${prefix}_${sample}.mtl` })).url, 'material URL');
        const material = await call('material.create', { url: materialUrl, effectUrl: url });
        const properties = sample === 'unlit-gradient' ? { tint: { type: 'color', value: [30, 190, 255, 255] } } : { threshold: 0.65 };
        const updated = await call('material.update', { url: materialUrl, expectedHash: material.sourceHash!, properties });
        await call('material.properties', { url: materialUrl });
        await assert.rejects(call('material.update', { url: materialUrl, expectedHash: material.sourceHash!, properties }), /changed/);
        this.rows.push({ check: 'stale-material-hash', passed: true, url: materialUrl, sourceHash: updated.sourceHash! });
        const invalid = await call('shader.update', { url, expectedHash: created.sourceHash!, content: content.replace('return vec4(', 'return unknownFunction(').replace('return CCSampleWithAlphaSeparated(', 'return unknownFunction(') });
        const broken = await call('shader.compile', { url }); assert.equal(broken.status, 'failed');
        await call('shader.restore', { backupId: invalid.backupId!, expectedHash: invalid.sourceHash! });
        const restored = await call('shader.compile', { url }); assert.equal(restored.status, 'passed');
      }
      await writeFile(log, JSON.stringify({ status: 'passed', prefix, rows: this.rows }, null, 2));
      console.log(JSON.stringify({ status: 'passed', prefix, log, operations: this.rows.length }));
    } catch (error) {
      await writeFile(log, JSON.stringify({ status: 'failed', prefix, error: CocosError.from(error).toJSON(), rows: this.rows }, null, 2));
      console.error(JSON.stringify({ status: 'failed', log, error: CocosError.from(error).toJSON() })); process.exitCode = 1;
    }
  }
}

const project = process.argv[2];
if (!project) throw new Error('Pass the absolute path of a disposable Creator 3.8.8 test project');
await new ShaderSmoke().run(project);
