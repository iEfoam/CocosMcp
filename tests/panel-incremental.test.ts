import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { PanelDom } from '../extensions/shared/panel-dom.js';
import { PanelLogCache } from '../extensions/shared/panel-log-cache.js';
import { EditorBridge } from '../packages/editor-bridge/src/index.js';

test('DOM updates preserve keyed nodes, focus and scroll while replacing event handlers', () => {
  const { document } = parseHTML('<html><body><main></main></body></html>');
  const root = document.querySelector('main') as unknown as HTMLElement, dom = new PanelDom();
  dom.update(root, '<input data-search value="a"><div data-key="one">one</div><div data-key="two">two</div>');
  const input = root.firstChild as HTMLInputElement, one = root.querySelector('[data-key="one"]')!;
  Object.defineProperty(document, 'activeElement', { value: input });
  root.scrollTop = 91; input.value = 'typing';
  let calls = 0;
  dom.on(one, 'click', () => calls++); dom.on(one, 'click', () => calls += 2);
  dom.update(root, '<input data-search value="a"><div data-key="two">updated</div><div data-key="one">one</div>');
  assert.equal(root.firstChild, input); assert.equal(document.activeElement, input); assert.equal(input.value, 'typing');
  assert.equal(root.scrollTop, 91); assert.equal(root.querySelector('[data-key="one"]'), one);
  one.dispatchEvent(new document.defaultView!.Event('click')); assert.equal(calls, 2);
  assert.equal(root.querySelector('[data-key="two"]')!.textContent, 'updated');
});

test('panel cursor returns only appended logs, evicts dropped rows and resets on a new bridge epoch', () => {
  const adapter = { major: 3 as const, supportedCapabilities: () => [], revision: async () => '', execute: async () => null, dispose: async () => {} };
  const bridge = new EditorBridge(adapter, process.cwd(), '3.8.8'), cache = new PanelLogCache();
  bridge.log('info', 'first'); const first = bridge.panelState(); assert.equal(cache.accept(first).length, 1);
  assert.equal(bridge.panelState(cache.request()).logs.length, 0);
  bridge.log('info', 'second'); const delta = bridge.panelState(cache.request());
  assert.equal(delta.logWindow?.reset, false); assert.equal(delta.logs.length, 1); assert.equal(cache.accept(delta).length, 2);
  for (let i = 0; i < 5001; i++) bridge.log('info', `event-${i}`);
  const recent = cache.accept(bridge.panelState(cache.request())); assert.equal(recent.length, 5000); assert.equal(recent[0]!.sequence, 4);
  const restarted = new EditorBridge(adapter, process.cwd(), '3.8.8'); restarted.log('info', 'new');
  const reset = restarted.panelState(cache.request()); assert.equal(reset.logWindow?.reset, true); assert.equal(cache.accept(reset).length, 1);
  assert.equal(bridge.panelState('bad cursor').logWindow?.reset, true);
});
