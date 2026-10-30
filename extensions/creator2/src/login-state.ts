export interface Creator2UserStatus { isLoggedIn?: () => unknown }

export class Creator2LoginState {
  constructor(private readonly timeoutMs = 1000) {}

  async query(version: string, user?: Creator2UserStatus): Promise<'logged-in' | 'logged-out' | 'unknown'> {
    // 仅使用 2.4.15 原生确认存在的只读接口；不读取 token，也不以桥接授权推断账号状态。
    if (version !== '2.4.15' || typeof user?.isLoggedIn !== 'function') return 'unknown';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([user.isLoggedIn(), new Promise<undefined>(resolve => {
        timeout = setTimeout(() => resolve(undefined), this.timeoutMs);
      })]);
      return value === true ? 'logged-in' : value === false ? 'logged-out' : 'unknown';
    } catch { return 'unknown'; }
    finally { if (timeout) clearTimeout(timeout); }
  }
}
