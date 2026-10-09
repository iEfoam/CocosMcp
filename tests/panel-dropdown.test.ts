import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { PanelDom } from '../extensions/shared/panel-dom.js';
import { PanelDropdown } from '../extensions/shared/panel-dropdown.js';

class DropdownHarness {
  readonly window = parseHTML('<html><body><div id="root"></div><button id="outside">outside</button></body></html>').window;
  readonly root = this.window.document.querySelector('#root') as unknown as HTMLElement;
  readonly dom = new PanelDom();
  value = 'stdio';
  changes: string[] = [];
  renders = 0;
  focused: HTMLElement | null = null;
  readonly dropdown = new PanelDropdown(this.root, this.dom, (_id, value) => { this.value = value; this.changes.push(value); this.render(); }, () => this.render());
  constructor() {
    this.root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 500, width: 600, height: 500 }) as DOMRect;
    this.render();
  }
  get trigger(): HTMLButtonElement { return this.root.querySelector('[data-dropdown-trigger="mode"]')!; }
  get menu(): HTMLElement { return this.root.querySelector('[data-dropdown-popup="mode"]')!; }
  render(disabled = false): void {
    this.renders++;
    this.dom.update(this.root, this.dropdown.markup('mode', '接入方式', this.value, [{ value: 'stdio', label: '本机 stdio（推荐）' }, { value: 'http', label: 'Streamable HTTP' }], disabled));
    this.trigger.getBoundingClientRect = () => ({ left: 30, top: 70, right: 250, bottom: 106, width: 220, height: 36 }) as DOMRect;
    this.trigger.focus = () => { this.focused = this.trigger; };
    this.dropdown.bind();
  }
  key(value: string): Event {
    const event = new this.window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value }); this.trigger.dispatchEvent(event); return event;
  }
  outside(): void { (this.window.document.querySelector('#outside') as unknown as HTMLButtonElement).click(); }
}

test('custom dropdown commits keyboard choice, cancels Escape, and closes on Tab without trapping focus', () => {
  const harness = new DropdownHarness();
  try {
    harness.key('ArrowDown'); assert.equal(harness.dropdown.expanded, true);
    assert.equal(harness.trigger.getAttribute('aria-expanded'), 'true');
    harness.key('End'); assert.equal(harness.value, 'stdio');
    assert.equal(harness.menu.querySelector('.highlighted')?.getAttribute('data-dropdown-value'), 'http');
    harness.key('Escape'); assert.equal(harness.dropdown.expanded, false); assert.deepEqual(harness.changes, []);
    assert.equal(harness.focused, harness.trigger);
    harness.key(' '); harness.key('ArrowUp'); harness.key('Enter');
    assert.equal(harness.value, 'http'); assert.deepEqual(harness.changes, ['http']);
    assert.equal(harness.trigger.getAttribute('aria-activedescendant'), null);
    harness.key('Home'); assert.equal(harness.menu.querySelector('.highlighted')?.getAttribute('data-dropdown-value'), 'stdio');
    const tab = harness.key('Tab'); assert.equal(tab.defaultPrevented, false); assert.equal(harness.dropdown.expanded, false);
    assert.equal(harness.value, 'http');
  } finally { harness.dropdown.dispose(); }
});

test('custom dropdown click, text search, outside dismissal and disabled controls preserve selection', () => {
  const harness = new DropdownHarness();
  try {
    harness.key('s'); harness.key('Enter'); assert.equal(harness.value, 'http');
    harness.trigger.click(); harness.menu.querySelector<HTMLButtonElement>('[data-dropdown-value="stdio"]')!.click();
    assert.equal(harness.value, 'stdio'); assert.equal(harness.menu.hidden, true);
    harness.trigger.click(); harness.key('End'); harness.outside(); assert.equal(harness.value, 'stdio');
    harness.render(true); harness.trigger.click(); harness.key('ArrowDown'); assert.equal(harness.dropdown.expanded, false);
    assert.equal(harness.root.querySelector('select'), null);
  } finally { harness.dropdown.dispose(); }
});

test('custom popup stays inside the panel, opens upward near the footer and stops listening after disposal', () => {
  const harness = new DropdownHarness();
  harness.trigger.getBoundingClientRect = () => ({ left: 480, top: 450, right: 700, bottom: 486, width: 220, height: 36 }) as DOMRect;
  harness.trigger.click();
  assert.equal(harness.menu.parentElement, harness.root);
  assert.equal(harness.menu.style.left, '372px'); assert.equal(harness.menu.style.width, '220px');
  assert.equal(harness.menu.style.top, '366px'); assert.equal(harness.menu.style.maxHeight, '78px');
  harness.dropdown.dispose(); assert.equal(harness.menu.hidden, true);
  const count = harness.renders; harness.outside(); harness.key('ArrowDown');
  assert.equal(harness.renders, count); assert.equal(harness.dropdown.expanded, false);
});

test('custom dropdown escapes labels, values and identifiers without adding HTML from their text', () => {
  const harness = new DropdownHarness();
  try {
    const html = harness.dropdown.markup('"unsafe', '<img src=x>', '"value', [{ value: '"value', label: '<script>x</script>' }]);
    harness.dom.update(harness.root, html);
    assert.equal(harness.root.querySelector('img,script'), null);
    assert.equal(harness.root.querySelector('[data-dropdown-value]')?.getAttribute('data-dropdown-value'), '"value');
    assert.equal(harness.root.querySelector('[role="combobox"]')?.getAttribute('aria-label'), '<img src=x>');
  } finally { harness.dropdown.dispose(); }
});
