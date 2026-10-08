import type { JsonValue } from '../../packages/contracts/src/index.js';

/** 在存储和输出边界都脱敏；正文默认不采集，未知格式不当作安全文本透传。 */
export class PreviewRedaction {
  private readonly sensitive = /pass(?:word|wd)?|pwd|token|authorization|cookie|secret|signature|api[-_]?key|session[-_]?id|credential|private[-_]?key/i;
  sensitiveKey(key: string, value: unknown): boolean {
    // 验收结果的布尔 passed 不是凭据；仅豁免明确类型，字符串仍按保守规则脱敏。
    return !(key === 'passed' && typeof value === 'boolean') && this.sensitive.test(key);
  }
  text(value: unknown, limit = 16384): string {
    let text = String(value ?? '').slice(0, limit + 1024);
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return JSON.stringify(this.value(parsed)).slice(0, limit);
    } catch { /* 普通日志使用保守的键值和凭证格式匹配。 */ }
    text = text.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, raw => this.url(raw));
    text = text.replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [REDACTED]');
    text = text.replace(/((?:["']?\b[\w.-]{0,64}(?:password|passwd|pwd|token|authorization|cookie|secret|signature|api[-_]?key|session[-_]?id|credential|private[-_]?key)[\w.-]{0,64}["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;&}]+)/gi, '$1[REDACTED]');
    text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
    return text.slice(0, limit);
  }
  url(value: unknown): string {
    try {
      const url = new URL(String(value));
      if (!['http:', 'https:', 'ws:', 'wss:', 'file:'].includes(url.protocol)) return `[${url.protocol}]`;
      // 查询值和 fragment 常被业务用作无字段名凭证，因此全部省略。
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      return url.href.slice(0, 2048);
    } catch { return '[invalid-url]'; }
  }
  value(value: unknown, depth = 0): JsonValue {
    if (depth > 12) return '[DEPTH-LIMIT]';
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.slice(0, 500).map(row => this.value(row, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, content]) => [key, this.sensitiveKey(key, content) ? '[REDACTED]' : this.value(content, depth + 1)]));
    return null;
  }
}
