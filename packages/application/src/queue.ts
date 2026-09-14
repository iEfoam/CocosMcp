import { CocosError } from '../../contracts/src/index.js';

export class ProjectQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => pending);
    this.tails.set(key, tail);
    await previous;
    try {
      if (signal?.aborted) throw new CocosError('CANCELLED', 'Operation cancelled before execution');
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
