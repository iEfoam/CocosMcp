import type { PanelState } from '../../packages/editor-bridge/src/panel-state.js';

export class PanelLogCache {
  private rows: PanelState['logs'] = [];
  private cursor = '';
  request(): string { return this.cursor; }
  accept(snapshot: PanelState): PanelState['logs'] {
    const window = snapshot.logWindow;
    // 兼容旧主进程返回的完整快照；重启后的 epoch 改变时也必须替换旧日志。
    if (!window || window.reset) this.rows = snapshot.logs.slice();
    else this.rows = this.rows.filter(row => Number(row.sequence) > window.droppedBefore).concat(snapshot.logs);
    this.rows = this.rows.slice(-5000);
    this.cursor = window ? JSON.stringify({ epoch: window.epoch, sequence: window.cursor }) : '';
    return this.rows;
  }
}
