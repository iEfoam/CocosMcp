import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { PreviewRedaction } from '../../../extensions/shared/preview-redaction.js';
import { ProjectPaths } from './paths.js';

/** 原图与通用元信息分开保存，日志和检查点只携带路径、摘要及脱敏结果。 */
export class EvidenceStore {
  constructor(private readonly maxTotalBytes = 128 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 8 || maxTotalBytes > 128 * 1024 * 1024) throw new CocosError('INVALID_ARGUMENT', 'Evidence byte budget must be between 8 bytes and 128 MiB');
  }
  private readonly redact = new PreviewRedaction();
  private readonly identities = new Set(['operationId', 'projectId', 'instanceId', 'runtimeInstanceId', 'previewSessionId', 'diagnosticSessionId', 'sceneId', 'runId', 'fixtureId']);
  async save(paths: ProjectPaths, id: string, value: JsonValue): Promise<{ result: JsonValue; evidenceRefs: JsonObject[] }> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new CocosError('INVALID_ARGUMENT', 'Invalid evidence identity');
    const directory = await paths.resolve(join('.codex-work/artifacts/cocos-mcp', id)), refs: JsonObject[] = [];
    let totalBytes = 0, pendingEvidence: JsonObject | null = null;
    const visit = async (content: JsonValue, depth: number): Promise<JsonValue> => {
      if (depth > 20) return '[DEPTH-LIMIT]';
      if (Array.isArray(content)) {
        // 顺序导出使文件序号、张数与总量预算使用同一检查点，避免并行分支覆盖证据。
        const rows: JsonValue[] = [];
        for (const row of content.slice(0, 1000)) rows.push(await visit(row, depth + 1));
        return rows;
      }
      if (!content || typeof content !== 'object') return this.redact.value(content);
      const result: JsonObject = {};
      for (const [key, entry] of Object.entries(content).slice(0, 500)) {
        if (key === 'dataUrl' && typeof entry === 'string' && entry.startsWith('data:image/png;base64,')) {
          if (refs.length >= 16 || entry.length > 48 * 1024 * 1024) throw new CocosError('RESOURCE_BUSY', 'Image evidence exceeds bounded export limits');
          const bytes = Buffer.from(entry.slice('data:image/png;base64,'.length), 'base64');
          if (totalBytes + bytes.length > this.maxTotalBytes) throw new CocosError('RESOURCE_BUSY', 'Image evidence exceeds total export budget');
          if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new CocosError('VERIFICATION_FAILED', 'Capture is not PNG');
          const sha256 = createHash('sha256').update(bytes).digest('hex'), path = await paths.resolve(join(directory, `capture-${refs.length}.png`));
          pendingEvidence = { path, expectedSha256: sha256, bytes: bytes.length, stage: 'prepare-directory' };
          await mkdir(directory, { recursive: true });
          // 同一证据标识再次导出不能覆盖已有文件；失败现场保留供查询和恢复。
          pendingEvidence.stage = 'write';
          await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
          pendingEvidence.stage = 'verify';
          if (createHash('sha256').update(await readFile(path)).digest('hex') !== sha256) throw new CocosError('VERIFICATION_FAILED', 'Persisted image evidence hash does not match');
          totalBytes += bytes.length;
          const image = { path, mimeType: 'image/png', sha256, bytes: bytes.length };
          refs.push(image); pendingEvidence = null; result.image = { ...(result.image ? Json.object(result.image) : {}), ...image };
        } else if (this.identities.has(key)) result[key] = entry;
        else if (this.redact.sensitiveKey(key, entry)) result[key] = '[REDACTED]';
        else if (key === 'image' && result.image) result.image = { ...Json.object(await visit(entry, depth + 1)), ...Json.object(result.image) };
        else result[key] = await visit(entry, depth + 1);
      }
      return result;
    };
    try { return { result: Json.value(await visit(value, 0)), evidenceRefs: refs }; }
    catch (error) {
      const failure = CocosError.from(error);
      // 写入和读回可能分别失败；未核验文件不能冒充成功引用，也不能丢失它的位置让调用方盲目重放。
      throw new CocosError(failure.code, failure.message, { evidenceRefs: refs, partial: true, pendingEvidence });
    }
  }
}
