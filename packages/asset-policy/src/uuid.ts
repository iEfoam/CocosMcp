/** Creator 3.8.8 资源引用的 22 字符压缩 UUID；子资源后缀保持原样，非 UUID 字符串不猜测转换。 */
export class AssetUuid {
  normalize(value: string): string {
    const separator = value.indexOf('@');
    const base = separator < 0 ? value : value.slice(0, separator), suffix = separator < 0 ? '' : value.slice(separator);
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(base)) return base.toLowerCase() + suffix;
    if (!/^[a-f0-9]{2}[A-Za-z0-9+/]{20}$/i.test(base)) return value;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let hex = base.slice(0, 2).toLowerCase(), buffer = 0, bits = 0;
    // 前两位为十六进制，剩余 20 个 Base64 字符编码 15 字节；不能将整个字符串按 Base64 解码。
    for (const char of base.slice(2)) {
      buffer = (buffer << 6) | alphabet.indexOf(char); bits += 6;
      if (bits >= 8) {
        bits -= 8; hex += ((buffer >>> bits) & 255).toString(16).padStart(2, '0'); buffer &= (1 << bits) - 1;
      }
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}${suffix}`;
  }
}
