/** 诊断旧编辑器账号接口时只返回成员名称/种类，绝不读取属性值或执行 getter。 */
export class UserInterfaceInspection {
  inspect(editor: object): { available: boolean; rows: Array<{ name: string; kind: string }>; truncated: boolean } {
    const user = Object.getOwnPropertyDescriptor(editor, 'User')?.value;
    if (!user || (typeof user !== 'object' && typeof user !== 'function')) return { available: false, rows: [], truncated: false };
    const rows: Array<{ name: string; kind: string }> = [], names = new Set<string>();
    let current = user;
    for (let depth = 0; current && current !== Object.prototype && current !== Function.prototype; depth++) {
      if (depth >= 4) return { available: true, rows, truncated: true };
      for (const name of Object.getOwnPropertyNames(current).sort()) {
        if (name === 'constructor' || names.has(name)) continue;
        if (rows.length >= 128) return { available: true, rows, truncated: true };
        const descriptor = Object.getOwnPropertyDescriptor(current, name)!;
        rows.push({ name, kind: descriptor.get || descriptor.set ? 'accessor' : typeof descriptor.value === 'function' ? 'method' : 'value' });
        names.add(name);
      }
      current = Object.getPrototypeOf(current);
    }
    return { available: true, rows, truncated: false };
  }
}
