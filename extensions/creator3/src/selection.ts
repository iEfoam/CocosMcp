export interface CreatorSelectionApi {
  getSelected(type: string): string[];
  clear(type: string): void;
  select(type: string, ids: string[]): void;
}

export class CreatorSelection {
  constructor(private readonly api: CreatorSelectionApi) {}
  update(type: string, ids?: string[]): string[] {
    const previous = this.api.getSelected(type);
    if (!ids) return previous;
    const target = [...new Set(ids)];
    // 重复选中相同相机时，不再次广播 unselect/select，避免小预览无意义地销毁和重建。
    if (previous.length === target.length && previous.every((id, index) => id === target[index])) return previous;
    if (previous.length) this.api.clear(type);
    if (target.length) this.api.select(type, target);
    return this.api.getSelected(type);
  }
}
