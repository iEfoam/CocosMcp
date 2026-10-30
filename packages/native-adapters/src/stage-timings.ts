import { performance } from 'perf_hooks';
import type { JsonObject } from '../../contracts/src/index.js';

/** 每次请求独立计时，只保存固定阶段名和数值，不保存参数、路径或认证数据。 */
export class StageTimings {
  private readonly stages = new Map<string, { durationMs: number; calls: number }>();
  constructor(private readonly now: () => number = () => performance.now()) {}
  start(stage: string): () => void {
    const start = this.now(); let stopped = false;
    return () => {
      if (stopped) return; stopped = true;
      if (!this.stages.has(stage) && this.stages.size >= 32) return;
      const previous = this.stages.get(stage) ?? { durationMs: 0, calls: 0 };
      this.stages.set(stage, { durationMs: previous.durationMs + Math.max(0, this.now() - start), calls: previous.calls + 1 });
    };
  }
  async measure<T>(stage: string, task: () => Promise<T>): Promise<T> {
    const stop = this.start(stage);
    try { return await task(); } finally { stop(); }
  }
  sync<T>(stage: string, task: () => T): T {
    const stop = this.start(stage);
    try { return task(); } finally { stop(); }
  }
  rows(): JsonObject[] { return [...this.stages].map(([stage, value]) => ({ stage, ...value })); }
}
