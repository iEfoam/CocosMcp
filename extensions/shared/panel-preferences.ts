import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import type { PanelLocale } from './panel-i18n.js';

interface MenuEntry { label: string; message: string; target?: string }
export interface PanelMenuHost {
  Menu?: { remove(path: string, options: MenuEntry): void; add(path: string, options: MenuEntry): void; apply(): void };
  MainMenu?: { remove(path: string): void; add(path: string, options: MenuEntry): void; apply(): void };
}
const menuLabels = [
  { zh: '启动桥接', en: 'Start Bridge', message: 'start' },
  { zh: '停止桥接', en: 'Stop Bridge', message: 'stop' },
  { zh: '显示连接状态', en: 'Connection Status', message: 'status' },
  { zh: '打开控制中心', en: 'Open Control Center', message: 'open' },
];

/** 扩展独立保存语言，不改变 Creator 自身或其他扩展的语言设置。 */
export class PanelPreferences {
  private locale: PanelLocale | undefined;
  private menuLocale: PanelLocale = 'zh';
  constructor(private readonly project: () => string, private readonly major: 2 | 3, private readonly editor: PanelMenuHost,
    private readonly clipboard: () => { writeText(text: string): void } = () => (require('electron') as { clipboard: { writeText(text: string): void } }).clipboard) {}
  read(): PanelLocale {
    if (this.locale) return this.locale;
    const file = join(this.project(), '.codex-work/cache/cocos-mcp/panel-preferences.json');
    const value: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    this.locale = value && typeof value === 'object' && 'locale' in value && value.locale === 'en' ? 'en' : 'zh';
    return this.locale;
  }
  set(locale: unknown): PanelLocale {
    if (locale !== 'zh' && locale !== 'en') throw new Error('Unsupported panel language');
    const directory = join(this.project(), '.codex-work/cache/cocos-mcp');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'panel-preferences.json');
    writeFileSync(`${file}.pending`, JSON.stringify({ locale }), { mode: 0o600 });
    renameSync(`${file}.pending`, file);
    this.locale = locale;
    this.applyMenu();
    return locale;
  }
  applyMenu(locale = this.read()): void {
    if (locale === this.menuLocale) return;
    const menu = this.major === 3 ? this.editor.Menu : this.editor.MainMenu;
    if (!menu) throw new Error('Creator menu API is unavailable');
    // 使用 Creator 管理的菜单模型，兼容旧版 Electron，保留其他菜单的回调和快捷键。
    for (const row of menuLabels.filter(row => this.major === 3 || row.message !== 'status')) {
      if (this.major === 3) {
        const entry = { label: row[this.menuLocale], message: row.message, target: 'cocos-mcp-creator3' };
        this.editor.Menu!.remove('CocosMCP', entry);
        this.editor.Menu!.add('CocosMCP', { ...entry, label: row[locale] });
      } else {
        this.editor.MainMenu!.remove(`CocosMCP/${row[this.menuLocale]}`);
        this.editor.MainMenu!.add('CocosMCP', { label: row[locale], message: `cocos-mcp-creator2:${row.message}` });
      }
    }
    menu.apply();
    this.menuLocale = locale;
  }
  restoreMenu(): void { this.applyMenu('zh'); }
  copy(text: unknown): void {
    if (typeof text !== 'string' || !text.length || text.length > 10_000_000) throw new Error('Invalid clipboard text');
    this.clipboard().writeText(text);
  }
}
