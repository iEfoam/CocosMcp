import { appendFile, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { ProjectPaths } from './paths.js';
import { AtomicJson } from './atomic-json.js';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** 通用审计仅接受元信息；请求与响应正文不落盘，恢复记录也只存摘要与终态。 */
export class OperationAudit {
  async rows(paths: ProjectPaths, p: JsonObject): Promise<JsonObject> {
    const parse = (value: JsonValue | undefined): number | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new CocosError('INVALID_ARGUMENT', 'Audit time bounds must be UTC ISO timestamps ending in Z');
      const normalized = new Date(Date.parse(value)).toISOString();
      if (normalized.slice(0, 19) !== value.slice(0, 19)) throw new CocosError('INVALID_ARGUMENT', 'Audit timestamp contains an invalid calendar date');
      return Date.parse(value);
    };
    const from = parse(p.from), to = parse(p.to), cursor = Number(p.cursor ?? 0), limit = Number(p.limit ?? 100);
    if (from !== undefined && to !== undefined && from >= to || !Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new CocosError('INVALID_ARGUMENT', 'Invalid audit range or pagination');
    const path = await paths.resolve('.codex-work/logs/cocos-mcp/operations.jsonl');
    try { await stat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], nextCursor: null, range: '[from,to)', timeZone: 'UTC' }; throw error; }
    const input = createReadStream(path, { encoding: 'utf8' }), lines = createInterface({ input, crlfDelay: Infinity });
    const rows: JsonObject[] = []; let index = 0, nextCursor: number | null = null;
    try {
      for await (const line of lines) {
        const current = index++; if (current < cursor) continue;
        if (line.length > 65536) throw new CocosError('RESOURCE_BUSY', 'Audit line exceeds metadata limit');
        let row: JsonObject; try { row = Json.object(JSON.parse(line)); } catch { continue; }
        const at = Date.parse(String(row.startedAt));
        if (!Number.isFinite(at) || from !== undefined && at < from || to !== undefined && at >= to || p.operationId !== undefined && row.operationId !== p.operationId) continue;
        if (rows.length === limit) { nextCursor = current; break; }
        rows.push(row);
      }
    } finally { lines.close(); input.destroy(); }
    return { rows, nextCursor, range: '[from,to)', timeZone: 'UTC' };
  }
  async record(paths: ProjectPaths, row: JsonObject): Promise<boolean> {
    try {
      const folder = await paths.work('logs', 'cocos-mcp');
      await appendFile(await paths.resolve(join(folder, 'operations.jsonl')), JSON.stringify(row) + '\n', { mode: 0o600 });
      return true;
    } catch { return false; }
  }
  async reserve(paths: ProjectPaths, operationId: string, fingerprint: string, metadata: JsonObject): Promise<string> {
    const folder = await paths.work('cache', 'cocos-mcp/operation-recovery');
    const path = await paths.resolve(join(folder, createHash('sha256').update(operationId).digest('hex') + '.json'));
    try { await new AtomicJson().write(path, { ...metadata, operationId, fingerprint, status: 'pending', resultAvailable: false }, true); }
    catch (error) {
      if (CocosError.from(error).code !== 'OPERATION_CONFLICT') throw error;
      const existing = Json.object(JSON.parse(await readFile(path, 'utf8')));
      if (existing.fingerprint !== fingerprint) throw new CocosError('OPERATION_CONFLICT', 'operationId is durably bound to different parameters');
      // 服务重启后没有原内存结果；即便记录 completed 也不能再次发送点击或写操作。
      throw new CocosError('OUTCOME_UNKNOWN', 'Operation was recorded by an earlier service session; inspect recovery state before creating a new operation', existing);
    }
    return path;
  }
  async finish(path: string, state: JsonObject): Promise<boolean> {
    try {
      const previous = Json.object(JSON.parse(await readFile(path, 'utf8')));
      await new AtomicJson().write(path, { ...previous, ...state }); return true;
    } catch { return false; }
  }
  async query(paths: ProjectPaths, operationId: string): Promise<JsonValue | undefined> {
    const path = await paths.resolve(join('.codex-work/cache/cocos-mcp/operation-recovery', createHash('sha256').update(operationId).digest('hex') + '.json'));
    try { return Json.value(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
}
