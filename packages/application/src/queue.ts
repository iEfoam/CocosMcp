import { CocosError } from '../../contracts/src/index.js';

interface WaitingTask { start(): void; cancel(error: CocosError): void }
interface QueueState { waiting: WaitingTask[] }

export class ProjectQueue {
  private readonly projects = new Map<string, QueueState>();
  constructor(private readonly maxWaiting = 128, private readonly waitTimeoutMs = 30_000) {
    if (!Number.isInteger(maxWaiting) || maxWaiting < 1 || !Number.isFinite(waitTimeoutMs) || waitTimeoutMs <= 0) throw new Error('Invalid queue policy');
  }
  run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new CocosError('CANCELLED', 'Operation cancelled before execution'));
    let queue = this.projects.get(key);
    if (queue && queue.waiting.length >= this.maxWaiting) return Promise.reject(new CocosError('RESOURCE_BUSY', 'Project operation queue is full'));
    const busy = Boolean(queue);
    if (!queue) { queue = { waiting: [] }; this.projects.set(key, queue); }
    const state = queue;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const clear = (): void => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const abort = (): void => entry.cancel(new CocosError('CANCELLED', 'Operation cancelled while queued'));
      const entry: WaitingTask = {
        cancel: error => {
          if (settled) return;
          settled = true; clear();
          const index = state.waiting.indexOf(entry);
          if (index >= 0) state.waiting.splice(index, 1);
          reject(error);
        },
        start: () => {
          if (settled) return;
          settled = true; clear();
          // 排队超时只移除尚未执行的任务；执行后的取消由桥接判断结果是否未知。
          void Promise.resolve().then(() => {
            if (signal?.aborted) throw new CocosError('CANCELLED', 'Operation cancelled before execution');
            return task();
          }).then(resolve, reject).finally(() => {
            const next = state.waiting.shift();
            if (next) next.start();
            else if (this.projects.get(key) === state) this.projects.delete(key);
          });
        },
      };
      if (!busy) entry.start();
      else {
        state.waiting.push(entry);
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => entry.cancel(new CocosError('TIMEOUT', 'Operation timed out before execution')), this.waitTimeoutMs);
      }
    });
  }
}
