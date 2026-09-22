import { performance } from 'node:perf_hooks';
import { CocosError, type ExecutionResult, type JsonValue } from '../../contracts/src/index.js';

interface OperationRecord {
  fingerprint: string;
  instanceId?: string;
  status: 'pending' | 'succeeded' | 'failed' | 'unknown';
  expiresAt: number;
  promise: Promise<ExecutionResult>;
  result?: ExecutionResult;
  error?: CocosError;
}

/** 将指纹、执行中请求和结果放在同一条有界记录内，避免失败请求泄漏指纹。 */
export class OperationStore {
  private readonly records = new Map<string, OperationRecord>();
  constructor(private readonly capacity = 2048, private readonly ttlMs = 30 * 60_000, private readonly now = () => performance.now()) {
    if (!Number.isInteger(capacity) || capacity < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Invalid operation retention policy');
  }
  private expire(): void {
    for (const [key, row] of this.records) {
      // 结果未知或尚在执行的写操作不能因过期而变成可重新执行的请求。
      if ((row.status === 'succeeded' || row.status === 'failed') && row.expiresAt <= this.now()) this.records.delete(key);
    }
  }
  run(key: string, fingerprint: string, task: () => Promise<ExecutionResult>): Promise<ExecutionResult> {
    this.expire();
    const existing = this.records.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(new CocosError('OPERATION_CONFLICT', 'operationId is already bound to different capability parameters'));
      return existing.promise;
    }
    if (this.records.size >= this.capacity) {
      const removable = [...this.records].find(([, row]) => row.status === 'succeeded' || row.status === 'failed');
      if (removable) this.records.delete(removable[0]);
      else return Promise.reject(new CocosError('RESOURCE_BUSY', 'Operation retention is full of pending or unknown outcomes; reconcile existing operations first'));
    }
    const row: OperationRecord = { fingerprint, status: 'pending', expiresAt: Infinity, promise: Promise.resolve().then(task) };
    row.promise = row.promise.then(result => {
      row.status = 'succeeded'; row.result = result; row.expiresAt = this.now() + this.ttlMs;
      return result;
    }, error => {
      row.error = CocosError.from(error);
      row.status = row.error.code === 'OUTCOME_UNKNOWN' ? 'unknown' : 'failed';
      row.expiresAt = this.now() + this.ttlMs;
      throw row.error;
    });
    this.records.set(key, row);
    return row.promise;
  }
  target(key: string, instanceId?: string): string | undefined {
    const row = this.records.get(key);
    if (row && instanceId) row.instanceId = instanceId;
    return row?.instanceId;
  }
  binding(key: string): string | undefined { return this.records.get(key)?.fingerprint; }
  /** 仅在桥接账本确认终态后解除未知结果保护，不能依据 NOT_FOUND 推断操作未发生。 */
  settle(key: string, outcome: ExecutionResult | CocosError): void {
    const row = this.records.get(key);
    if (!row || row.status !== 'unknown') return;
    row.expiresAt = this.now() + this.ttlMs;
    if (outcome instanceof CocosError) {
      if (outcome.code === 'OUTCOME_UNKNOWN') return;
      row.status = 'failed'; row.error = outcome; row.promise = Promise.reject(outcome);
      // 对账可能没有执行重试的调用者；仍保留拒绝 Promise 供之后的同 ID 请求读取。
      void row.promise.catch(() => {});
    } else {
      row.status = 'succeeded'; row.result = outcome; delete row.error; row.promise = Promise.resolve(outcome);
    }
  }
  result(key: string): ExecutionResult | undefined { this.expire(); return this.records.get(key)?.result; }
  state(key: string): JsonValue | undefined {
    this.expire();
    const row = this.records.get(key);
    return row ? { status: row.status, ...(row.error ? { error: { ...row.error.toJSON() } } : {}) } : undefined;
  }
  get size(): number { this.expire(); return this.records.size; }
}
