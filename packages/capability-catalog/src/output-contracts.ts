import { Ajv, type ValidateFunction } from 'ajv';
import { CocosError, type JsonSchema, type JsonValue } from '../../contracts/src/index.js';

/** 首批输出契约只约束已确认的公共字段；原生 dump 和兼容扩展字段保持开放。 */
export class OutputContracts {
  private ajv: Ajv | undefined;
  private readonly validators = new Map<string, ValidateFunction>();
  private object(properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema {
    return { type: 'object', properties, required, additionalProperties: true };
  }
  schema(id: string): JsonSchema | undefined {
    const text = { type: 'string', minLength: 1 }, bool = { type: 'boolean' }, object = { type: 'object' };
    const rows = { type: 'array', items: object }, hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
    const mapping = { type: 'array', items: this.object({ key: text, nodeId: text }) };
    const preservedRows = { type: 'array', maxItems: 1, items: this.object({ key: text, kind: { const: 'node' }, status: { const: 'property-override' },
      change: this.object({ kind: { const: 'changed' }, path: { const: 'properties/_name' }, before: { type: 'string' }, after: { type: 'string' } }) }) };
    const prefabChange = { nodeId: text, action: { enum: ['apply', 'restore'] }, assetUuid: text, url: text,
      sourceHash: hash, sourceGraphHash: hash, instanceHash: hash, expectedHash: hash, planHash: hash, preservedRows, sceneSavedByTool: { const: false } };
    switch (id) {
      case 'scene.query': return this.object({ context: { const: 'editor' }, scene: object, dirty: { type: ['boolean', 'null'] } });
      case 'node.query': return this.object({ node: object });
      case 'preview.capture': return {
        ...this.object({ captureId: text, capturedAt: text, source: text, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 },
          dataUrl: { type: 'string', pattern: '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$' },
          image: this.object({ mimeType: { const: 'image/png' }, byteLength: { type: 'integer', minimum: 1 }, sha256: hash }),
          imageDelivery: { enum: ['image', 'legacy-json'] }, stale: bool, businessOutcomeVerified: { const: false }, layoutVerified: { const: false } },
        ['captureId', 'capturedAt', 'source', 'width', 'height', 'dataUrl', 'image', 'imageDelivery']),
        // 外部浏览器没有原生 AFTER_DRAW 绑定，不强迫它伪造同一帧证据。
        allOf: [{ if: { type: 'object', properties: { source: { const: 'managed-preview-window' } }, required: ['source'] },
          then: this.object({ stale: bool, frameBinding: { const: 'draw-observed-before-composite' }, exactPixelFrameIndex: { type: 'null' },
            verification: { const: 'rendered-frame-captured' }, businessOutcomeVerified: { const: false }, layoutVerified: { const: false } }) }],
      };
      case 'prefab.diff': return this.object({ nodeId: text, assetUuid: text, url: text, sourceHash: hash, instanceHash: hash,
        comparisonComplete: bool, automaticRepairAllowed: { const: false }, rows: { type: 'array', maxItems: 10000, items: this.object({ key: text, kind: { enum: ['node', 'component'] }, status: { enum: ['added', 'removed', 'unverified-added', 'unverified-missing', 'property-override', 'unverified-property-difference'] } }) },
        tree: rows, issues: rows, excludedFields: { type: 'array', items: text }, limitations: { type: 'array', items: text } });
      case 'prefab.change.plan': return { ...this.object({ ...prefabChange, format: { const: 1 }, version: { const: '3.8.8' }, projectPath: text, rows,
        sourceDependencies: { type: 'array', minItems: 1, maxItems: 100, items: this.object({ assetUuid: text, url: text, sha256: hash, bytes: { type: 'integer', minimum: 0, maximum: 16777216 } }) } }),
        allOf: [{ if: this.object({ action: { const: 'apply' } }), then: this.object({ preservedRows: { type: 'array', maxItems: 0 } }) }] };
      case 'prefab.change.apply': return { ...this.object({ ...prefabChange, nativeResult: object,
        verification: { enum: ['source-instance-converged', 'source-instance-converged-with-preserved-properties'] } }),
        allOf: [{ if: this.object({ verification: { const: 'source-instance-converged-with-preserved-properties' } }),
          then: this.object({ action: { const: 'restore' }, preservedRows: { type: 'array', minItems: 1 } }),
          else: this.object({ preservedRows: { type: 'array', maxItems: 0 } }) }] };
      case 'asset.location': return this.object({ requestedUrl: text, url: text, folderUrl: text, type: text, reuseExistingFolder: bool, targetExists: bool });
      case 'asset.references.scan': return this.object({ scopeUrl: text, scanComplete: bool, referenceCoverageComplete: { const: false }, automaticRewriteAllowed: { const: false },
        rows: { type: 'array', maxItems: 10000, items: this.object({ sourceUrl: text, kind: { enum: ['uuid', 'literal-path', 'dynamic-unknown'] }, confidence: text, automaticRewriteAllowed: { const: false } }) },
        issues: rows, skipped: rows, sources: rows, targets: rows, limitations: { type: 'array', items: text } });
      case 'asset.organize.plan': return this.object({ planHash: hash, rows, skipped: rows, count: { type: 'integer', minimum: 0 }, scopeUrl: text, referenceNotice: text });
      case 'asset.organize.recovery': return this.object({ journalId: { type: 'string', pattern: '^[a-f0-9]{24}$' }, recordedStatus: text, inspectedAt: text,
        rows: { type: 'array', items: this.object({ sourceUrl: text, targetUrl: text, uuid: text, state: { enum: ['moved', 'not-moved', 'conflict', 'unknown'] } }) },
        automaticReplayAllowed: { const: false }, limitations: { type: 'array', items: text } });
      case 'ui.plan': return this.object({ planHash: hash, rows, revision: text, parentId: text }, ['planHash', 'rows']);
      case 'ui.build': return this.object({ rootId: text, rows: mapping, needsSave: { const: true } });
      case 'ui.diff': return this.object({ planHash: hash, rows, applicable: bool, blocked: rows, structuralChanges: bool }, ['planHash', 'rows']);
      case 'ui.apply': return this.object({ rootId: text, rows, needsSave: bool, mapping, changed: bool }, ['rootId', 'rows', 'needsSave']);
      default: return undefined;
    }
  }
  validate(id: string, value: JsonValue): void {
    const schema = this.schema(id); if (!schema) return;
    const ajv = this.ajv ??= new Ajv({ strict: true, allErrors: true });
    let validate = this.validators.get(id);
    if (!validate) {
      validate = ajv.compile(schema); this.validators.set(id, validate);
    }
    // 输出错误是实现/读回问题，绝不能被分类为可安全重试的输入参数错误。
    if (!validate(value)) throw new CocosError('VERIFICATION_FAILED', 'Capability output violates its contract', {
      capabilityId: id, validation: ajv.errorsText(validate.errors),
    });
  }
}
