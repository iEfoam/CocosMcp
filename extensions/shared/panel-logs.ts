import type { PanelState } from '../../packages/editor-bridge/src/panel-state.js';

export const logLevels = [
  { value: 'all', label: '全部级别' },
  { value: 'error', label: '错误 · Error' },
  { value: 'warn', label: '警告 · Warning' },
  { value: 'info', label: '信息 · Info' },
] as const;

/** 历史分页使用同一份快照，避免新日志插入后导致跨页重复或漏读。 */
export class PanelLogs {
  level: string = 'all';
  page = 1;
  pageSize = 20;
  private history: PanelState['logs'] | null = null;

  filter(level: string): void {
    if (!logLevels.some(row => row.value === level)) return;
    this.level = level;
    this.latest();
  }

  resize(size: number): void {
    if (![20, 50, 100].includes(size)) return;
    this.pageSize = size;
    this.latest();
  }

  latest(): void { this.page = 1; this.history = null; }

  go(page: number, logs: PanelState['logs']): void {
    if (!Number.isInteger(page)) return;
    const view = this.view(logs);
    this.page = Math.max(1, Math.min(page, view.pages));
    if (this.page === 1) this.history = null;
    else if (!this.history) this.history = logs.slice();
  }

  view(logs: PanelState['logs']) {
    const source = this.history ?? logs;
    const filtered = source.filter(row => this.level === 'all' || row.level === this.level).slice().reverse();
    const pages = Math.max(1, Math.ceil(filtered.length / this.pageSize));
    this.page = Math.max(1, Math.min(this.page, pages));
    const offset = (this.page - 1) * this.pageSize;
    return {
      rows: filtered.slice(offset, offset + this.pageSize), total: filtered.length, pages,
      start: filtered.length ? offset + 1 : 0, end: Math.min(offset + this.pageSize, filtered.length),
      history: this.history !== null,
    };
  }
}
