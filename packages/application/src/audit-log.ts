import { open, lstat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { CocosError, type JsonObject } from '../../contracts/src/index.js';
import { ProjectPaths } from './paths.js';

interface Segment { name: string; day: string; bytes: number }
export interface AuditPosition { segment: string; offset: number; index: number; identity: string }

/** 新日志分段写入，旧日志保持原位；恢复账本不受轮转或审计分页影响。 */
export class AuditLog {
  private readonly active = new Map<string, Segment>();
  private readonly pending = new Map<string, Promise<void>>();
  private lastSegmentTime = 0;
  constructor(private readonly segmentBytes = 4 * 1024 * 1024, private readonly clock: () => number = Date.now) {
    if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 1) throw new CocosError('INVALID_ARGUMENT', 'Invalid audit segment budget');
  }
  async append(paths: ProjectPaths, row: JsonObject): Promise<void> {
    const data = Buffer.from(JSON.stringify(row) + '\n');
    if (data.length > 65536) throw new CocosError('RESOURCE_BUSY', 'Audit metadata exceeds line budget');
    const key = paths.root;
    const task = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const folder = await paths.work('logs', 'cocos-mcp/operations');
      const now = new Date(this.clock()).toISOString(), day = now.slice(0, 10);
      let segment = this.active.get(key);
      if (!segment || segment.day !== day || segment.bytes + data.length > this.segmentBytes) {
        // 同一毫秒内轮转仍按创建顺序排序；不同进程的并发记录不承诺全局事件时间顺序。
        this.lastSegmentTime = Math.max(Date.parse(now), this.lastSegmentTime + 1);
        const stamp = new Date(this.lastSegmentTime).toISOString().replace(/[-:.]/g, '');
        segment = { name: `${stamp}-${randomBytes(12).toString('hex')}.jsonl`, day, bytes: 0 };
        const file = await open(await paths.resolve(join(folder, segment.name)), 'wx', 0o600);
        await file.close();
        // 只释放内存句柄；历史分段及恢复证据从不在此删除。
        if (this.active.size >= 128) this.active.delete(this.active.keys().next().value!);
        this.active.set(key, segment);
      }
      const path = await paths.resolve(join(folder, segment.name)), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== segment.bytes) throw new CocosError('VERIFICATION_FAILED', 'Audit segment changed outside its writer');
      const file = await open(path, 'a');
      try { await file.writeFile(data); await file.sync(); segment.bytes += data.length; }
      catch (error) { this.active.delete(key); throw error; }
      finally { await file.close(); }
    });
    this.pending.set(key, task);
    try { await task; } finally { if (this.pending.get(key) === task) this.pending.delete(key); }
  }
  private validName(name: string): boolean { return name === 'legacy' || /^\d{8}T\d{9}Z-[a-f0-9]{24}\.jsonl$/.test(name); }
  encode(position: AuditPosition): string { return Buffer.from(JSON.stringify(position)).toString('base64url'); }
  decode(value: unknown): AuditPosition {
    if (typeof value !== 'string' || value.length > 1024) throw new CocosError('INVALID_ARGUMENT', 'Invalid audit pageCursor');
    try {
      const p = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as AuditPosition;
      if (!this.validName(p.segment) || !Number.isSafeInteger(p.offset) || p.offset < 0 || !Number.isSafeInteger(p.index) || p.index < 0 || typeof p.identity !== 'string') throw new Error();
      return p;
    } catch { throw new CocosError('INVALID_ARGUMENT', 'Invalid audit pageCursor'); }
  }
  async *lines(paths: ProjectPaths, position?: AuditPosition): AsyncGenerator<{ line: string; position: AuditPosition }> {
    const folder = await paths.resolve('.codex-work/logs/cocos-mcp/operations');
    let names: string[] = [];
    try { names = (await readdir(folder)).filter(name => this.validName(name) && name !== 'legacy').sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const legacy = await paths.resolve('.codex-work/logs/cocos-mcp/operations.jsonl');
    try { await lstat(legacy); names.unshift('legacy'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const start = position ? names.indexOf(position.segment) : 0;
    if (start < 0) throw new CocosError('STALE_REVISION', 'Audit cursor segment is missing');
    let index = position?.index ?? 0;
    for (let i = start; i < names.length; i++) {
      const name = names[i]!, path = await paths.resolve(name === 'legacy' ? legacy : join(folder, name));
      const info = await lstat(path), identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
      let offset = i === start ? position?.offset ?? 0 : 0;
      if (!info.isFile() || info.isSymbolicLink()) throw new CocosError('VERIFICATION_FAILED', 'Invalid audit segment');
      if (position && i === start && (identity !== position.identity || offset > info.size)) throw new CocosError('STALE_REVISION', 'Audit cursor segment was replaced or truncated');
      if (offset > 0) {
        const file = await open(path, 'r'), byte = Buffer.alloc(1);
        try { await file.read(byte, 0, 1, offset - 1); } finally { await file.close(); }
        if (byte[0] !== 10) throw new CocosError('INVALID_ARGUMENT', 'Audit cursor must point to a record boundary');
      }
      if (offset === info.size) continue;
      const input = createReadStream(path, { start: offset, end: info.size - 1, highWaterMark: 65536 });
      let remaining = Buffer.alloc(0);
      try {
        for await (const chunk of input) {
          remaining = Buffer.concat([remaining, chunk as Buffer]);
          let newline: number;
          while ((newline = remaining.indexOf(10)) >= 0) {
            if (newline > 65535) throw new CocosError('RESOURCE_BUSY', 'Audit line exceeds metadata limit');
            yield { line: remaining.subarray(0, newline).toString('utf8'), position: { segment: name, offset, index, identity } };
            offset += newline + 1; index++; remaining = remaining.subarray(newline + 1);
          }
          if (remaining.length > 65536) throw new CocosError('RESOURCE_BUSY', 'Audit line exceeds metadata limit');
        }
        // 旧文件可能没有尾换行；新分段的残行代表中断写入，不当作完整记录。
        if (name === 'legacy' && remaining.length) yield { line: remaining.toString('utf8'), position: { segment: name, offset, index: index++, identity } };
      } finally { input.destroy(); }
    }
  }
}
