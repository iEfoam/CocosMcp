import { PanelDom } from './panel-dom.js';

interface DropdownOption { value: string; label: string; tone?: string }
interface OpenDropdown { trigger: HTMLButtonElement; menu: HTMLElement; home: HTMLElement; rows: HTMLButtonElement[]; index: number }

/** 不依赖编辑器的原生 select；弹层移到面板根部，避免被滚动卡片裁切。 */
export class PanelDropdown {
  private static sequence = 0;
  private readonly prefix = `cocos-dropdown-${++PanelDropdown.sequence}`;
  private current: OpenDropdown | undefined;
  private search = '';
  private searchedAt = 0;
  private disposed = false;
  private readonly outside = (event: Event): void => {
    const current = this.current;
    if (!current) return;
    const path = event.composedPath();
    if (!path.includes(current.trigger) && !path.includes(current.menu)) this.close(false);
  };
  private readonly reposition = (): void => { if (this.current) this.position(this.current); };
  private readonly lostFocus = (): void => { this.close(false); };

  constructor(private readonly root: HTMLElement, private readonly dom: PanelDom,
    private readonly changed: (id: string, value: string) => void, private readonly closed: () => void) {
    root.ownerDocument.addEventListener('mousedown', this.outside, true);
    root.ownerDocument.addEventListener('click', this.outside, true);
    root.addEventListener('scroll', this.reposition, true);
    root.ownerDocument.defaultView?.addEventListener('resize', this.reposition);
    root.ownerDocument.defaultView?.addEventListener('blur', this.lostFocus);
  }
  get expanded(): boolean { return Boolean(this.current); }
  private escape(value: string): string {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
  }
  markup(id: string, label: string, value: string, rows: DropdownOption[], disabled = false): string {
    const identity = this.escape(`${this.prefix}-${id}`), selected = rows.find(row => row.value === value) ?? rows[0];
    return `<div class="dropdown" data-key="dropdown-${this.escape(id)}" data-dropdown="${this.escape(id)}"><button type="button" class="dropdown-trigger" data-dropdown-trigger="${this.escape(id)}" data-value="${this.escape(value)}" role="combobox" aria-label="${this.escape(label)}" aria-haspopup="listbox" aria-expanded="false" aria-controls="${identity}" ${disabled ? 'disabled' : ''}>
      ${selected?.tone ? `<i class="dropdown-dot ${this.escape(selected.tone)}" aria-hidden="true"></i>` : ''}<span class="dropdown-label">${this.escape(selected?.label ?? '')}</span><svg class="dropdown-chevron" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
      <div id="${identity}" class="dropdown-popup" data-dropdown-popup="${this.escape(id)}" role="listbox" aria-label="${this.escape(label)}" hidden>${rows.map((row, index) => `<button type="button" class="dropdown-option" id="${identity}-${index}" role="option" tabindex="-1" aria-selected="${row.value === value}" data-dropdown-value="${this.escape(row.value)}">${row.tone ? `<i class="dropdown-dot ${this.escape(row.tone)}" aria-hidden="true"></i>` : ''}<span class="dropdown-label">${this.escape(row.label)}</span><span class="dropdown-check" aria-hidden="true">${row.value === value ? '✓' : ''}</span></button>`).join('')}</div></div>`;
  }
  bind(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-dropdown-trigger]').forEach(trigger => {
      this.dom.on(trigger, 'click', () => { if (this.current?.trigger === trigger) this.close(true); else this.open(trigger); });
      this.dom.on(trigger, 'keydown', event => this.key(event as KeyboardEvent, trigger));
    });
  }
  private open(trigger: HTMLButtonElement): void {
    if (trigger.disabled || this.disposed) return;
    if (this.current) this.close(false);
    const home = trigger.parentElement!, menu = home.querySelector<HTMLElement>('[data-dropdown-popup]');
    if (!menu) return;
    const rows = Array.from(menu.querySelectorAll<HTMLButtonElement>('[data-dropdown-value]'));
    if (!rows.length) return;
    const index = Math.max(0, rows.findIndex(row => row.dataset.dropdownValue === trigger.dataset.value));
    const current = { trigger, menu, home, rows, index };
    this.current = current; this.search = '';
    this.root.appendChild(menu); menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true'); trigger.focus();
    rows.forEach((row, index) => {
      // 选项点击保持组合框焦点，Esc 和 Tab 的后续行为才不会落到隐藏节点上。
      this.dom.on(row, 'mousedown', event => event.preventDefault());
      this.dom.on(row, 'click', () => this.choose(index));
    });
    this.position(current); this.highlight();
  }
  private position(current: OpenDropdown): void {
    const bounds = this.root.getBoundingClientRect(), anchor = current.trigger.getBoundingClientRect(), view = this.root.ownerDocument.defaultView;
    const leftEdge = Math.max(0, bounds.left) + 8, rightEdge = Math.min(view?.innerWidth || bounds.right, bounds.right) - 8;
    const topEdge = Math.max(0, bounds.top) + 8, bottomEdge = Math.min(view?.innerHeight || bounds.bottom, bounds.bottom) - 8;
    if (anchor.bottom <= topEdge || anchor.top >= bottomEdge) { this.close(false); return; }
    const below = Math.max(0, bottomEdge - anchor.bottom - 6), above = Math.max(0, anchor.top - topEdge - 6);
    const desired = Math.min(240, current.rows.length * 34 + 10), upward = below < desired && above > below;
    const height = Math.min(desired, upward ? above : below), width = Math.max(0, Math.min(Math.max(anchor.width, 180), rightEdge - leftEdge));
    current.menu.style.width = `${width}px`; current.menu.style.maxHeight = `${height}px`;
    current.menu.style.left = `${Math.max(leftEdge, Math.min(anchor.left, rightEdge - width))}px`;
    current.menu.style.top = `${upward ? anchor.top - height - 6 : anchor.bottom + 6}px`;
  }
  private highlight(): void {
    const current = this.current;
    if (!current) return;
    current.rows.forEach((row, index) => row.classList.toggle('highlighted', index === current.index));
    const row = current.rows[current.index];
    if (!row) return;
    current.trigger.setAttribute('aria-activedescendant', row.id);
    if (row.offsetTop < current.menu.scrollTop) current.menu.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > current.menu.scrollTop + current.menu.clientHeight) current.menu.scrollTop = row.offsetTop + row.offsetHeight - current.menu.clientHeight;
  }
  private choose(index: number): void {
    const current = this.current, row = current?.rows[index];
    if (!current || !row || current.trigger.disabled) return;
    const id = current.trigger.dataset.dropdownTrigger!, value = row.dataset.dropdownValue!;
    this.close(true, false); this.changed(id, value);
  }
  private key(event: KeyboardEvent, trigger: HTMLButtonElement): void {
    if (trigger.disabled) return;
    const key = event.key;
    if (key === 'Tab') { this.close(false); return; }
    if (key === 'Escape') { if (this.current) { event.preventDefault(); event.stopPropagation(); this.close(true); } return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
      event.preventDefault(); event.stopPropagation();
      if (this.current?.trigger !== trigger) { this.open(trigger); if (key === 'Home' || key === 'End') this.key(event, trigger); return; }
      const current = this.current;
      if (key === 'Enter' || key === ' ') { this.choose(current.index); return; }
      current.index = key === 'Home' ? 0 : key === 'End' ? current.rows.length - 1 : (current.index + (key === 'ArrowUp' ? -1 : 1) + current.rows.length) % current.rows.length;
      this.highlight();
    } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault(); if (this.current?.trigger !== trigger) this.open(trigger);
      const current = this.current; if (!current) return;
      const now = Date.now(); this.search = (now - this.searchedAt < 700 ? this.search : '') + key.toLowerCase(); this.searchedAt = now;
      const index = current.rows.findIndex(row => row.querySelector('.dropdown-label')?.textContent?.trim().toLowerCase().startsWith(this.search));
      if (index >= 0) { current.index = index; this.highlight(); }
    }
  }
  close(focus = false, notify = true): void {
    const current = this.current; if (!current) return;
    this.current = undefined; current.menu.hidden = true; current.home.appendChild(current.menu);
    current.trigger.setAttribute('aria-expanded', 'false'); current.trigger.removeAttribute('aria-activedescendant');
    if (focus) current.trigger.focus();
    if (notify && !this.disposed) this.closed();
  }
  dispose(): void {
    this.disposed = true; this.close(false, false);
    this.root.ownerDocument.removeEventListener('mousedown', this.outside, true);
    this.root.ownerDocument.removeEventListener('click', this.outside, true);
    this.root.removeEventListener('scroll', this.reposition, true);
    this.root.ownerDocument.defaultView?.removeEventListener('resize', this.reposition);
    this.root.ownerDocument.defaultView?.removeEventListener('blur', this.lostFocus);
  }
  static readonly style = `
    .dropdown { min-width:0; }
    .dropdown-trigger { display:flex; align-items:center; width:100%; height:36px; padding:0 12px; border:1px solid #3b4252; border-radius:8px; background:#1b1e26; color:#e4e9f6; font:inherit; text-align:left; cursor:pointer; }
    .dropdown-trigger:hover:not(:disabled) { border-color:#7387ba; background:#252b38; }
    .dropdown-trigger:focus { outline:2px solid rgba(146,166,255,.65); outline-offset:2px; }
    .dropdown-trigger:disabled { opacity:.45; cursor:default; }
    .dropdown-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .dropdown-chevron { flex-shrink:0; margin-left:10px; color:#a9b6d1; }
    .dropdown-trigger[aria-expanded="true"] .dropdown-chevron { transform:rotate(180deg); }
    .dropdown-popup { position:fixed; z-index:1000; padding:4px; overflow-y:auto; border:1px solid #4b5770; border-radius:9px; background:#242b39; box-shadow:0 8px 24px rgba(0,0,0,.38); color:#e4e9f6; font:inherit; }
    .dropdown-popup[hidden] { display:none; }
    .dropdown-option { display:flex; align-items:center; width:100%; min-height:34px; padding:6px 8px; border:0; border-radius:5px; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
    .dropdown-option:hover,.dropdown-option.highlighted { background:rgba(135,157,226,.18); }
    .dropdown-option[aria-selected="true"] { color:#cbd7ff; }
    .dropdown-check { flex-shrink:0; width:16px; margin-left:10px; color:#9aafff; text-align:center; }
    .dropdown-dot { flex-shrink:0; width:6px; height:6px; margin-right:8px; border-radius:50%; background:#a5b4d6; }
    .dropdown-dot.error { background:#ff95a2; } .dropdown-dot.warn { background:#efc77c; } .dropdown-dot.info { background:#8eb6ff; }
  `;
}
