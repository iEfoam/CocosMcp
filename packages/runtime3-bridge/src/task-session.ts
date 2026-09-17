import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { FrameSession } from './frame-session.js';
import type { RuntimeObject } from './access.js';

interface RuntimeTask {
  taskId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  progress: JsonObject;
  result?: JsonObject;
  error?: JsonObject;
  frames: FrameSession;
  cancelled: boolean;
  completion: Promise<void>;
}

/** 长任务拥有独立帧等待器，停止单个任务不能取消其他采样。 */
export class RuntimeTaskSessions {
  private readonly tasks = new Map<string, RuntimeTask>();
  private generation = 0;
  private sequence = 0;
  constructor(private readonly cc: RuntimeObject) {}
  start(run: (frames: FrameSession, progress: (value: JsonObject) => void) => Promise<JsonObject>): JsonObject {
    if ([...this.tasks.values()].filter(task => task.status === 'running').length >= 4) throw new CocosError('RESOURCE_BUSY', 'At most four runtime tasks may run concurrently');
    while (this.tasks.size >= 8) {
      const oldest = [...this.tasks.values()].find(task => task.status !== 'running');
      if (!oldest) break;
      this.tasks.delete(oldest.taskId);
    }
    const taskId = `${this.generation}:task:${++this.sequence}`;
    const task: RuntimeTask = { taskId, status: 'running', progress: {}, frames: new FrameSession(this.cc), cancelled: false, completion: Promise.resolve() };
    this.tasks.set(taskId, task);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; task.frames.dispose(); }, 30000);
    task.completion = Promise.resolve().then(() => {
      if (task.cancelled) throw new CocosError('STALE_HANDLE', 'Task cancelled before starting');
      return run(task.frames, value => { task.progress = value; });
    }).then(result => { task.result = result; task.status = 'completed'; }, error => {
      const failure = CocosError.from(error);
      // 清理失败必须保持失败状态，不能因用户停止而伪装成正常取消。
      task.status = task.cancelled && !timedOut && failure.code !== 'OUTCOME_UNKNOWN' ? 'cancelled' : 'failed';
      // 截止时间与停止可能发生在同一微任务交接处；保留超时及更严重的清理失败。
      task.error = (timedOut && failure.code !== 'OUTCOME_UNKNOWN' ? new CocosError('CONTEXT_UNAVAILABLE', 'Runtime task exceeded 30 seconds') : failure).toJSON() as unknown as JsonObject;
    }).finally(() => { clearTimeout(timeout); task.frames.dispose(); });
    return { taskId, status: 'running', deadlineMs: 30000 };
  }
  private task(p: JsonObject): RuntimeTask {
    const task = this.tasks.get(Json.string(p.taskId, 'taskId'));
    if (!task) throw new CocosError('STALE_HANDLE', 'Runtime task expired or belongs to an ended scene/session');
    return task;
  }
  poll(p: JsonObject): JsonObject {
    const task = this.task(p);
    return { taskId: task.taskId, status: task.status, progress: task.progress, ...(task.result ? { result: task.result } : {}), ...(task.error ? { error: task.error } : {}) };
  }
  async stop(p: JsonObject): Promise<JsonObject> {
    const task = this.task(p);
    if (task.status === 'running') { task.cancelled = true; task.frames.dispose(); }
    // 等到采样 finally 完成才返回，调用者可据此检查临时组件已请求销毁。
    await task.completion;
    return this.poll(p);
  }
  dispose(): void {
    this.generation++;
    for (const task of this.tasks.values()) if (task.status === 'running') { task.cancelled = true; task.frames.dispose(); }
    this.tasks.clear();
  }
}
