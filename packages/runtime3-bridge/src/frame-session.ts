import { CocosError } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import { FeatureSupport as F } from './feature-support.js';

/** 每次等待都有上限；断线和切场景使尚未完成的采样立即失效。 */
export class FrameSession {
  private readonly pending = new Set<(error: Error) => void>();
  private generation = 0;
  constructor(private readonly cc: RuntimeObject) {}
  token(): number { return this.generation; }
  check(token: number): void { if (token !== this.generation) throw new CocosError('STALE_HANDLE', '采样会话已结束'); }
  wait(token: number): Promise<void> {
    this.check(token);
    const director = F.require(this.cc.director, 'Director'); F.methods(director, ['on', 'off', 'getScene']);
    const scene = A.call(director, 'getScene'), event = F.require(this.cc.Director, 'Director events').EVENT_AFTER_DRAW;
    if (typeof event !== 'string') throw new CocosError('UNSUPPORTED_CAPABILITY', '缺少帧完成事件');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return; settled = true; clearTimeout(timer); this.pending.delete(cancel);
        try { A.call(director, 'off', event, callback); } catch (failure) { error ??= CocosError.from(failure); }
        if (error) reject(error); else resolve();
      };
      const callback = (): void => {
        try { this.check(token); if (A.call(director, 'getScene') !== scene) throw new CocosError('STALE_HANDLE', '采样期间场景已切换'); finish(); }
        catch (error) { finish(CocosError.from(error)); }
      };
      const cancel = (error: Error): void => finish(error);
      const timer = setTimeout(() => finish(new CocosError('CONTEXT_UNAVAILABLE', '等待渲染帧超时', {
        timeoutMs: 2000, gamePaused: this.paused(this.cc.game), directorPaused: this.paused(director),
      })), 2000);
      this.pending.add(cancel);
      try { A.call(director, 'on', event, callback); } catch (error) { finish(CocosError.from(error)); }
    });
  }
  private paused(target: unknown): boolean | null {
    // 仅补充超时时的只读状态；不替用户 resume，也不让缺失/异常查询掩盖原始超时和监听清理。
    try {
      if (typeof A.object(target).isPaused !== 'function') return null;
      const value = A.call(target, 'isPaused');
      return typeof value === 'boolean' ? value : null;
    } catch { return null; }
  }
  dispose(): void { this.generation++; for (const cancel of this.pending) cancel(new CocosError('STALE_HANDLE', '运行时断开')); this.pending.clear(); }
}
