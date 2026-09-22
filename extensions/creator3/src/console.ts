import { CocosError, Json, type JsonObject } from '../../../packages/contracts/src/index.js';

export interface CreatorLogger { query(): unknown }

/** 仅查询 Creator 的日志中心，不挂接 console、不清空日志，也不读取任意磁盘文件。 */
export class CreatorConsole {
  private sequence = 0;
  private readonly identities = new WeakMap<object, number>();
  constructor(private readonly logger: CreatorLogger) {}

  private text(value: unknown, limit: number): string {
    if (typeof value === 'string') return value.slice(0, limit);
    if (Array.isArray(value)) return value.map(row => this.text(row, limit)).join('\n').slice(0, limit);
    return value === undefined || value === null ? '' : String(value).slice(0, limit);
  }

  private instant(value: unknown): string | null {
    // Logger 的数值时间是 Unix 毫秒；没有时区的字符串不能擅自解释成 UTC。
    if (typeof value !== 'number' && !(typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value))) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  async query(params: JsonObject): Promise<JsonObject> {
    const cursor = Number(params.cursor ?? 0), limit = Number(params.limit ?? 100);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new CocosError('INVALID_ARGUMENT', 'Console cursor must be non-negative and limit must be 1..500');
    if (params.level !== undefined && !['debug', 'info', 'warn', 'error'].includes(String(params.level))) throw new CocosError('INVALID_ARGUMENT', 'Unknown console level');
    const raw = await this.logger.query();
    if (!Array.isArray(raw) || raw.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new CocosError('UNSUPPORTED_VERSION', 'Creator Logger returned an unsupported log format');
    const rows: JsonObject[] = raw.slice(-5000).map(entry => {
      let sequence = this.identities.get(entry);
      if (sequence === undefined) { sequence = ++this.sequence; this.identities.set(entry, sequence); }
      const log = entry as Record<string, unknown>;
      const rawLevel = this.text(log.type, 32);
      return { sequence, level: rawLevel === 'log' ? 'info' : rawLevel, rawLevel,
        message: this.text(log.message, 16384), stack: this.text(log.stack, 32768),
        process: this.text(log.process, 128), occurredAt: this.instant(log.time ?? log.date), source: 'creator-console' };
    });
    const contains = params.contains === undefined ? '' : Json.string(params.contains, 'contains').toLowerCase();
    const matching = rows.filter(row => Number(row.sequence) > cursor && (!params.level || row.level === params.level)
      && (!params.process || row.process === params.process)
      && (!contains || `${row.message}\n${row.stack}`.toLowerCase().includes(contains)));
    const page = matching.slice(0, limit);
    return { rows: page, nextCursor: page.length ? page[page.length - 1]!.sequence! : Math.max(cursor, this.sequence), hasMore: matching.length > limit,
      retained: rows.length, droppedBefore: rows.length ? Number(rows[0]!.sequence) - 1 : this.sequence,
      source: 'creator-console', reader: 'Editor.Logger.query', order: 'oldest-first',
      scope: 'Creator editor processes; excludes standalone browser previews', truncated: raw.length > 5000 };
  }
}
