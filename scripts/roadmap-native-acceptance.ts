import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { EvidenceStore } from '../packages/application/src/evidence-store.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';
import { CreatorAccount } from './creator-account.mjs';

/** 只运行于明确提供的隔离工程；场景与输入均为本任务合成夹具。 */
class RoadmapNativeAcceptance {
  private png(red: number, green: number): Buffer {
    const chunk = (name: string, bytes: Buffer): Buffer => {
      const body = Buffer.concat([Buffer.from(name), bytes]); let crc = 0xffffffff;
      for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
      const header = Buffer.alloc(4), tail = Buffer.alloc(4); header.writeUInt32BE(bytes.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
      return Buffer.concat([header, body, tail]);
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
    const row = Buffer.from([0, red, green, 32, 255, 32, green, red, 255]);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))]);
  }
  async run(project: string, major: 2 | 3): Promise<void> {
    const registry = new ProjectRegistry(), { projectId } = await registry.add(project), gateway = new RuntimeGateway(registry), gatewayPort = await gateway.start();
    const editor = await new CreatorAccount().existing(project);
    if (editor?.status !== 'existing-editor-reused' || editor.creatorMajor !== major) { await gateway.close(); throw new Error('Authenticated isolated editor identity required'); }
    const app = new CocosApplication(registry, undefined, undefined, false, gateway), evidence = new EvidenceStore();
    const id = `roadmap-${major}-${randomUUID()}`, directory = resolve('.codex-work/artifacts/mcp-roadmap-20261008', id);
    await mkdir(directory, { recursive: true });
    const rows: JsonObject[] = [], checks: JsonObject[] = [];
    let previous: string | undefined, previewOwned = false, fixtureId: string | undefined, failure: unknown, runtimeInstanceId: string | undefined;
    const record = async (): Promise<void> => writeFile(join(directory, 'report.json'), JSON.stringify({ project, major, checks, rows }, null, 2));
    const call = async (capabilityId: string, params: JsonObject = {}): Promise<JsonObject> => {
      try {
        const response = await app.execute({ projectId, instanceId: editor.instanceId, capabilityId, params, ...(runtimeInstanceId ? { runtimeInstanceId } : {}) });
        // 页面刷新后旧连接有有限的失联保留期；只能绑定本预览返回的新实例，不能选择工程里的任意 runtime。
        if (capabilityId === 'preview.runtime.connect') runtimeInstanceId = String(Json.object(response.result).runtimeInstanceId);
        const saved = await evidence.save(registry.paths(projectId), `${id}-${rows.length}`, response.result);
        rows.push({ capabilityId, passed: true, instanceId: response.instanceId ?? null, result: saved.result, evidenceRefs: saved.evidenceRefs });
        await record(); console.log(`PASS ${capabilityId}`); return Json.object(response.result);
      } catch (error) { rows.push({ capabilityId, passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); await record(); throw error; }
    };
    const check = async (name: string, action: () => Promise<void>): Promise<void> => {
      try { await action(); checks.push({ name, passed: true }); }
      catch (error) { failure ??= error; checks.push({ name, passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); }
      await record();
    };
    const createScene = async (name: string): Promise<{ sceneId: string; canvasId: string; url: string }> => {
      const url = String((await call('asset.location', { url: `db://assets/${name}.${major === 2 ? 'fire' : 'scene'}` })).url);
      await call('scene.create', { url });
      const sceneId = String(Json.object((await call('scene.query')).scene).sceneId);
      const canvasId = String((await call('node.create', { parentId: sceneId, name: 'Canvas' })).nodeId);
      await call('component.add', { nodeId: canvasId, type: 'cc.Canvas' });
      const components = ((await call('scene.hierarchy', { rootId: canvasId, includeComponents: true })).rows as JsonObject[])[0]!.components as JsonObject[];
      const canvasComponent = components.find(row => row.type === 'cc.Canvas')!.componentId!;
      if (major === 2) {
        await call('node.set', { nodeId: canvasId, properties: { width: 1280, height: 720 } });
        await call('component.set', { componentId: canvasComponent, properties: { designResolution: { width: 1280, height: 720 }, fitWidth: true, fitHeight: true } });
      } else {
        // Canvas 在 3.8.8 会自动附加 UITransform，再添加会被原生引擎拒绝。
        await call('node.set', { nodeId: canvasId, properties: { layer: 33554432 } });
        const cameraNode = (await call('node.create', { parentId: canvasId, name: 'Camera' })).nodeId!;
        await call('component.add', { nodeId: cameraNode, type: 'cc.Camera' });
        const camera = (((await call('scene.hierarchy', { rootId: cameraNode, includeComponents: true })).rows as JsonObject[])[0]!.components as JsonObject[]).find(row => row.type === 'cc.Camera')!.componentId!;
        await call('node.set', { nodeId: cameraNode, properties: { position: { x: 0, y: 0, z: 1000 } } });
        await call('component.set', { componentId: camera, properties: { projection: 0, orthoHeight: 360, visibility: 33554432, near: 1, far: 2000 } });
        await call('component.set', { componentId: canvasComponent, properties: { cameraComponent: { uuid: camera }, alignCanvasWithScreen: true } });
      }
      await call('scene.save'); return { sceneId, canvasId, url };
    };
    try {
      assert.ok(project.includes('CocosMcp-UI-Test-3.8.8') || project.endsWith('/.codex-work/build/creator2-test-project'), 'Only the designated isolated projects may run this harness');
      const status = await call('editor.status'); assert.equal(status.creatorMajor, major);
      const initial = await call('scene.query'); assert.equal(initial.dirty, false, 'Preserve any pre-existing dirty scene'); previous = String(Json.object(initial.scene).sceneId);
      const preview = await call('preview.status');
      // 允许收尾本轮已知的 3.x 合成截图窗口，其他预览不能被接管。
      if (preview.running) {
        assert.equal(preview.previewSessionId, '8aa7eaf98ab8b1db9521e4c957f5b913'); await call('preview.stop');
      }
      const suffix = randomUUID().replaceAll('-', '').slice(0, 8), a = await createScene(`RoadmapA_${suffix}`), b = await createScene(`RoadmapB_${suffix}`);
      await call('scene.open', { uuid: a.sceneId });
      const imageUrl = String((await call('asset.location', { url: `db://assets/RoadmapImage_${suffix}.png` })).url);
      const inputDirectory = join(project, '.codex-work/tmp', id); await mkdir(inputDirectory, { recursive: true });
      const imageSource = join(inputDirectory, imageUrl.split('/').at(-1)!); await writeFile(imageSource, this.png(200, 32));
      await call('asset.import', { sourcePath: imageSource, targetUrl: imageUrl });
      const imageInfo = Json.object((await call('asset.info', { url: imageUrl })).asset), imageMeta = await call('asset.meta', { url: imageUrl }), imageUuids = new Set<string>([String(imageInfo.uuid)]);
      const collect = (value: unknown): void => { if (!value || typeof value !== 'object') return; for (const [key, field] of Object.entries(value)) {
        if (key === 'uuid' && typeof field === 'string' && /^[a-f0-9-]{32,36}(?:@[a-zA-Z0-9_-]+)?$/.test(field)) imageUuids.add(field); else if (typeof field === 'object') collect(field);
      } };
      collect(imageInfo.subAssets); collect(imageMeta.meta); assert.ok(imageUuids.size <= 100);
      const prefabUrl = String((await call('asset.location', { url: `db://assets/RoadmapPrefab_${suffix}.prefab` })).url);
      const prefabSource = String((await call('node.create', { parentId: a.canvasId, name: 'PrefabSource' })).nodeId);
      await call('node.create', { parentId: prefabSource, name: 'ReturnProbe' });
      const prefab = await call('prefab.create', { nodeId: prefabSource, url: prefabUrl }), prefabInfo = Json.object((await call('asset.info', { url: prefabUrl })).asset), prefabUuid = String(prefabInfo.uuid);
      await call('node.delete', { nodeId: major === 3 ? prefab.rootId! : prefabSource });
      const prefabEditing = String((await call('prefab.instantiate', { uuid: prefabUuid, parentId: a.canvasId, name: 'PrefabEditing' })).nodeId);
      const loads = `for(const uuid of ${JSON.stringify([...imageUuids, prefabUuid])}) ${major === 2 ? 'cc.' : ''}assetManager.loadAny({uuid},(e,asset)=>{if(!e&&uuid===${JSON.stringify(prefabUuid)}){const child=${major === 2 ? 'cc.' : ''}instantiate(asset);child.name='LoadedPrefab';this.node.addChild(child);}});`;
      const className = `RoadmapButton${suffix}`, script = String((await call('asset.location', { url: `db://assets/${className}.${major === 2 ? 'js' : 'ts'}` })).url);
      const source = (text: string): string => major === 2
        ? `cc.Class({name:'${className}',extends:cc.Component,onLoad(){const n=this.node.getChildByName('RoadmapFixture').getChildByName('Action');n.getComponent(cc.Label).string='${text}';n.on('touchend',()=>{n.getComponent(cc.Label).string='Clicked';},this);${loads}}});`
        : `import {_decorator,Component,Label,Node,assetManager,instantiate} from 'cc';const {ccclass}=_decorator;@ccclass('${className}') export class ${className} extends Component {onLoad(){const n=this.node.getChildByName('RoadmapFixture')!.getChildByName('Action')!;n.getComponent(Label)!.string='${text}';n.on(Node.EventType.TOUCH_END,()=>{n.getComponent(Label)!.string='Clicked';},this);${loads}}}`;
      await call('asset.create', { url: script, content: source('Before') });
      let registration: JsonObject | undefined;
      for (let i = 0; i < 40; i++) {
        registration = ((await call('component.types')).rows as JsonObject[]).find(row => row.name === className);
        if (registration) break; await delay(250);
      }
      assert.ok(registration, 'Native script component must finish registration');
      await call('component.add', { nodeId: a.canvasId, type: major === 3 ? registration.cid! : className });
      const document = { version: 1, root: { key: 'fixture', name: 'RoadmapFixture', children: [{ key: 'action', name: 'Action', components: [
        { type: 'cc.UITransform', properties: { contentSize: { width: 260, height: 90 } } }, { type: 'cc.Label', properties: { string: 'Before', fontSize: 36, overflow: 1 } },
        { type: 'cc.Button', properties: { interactable: true } },
      ] }] } };
      const params: JsonObject = { label: 'Roadmap synthetic input fixture', parentId: a.canvasId, document, ttlMs: 3600000 };
      const plan = await call('fixture.plan', params), fixture = await call('fixture.create', { ...params, planHash: plan.planHash! }); fixtureId = String(fixture.fixtureId);
      await call('scene.save');
      await call('preview.start', { preset: 'landscape-1280', visible: true, fixtureId }); previewOwned = true;
      await call('preview.runtime.connect', { gatewayPort });
      await check('CP-007 layered readiness and synthetic UI', async () => {
        const ready = await call('preview.wait', { sceneId: a.sceneId, uiChecks: [{ selector: { name: 'Action' }, text: 'Before', active: true }], timeoutMs: 10000 }); assert.equal(ready.gameReady, true);
      });
      await check('CP-003 compositor image and strict scene expectation', async () => {
        const image = await call('preview.capture'); assert.ok(Number(Json.object(image.image).byteLength) > 0);
        await assert.rejects(call('preview.capture', { expectedSceneId: b.sceneId }), error => CocosError.from(error).code === 'VERIFICATION_FAILED');
      });
      await check('CP-004 explicit pause and last-frame evidence without implicit resume', async () => {
        await call('runtime.pause');
        assert.equal(Json.object((await call('preview.status')).observation).gamePaused, true);
        assert.equal((await call('preview.capture', { frameMode: 'lastFrame' })).stale, true);
        await assert.rejects(call('preview.input', { action: 'click', x: 10, y: 10 }), error => CocosError.from(error).details?.inputSent === false);
        assert.equal(Json.object((await call('preview.status')).observation).gamePaused, true);
        await call('runtime.resume'); await call('preview.capture');
      });
      await check('CP-005 four landscape presets and view restoration', async () => {
        assert.equal(((await call('preview.presets')).rows as JsonObject[]).length, 4);
        for (const preset of ['landscape-568', 'landscape-844', 'landscape-1280', 'landscape-1920']) {
          await call('preview.resize', { preset }); assert.equal((await call('runtime.ui.check', { rows: [{ selector: { name: 'Action' }, visible: true, clipped: false }] })).passed, true);
        }
        const view = await call('runtime.view.inspect'), configured = await call('runtime.view.configure', { width: 844, height: 390, expectedHash: view.viewHash!, policy: 'SHOW_ALL' });
        assert.equal((await call('runtime.view.restore', { restoreId: configured.restoreId! })).restored, true);
        await call('preview.resize', { preset: 'landscape-1280' });
      });
      await check('CP-010 unique semantic target and real native input', async () => {
        assert.equal((await call('runtime.ui.select', { selector: { name: 'Action' } })).uniqueInputCandidate, true);
        const clicked = await call('runtime.ui.click', { selector: { name: 'Action' }, after: [{ selector: { name: 'Action' }, text: 'Clicked' }], timeoutMs: 5000 }); assert.equal(clicked.inputSent, true);
      });
      await check('CP-006 ordinary script loaded-byte refresh', async () => {
        await call('asset.save', { url: script, content: source('Refreshed') });
        let refreshed = await call('preview.refresh', { urls: [script], timeoutMs: 20000 });
        for (let i = 0; refreshed.nativePending && i < 250; i++) { await delay(100); refreshed = await call('preview.refresh.status', { operationId: refreshed.operationId! }); }
        await call('preview.runtime.connect', { gatewayPort }); assert.equal(refreshed.status, 'completed');
        assert.equal((await call('runtime.ui.check', { rows: [{ selector: { name: 'Action' }, text: 'Refreshed' }] })).passed, true);
      });
      await check('CP-006 image replacement with preserved UUID and native loaded bytes', async () => {
        const path = await registry.paths(projectId).asset(imageUrl); await writeFile(path, this.png(32, 200));
        let state = await call('preview.refresh', { urls: [imageUrl], timeoutMs: 20000 });
        for (let i = 0; state.nativePending && i < 250; i++) { await delay(100); state = await call('preview.refresh.status', { operationId: state.operationId! }); }
        await call('preview.runtime.connect', { gatewayPort }); assert.equal(state.status, 'completed');
        assert.equal(Json.object((await call('asset.info', { url: imageUrl })).asset).uuid, imageInfo.uuid);
      });
      await check('CP-006/012 native Prefab removal, UUID preservation and loaded hierarchy', async () => {
        await call('preview.wait', { uiChecks: [{ selector: { path: 'Canvas/LoadedPrefab/ReturnProbe' }, exists: true }], timeoutMs: 5000 });
        await call('preview.stop'); previewOwned = false;
        assert.equal((await call('fixture.cleanup', { fixtureId: fixtureId! })).status, 'cleaned');
        if (major === 3) { await call('scene.save'); await call('prefab.open', { uuid: prefabUuid }); }
        const children = (await call('scene.hierarchy', { ...(major === 2 ? { rootId: prefabEditing } : {}), includeComponents: false })).rows as JsonObject[];
        const target = children.find(row => row.name === 'ReturnProbe'); assert.ok(target); await call('node.delete', { nodeId: target.nodeId! });
        if (major === 3) { await call('scene.save'); await call('scene.open', { uuid: a.sceneId }); }
        else await call('prefab.apply', { nodeId: prefabEditing });
        await call('node.create', { parentId: a.canvasId, name: 'SceneRevisionProbe' });
        // 2.x 的保守所有权快照包含父图；先清理旧夹具，再在新的已确认场景上创建，不能绕过旧指纹。
        const plan = await call('fixture.plan', params); fixtureId = String((await call('fixture.create', { ...params, planHash: plan.planHash! })).fixtureId);
        await call('scene.save'); await call('preview.start', { preset: 'landscape-1280', visible: true, fixtureId }); previewOwned = true;
        await call('preview.runtime.connect', { gatewayPort });
        let state = await call('preview.refresh', { urls: [prefabUrl], timeoutMs: 20000 });
        for (let i = 0; state.nativePending && i < 250; i++) { await delay(100); state = await call('preview.refresh.status', { operationId: state.operationId! }); }
        await call('preview.runtime.connect', { gatewayPort }); assert.equal(state.status, 'completed');
        assert.equal(Json.object((await call('asset.info', { url: prefabUrl })).asset).uuid, prefabUuid);
        await call('preview.wait', { uiChecks: [{ selector: { name: 'LoadedPrefab' }, count: 1 }, { selector: { name: 'ReturnProbe' }, exists: false }], timeoutMs: 5000 });
      });
      await check('CP-006 scene hierarchy refresh and explicit artifact coverage', async () => {
        let state = await call('preview.refresh', { urls: [a.url], timeoutMs: 20000 });
        for (let i = 0; state.nativePending && i < 250; i++) { await delay(100); state = await call('preview.refresh.status', { operationId: state.operationId! }); }
        await call('preview.runtime.connect', { gatewayPort });
        assert.ok(['completed', 'unknown'].includes(String(state.status)), 'Scene refresh must match bytes or explicitly report an unsupported proof');
        await call('preview.wait', { sceneId: a.sceneId, uiChecks: [{ selector: { name: 'SceneRevisionProbe' }, count: 1 }], timeoutMs: 5000 });
      });
      await check('CP-002 public scene switching and current-scene capture', async () => {
        const before = await call('preview.status'); await call('runtime.scene.load', { sceneUuid: b.sceneId });
        await call('preview.wait', { sceneId: b.sceneId, timeoutMs: 10000 }); const image = await call('preview.capture'); assert.equal(image.currentSceneId, b.sceneId);
        assert.ok(Number((await call('preview.status')).sceneGeneration) > Number(before.sceneGeneration));
        await call('runtime.scene.load', { sceneUuid: a.sceneId }); await call('preview.wait', { sceneId: a.sceneId, timeoutMs: 10000 });
      });
      await check('CP-013 bounded lifecycle and latency regression', async () => {
        const result = await call('preview.regression', { cycles: 3, rows: [{ capabilityId: 'preview.resize', params: { preset: 'landscape-844' } }, { capabilityId: 'preview.resize', params: { preset: 'landscape-1280' } }] }); assert.equal(result.passed, true);
      });
      await check('CP-008 exact-role diagnostics and CP-009 UTC audit', async () => {
        await call('preview.diagnose', { connectionRoles: [] }); const audit = await call('operation.audit.query', { limit: 100 }); assert.ok((audit.rows as unknown[]).length > 0);
      });
      await call('preview.stop'); previewOwned = false;
      await check('CP-004 hidden preview acquires focus before guarded input', async () => {
        await call('preview.start', { preset: 'landscape-568', visible: false, fixtureId: fixtureId! }); previewOwned = true;
        try { assert.equal((await call('preview.input', { action: 'key', key: 'A', x: 10, y: 10 })).inputSent, true); }
        catch (error) { assert.equal(CocosError.from(error).details?.inputSent, false); }
        await call('preview.runtime.connect', { gatewayPort });
        await call('preview.wait', { sceneId: a.sceneId, timeoutMs: 10000 });
        assert.equal((await call('runtime.ui.click', { selector: { name: 'Action' }, after: [{ selector: { name: 'Action' }, text: 'Clicked' }], timeoutMs: 5000 })).inputSent, true);
        await call('preview.stop'); previewOwned = false;
      });
      await check('CP-011 recipe evidence and CP-012 guarded fixture cleanup', async () => {
        const params: JsonObject = { mode: 'fixture', fixtureId: fixtureId!, steps: [{ capabilityId: 'preview.start', params: { preset: 'landscape-568', visible: true, fixtureId: fixtureId! } }, { capabilityId: 'preview.wait', params: { timeoutMs: 10000 } }, { capabilityId: 'preview.capture', params: {} }] };
        const plan = await call('acceptance.plan', params), run = await call('acceptance.run', { ...params, planHash: plan.planHash! });
        let state: JsonObject = {};
        for (let i = 0; i < 300; i++) { state = await call('acceptance.status', { runId: run.runId! }); if (state.status !== 'running') break; await delay(100); }
        assert.equal(state.status, 'succeeded'); assert.equal(state.realBusinessOutcomeVerified, false); assert.equal((await call('fixture.status', { fixtureId: fixtureId! })).status, 'cleaned');
      });
    } catch (error) { failure ??= error; rows.push({ fatal: CocosError.from(error).toJSON() as unknown as JsonObject }); }
    finally {
      if (previewOwned) { try { await call('preview.stop'); } catch (error) { failure ??= error; } }
      if (fixtureId) { try { const fixture = await call('fixture.status', { fixtureId }); if (fixture.status === 'active') await call('fixture.cleanup', { fixtureId }); } catch (error) { failure ??= error; } }
      if (previous) { try { await call('scene.save'); await call('scene.open', { uuid: previous }); } catch (error) { failure ??= error; } }
      await gateway.close();
      await writeFile(join(directory, 'summary.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', project, major, checks, sourceFingerprint: process.env.COCOS_NATIVE_SOURCE_FINGERPRINT ?? null,
        installed: JSON.parse(await readFile(join(project, major === 2 ? 'packages' : 'extensions', `cocos-mcp-creator${major}/package.json`), 'utf8')).buildId,
        limitations: ['Synthetic local desktop acceptance; external browser, physical devices and real business are separate scopes.'] }, null, 2));
      console.log(JSON.stringify({ directory, status: failure ? 'failed' : 'passed' })); if (failure) process.exitCode = 1;
    }
  }
}
const [project, major] = process.argv.slice(2); if (!project || !['2', '3'].includes(major ?? '')) throw new Error('Usage: roadmap-native-acceptance <isolated-project> <2|3>');
await new RoadmapNativeAcceptance().run(resolve(project), Number(major) as 2 | 3);
