import type { JsonObject } from '../../contracts/src/index.js';
import { CapabilityCatalog } from './index.js';
import { OutputContracts } from './output-contracts.js';

/** 文档与适配器契约测试共用示例；占位身份不能用于真实工程执行。 */
export class ContractExamples {
  rows(): Array<{ id: string; variant: string; input: JsonObject; output: JsonObject }> {
    const hash = 'a'.repeat(64), mapping = [{ key: 'panel', nodeId: 'example-panel' }];
    const document = { version: 1, root: { key: 'panel', name: 'Panel', components: [{ type: 'cc.UITransform', properties: { contentSize: { width: 400, height: 300 } } }] } };
    const create = { parentId: 'example-canvas', document }, update = { rootId: 'example-panel', document, mapping };
    const prefabChange = { nodeId: 'example-panel', assetUuid: 'example-asset', url: 'db://assets/Prefabs/Panel.prefab',
      sourceHash: hash, sourceGraphHash: hash, instanceHash: hash, expectedHash: hash, planHash: hash, sceneSavedByTool: false };
    const preserved = [{ key: '["node","root-file-id"]', kind: 'node', status: 'property-override', change: { kind: 'changed', path: 'properties/_name', before: 'Panel', after: 'MyPanel' } }];
    const rows = [
      { id: 'scene.query', variant: 'common', input: {}, output: { context: 'editor', scene: { uuid: 'example-scene' }, dirty: false } },
      { id: 'node.query', variant: 'common', input: { nodeId: 'example-panel' }, output: { node: { uuid: 'example-panel', name: 'Panel' } } },
      { id: 'asset.location', variant: 'common', input: { url: 'db://assets/Panel.prefab' }, output: { requestedUrl: 'db://assets/Panel.prefab', url: 'db://assets/Prefabs/Panel.prefab', folderUrl: 'db://assets/Prefabs/', type: 'prefab', reuseExistingFolder: true, targetExists: false } },
      { id: 'asset.organize.plan', variant: 'empty-scope', input: { scopeUrl: 'db://assets/' }, output: { planHash: hash, rows: [], skipped: [], count: 0, scopeUrl: 'db://assets/', referenceNotice: '先审查字符串路径与动态加载，再决定是否执行。' } },
      { id: 'asset.organize.recovery', variant: 'unknown', input: { journalId: 'a'.repeat(24) }, output: { journalId: 'a'.repeat(24), recordedStatus: 'pending', inspectedAt: '2026-10-29T00:00:00.000Z', rows: [{ sourceUrl: 'db://assets/Panel.prefab', targetUrl: 'db://assets/Prefabs/Panel.prefab', uuid: 'example-asset', state: 'unknown' }], automaticReplayAllowed: false, limitations: ['未完成状态核对，不允许自动重放。'] } },
      { id: 'ui.plan', variant: 'creator3', input: create, output: { planHash: hash, rows: [], parentId: create.parentId, revision: 'example-revision' } },
      { id: 'ui.plan', variant: 'creator2', input: create, output: { planHash: hash, rows: [], mapping: 'Creator2.Node-size-anchor-opacity', nativeVersion: '2.4.15' } },
      { id: 'ui.build', variant: 'unsaved', input: { ...create, planHash: hash }, output: { rootId: 'example-panel', rows: mapping, needsSave: true } },
      { id: 'ui.diff', variant: 'creator3', input: update, output: { planHash: hash, rows: [], applicable: true, blocked: [], structuralChanges: false } },
      { id: 'ui.diff', variant: 'creator2', input: update, output: { planHash: hash, rows: [], structuralChanges: false } },
      { id: 'ui.apply', variant: 'no-change', input: { ...update, planHash: hash }, output: { rootId: 'example-panel', rows: [], mapping, changed: false, needsSave: false } },
      { id: 'ui.apply', variant: 'unsaved', input: { ...update, planHash: hash }, output: { rootId: 'example-panel', rows: mapping, needsSave: true } },
      { id: 'prefab.diff', variant: 'incomplete', input: { nodeId: 'example-panel' }, output: { nodeId: 'example-panel', assetUuid: 'example-asset', url: 'db://assets/Prefabs/Panel.prefab', sourceHash: hash, instanceHash: hash, comparisonComplete: false, automaticRepairAllowed: false, rows: [], tree: [], issues: [{ code: 'HIERARCHY_LIST_MISSING' }], excludedFields: ['_id'], limitations: ['快照不完整，不能推断删除。'] } },
      { id: 'asset.references.scan', variant: 'bounded-review', input: { urls: ['db://assets/Prefabs/Panel.prefab'] }, output: { scopeUrl: 'db://assets/', scanComplete: true, referenceCoverageComplete: false, automaticRewriteAllowed: false, rows: [], issues: [], skipped: [], sources: [], targets: [], limitations: ['动态加载不能穷举。'] } },
    ] as Array<{ id: string; variant: string; input: JsonObject; output: JsonObject }>;
    rows.push({ id: 'prefab.change.plan', variant: 'restore-preserves-root-name', input: { nodeId: prefabChange.nodeId, action: 'restore' },
      output: { ...prefabChange, action: 'restore', format: 1, version: '3.8.8', projectPath: '/example/project', preservedRows: preserved, rows: preserved,
        sourceDependencies: [{ assetUuid: prefabChange.assetUuid, url: prefabChange.url, sha256: hash, bytes: 1000 }] } });
    for (const action of ['apply', 'restore']) rows.push({ id: 'prefab.change.apply', variant: action,
      input: { nodeId: prefabChange.nodeId, action, expectedHash: hash, planHash: hash }, output: { ...prefabChange, action,
        preservedRows: action === 'restore' ? preserved : [], nativeResult: { result: action === 'restore' },
        verification: action === 'restore' ? 'source-instance-converged-with-preserved-properties' : 'source-instance-converged' } });
    for (const native of [true, false]) rows.push({ id: 'preview.capture', variant: native ? 'managed' : 'external', input: { target: native ? 'embedded' : 'external-browser' }, output: {
      captureId: 'example-capture', capturedAt: '2026-10-29T00:00:00.000Z', source: native ? 'managed-preview-window' : 'scoped-browser-connector',
      width: 1, height: 1, dataUrl: 'data:image/png;base64,dGVzdA==', imageDelivery: 'image', image: { mimeType: 'image/png', byteLength: 4, sha256: hash },
      ...(native ? { stale: false, frameBinding: 'draw-observed-before-composite', exactPixelFrameIndex: null, verification: 'rendered-frame-captured', businessOutcomeVerified: false, layoutVerified: false } : {}),
    } });
    return rows;
  }
  markdown(): string {
    const catalog = new CapabilityCatalog(), contracts = new OutputContracts();
    const sections = ['# 可校验接口示例', '', '由 `node scripts/project-env.mjs node scripts/contract-examples.mjs` 生成。示例只展示参数与结果字段，身份、哈希、图片正文均为占位值，不是原生验收证据，也不能直接用于真实写入。输入与输出在生成前使用当前目录契约校验；操作信封由调用层提供。', ''];
    for (const row of this.rows()) {
      catalog.validate(row.id, row.input); contracts.validate(row.id, row.output);
      sections.push(`## ${row.id} / ${row.variant}`, '', '输入：', '', '```json', JSON.stringify(row.input, null, 2), '```', '', '结果：', '', '```json', JSON.stringify(row.output, null, 2), '```', '');
    }
    return sections.join('\n');
  }
}
