import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { PreviewRedaction } from '../../../extensions/shared/preview-redaction.js';
import { ProjectPaths } from './paths.js';

/** 原图与通用元信息分开保存，日志和检查点只携带路径、摘要及脱敏结果。 */
export class EvidenceStore {
  private readonly redact = new PreviewRedaction();
  private readonly identities = new Set(['operationId', 'projectId', 'instanceId', 'runtimeInstanceId', 'previewSessionId', 'diagnosticSessionId', 'sceneId', 'runId', 'fixtureId']);
  async save(paths: ProjectPaths, id: string, value: JsonValue): Promise<{ result: JsonValue; evidenceRefs: JsonObject[] }> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new CocosError('INVALID_ARGUMENT', 'Invalid evidence identity');
    const directory = await paths.resolve(join('.codex-work/artifacts/cocos-mcp', id)), refs: JsonObject[] = [];
    const visit = async (content: JsonValue, depth: number): Promise<JsonValue> => {
      if (depth > 20) return '[DEPTH-LIMIT]';
      if (Array.isArray(content)) return Promise.all(content.slice(0, 1000).map(row => visit(row, depth + 1)));
      if (!content || typeof content !== 'object') return this.redact.value(content);
      const result: JsonObject = {};
      for (const [key, entry] of Object.entries(content).slice(0, 500)) {
        if (key === 'dataUrl' && typeof entry === 'string' && entry.startsWith('data:image/png;base64,')) {
          if (refs.length >= 16 || entry.length > 48 * 1024 * 1024) throw new CocosError('RESOURCE_BUSY', 'Image evidence exceeds bounded export limits');
          const bytes = Buffer.from(entry.slice('data:image/png;base64,'.length), 'base64');
          if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new CocosError('VERIFICATION_FAILED', 'Capture is not PNG');
          const sha256 = createHash('sha256').update(bytes).digest('hex'), path = await paths.resolve(join(directory, `capture-${refs.length}.png`));
          await mkdir(directory, { recursive: true }); await writeFile(path, bytes, { mode: 0o600 });
          const image = { path, mimeType: 'image/png', sha256, bytes: bytes.length };
          refs.push(image); result.image = { ...(result.image ? Json.object(result.image) : {}), ...image };
        } else if (this.identities.has(key)) result[key] = entry;
        else if (this.redact.sensitiveKey(key, entry)) result[key] = '[REDACTED]';
        else if (key === 'image' && result.image) result.image = { ...Json.object(await visit(entry, depth + 1)), ...Json.object(result.image) };
        else result[key] = await visit(entry, depth + 1);
      }
      return result;
    };
    return { result: Json.value(await visit(value, 0)), evidenceRefs: refs };
  }
}
