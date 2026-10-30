/** 仅允许不读取/修改场景快照的已核对控制路径；应用层与桥接层必须使用同一策略。 */
export class EditorControlPolicy {
  static allows(id: string): boolean {
    // refresh.cancel 只标记停止后续阶段，不能撤销正在执行的原生导入。
    // preview.status 会异步检查窗口并改写观测状态，不能按 read 标签直接并行。
    return ['bridge.identity', 'bridge.operation', 'console.query', 'preview.refresh.status', 'preview.refresh.cancel'].includes(id);
  }
}
