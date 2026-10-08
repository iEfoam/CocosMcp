import { readFileSync, lstatSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import files from './extension-files.json' with { type: 'json' };
import { CocosError } from '../../contracts/src/index.js';

export interface ExtensionManifest { name: string; version: string; buildId?: string; sourceFingerprint?: string; fileHashes?: Record<string, string> }
export interface ExtensionHealthState { health: 'healthy' | 'degraded' | 'unknown'; rows: Array<{ path: string; status: 'passed' | 'failed' | 'unknown'; reason?: string; sha256?: string }> }

/** 安装、同版本修复和面板共享一份运行文件检查，旧包缺摘要时只报告 unknown。 */
export class ExtensionHealth {
  stamp(root: string, major: 2 | 3): string {
    return [root, join(root, 'dist'), ...files[major].map(path => join(root, path))].map(path => {
      try { const stat = lstatSync(path); return [path, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.isSymbolicLink()]; }
      catch { return [path, 'unavailable']; }
    }).map(row => JSON.stringify(row)).join('\n');
  }
  inspect(root: string, major: 2 | 3, presentation = false): ExtensionHealthState {
    const rows: ExtensionHealthState['rows'] = [];
    let manifest: ExtensionManifest | undefined;
    try { manifest = JSON.parse(this.bytes(root, 'package.json').toString()) as ExtensionManifest; } catch { /* 下方逐项报告。 */ }
    for (const path of [...files[major], ...(presentation ? files.presentation : [])]) {
      try {
        const bytes = this.bytes(root, path);
        if (!bytes.length) throw new Error('empty-file');
        if (path === 'package.json') {
          if (!manifest || manifest.name !== `cocos-mcp-creator${major}` || !manifest.version) throw new Error('invalid-extension-identity');
          rows.push({ path, status: 'passed' }); continue;
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex'), expected = manifest?.fileHashes?.[path];
        rows.push({ path, sha256, status: expected === undefined ? 'unknown' : expected === sha256 ? 'passed' : 'failed',
          ...(expected === undefined ? { reason: 'legacy-manifest-without-file-digest' } : expected !== sha256 ? { reason: 'digest-mismatch' } : {}) });
      } catch (error) { rows.push({ path, status: 'failed', reason: (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : 'unreadable-file') }); }
    }
    return { health: rows.some(row => row.status === 'failed') ? 'degraded' : rows.some(row => row.status === 'unknown') ? 'unknown' : 'healthy', rows };
  }
  require(root: string, major: 2 | 3): ExtensionHealthState {
    const state = this.inspect(root, major);
    if (state.health === 'degraded') throw new CocosError('VERIFICATION_FAILED', 'Extension required files are missing, empty or inconsistent', { rows: state.rows });
    return state;
  }
  private bytes(root: string, path: string): Buffer {
    let current = root;
    if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw new Error('symlink-or-invalid-root');
    for (const part of path.split('/')) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error('symlink-file');
    }
    if (!lstatSync(current).isFile()) throw new Error('not-a-regular-file');
    return readFileSync(current);
  }
}
