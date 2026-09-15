import assert from 'node:assert/strict';
import test from 'node:test';
import { UiInspector } from '../packages/runtime3-bridge/src/ui.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
import type { RuntimeObject } from '../packages/runtime3-bridge/src/access.js';

class Vec { constructor(public x = 0, public y = 0, public z = 0) {} }
class UiTransform {
  static __props__ = ['contentSize', 'anchorPoint'];
  contentSize = { width: 100, height: 50 }; anchorPoint = { x: 0.5, y: 0.5 };
  convertToWorldSpaceAR(value: Vec): Vec { return new Vec(value.x + 10, value.y + 20, value.z); }
  convertToNodeSpaceAR(value: Vec): Vec { return new Vec(value.x - 10, value.y - 20, value.z); }
}
class InspectorHarness {
  calls = 0; transform = new UiTransform();
  script: RuntimeObject = { uuid: 'script', type: 'Menu', onClick: () => this.calls++ };
  button: RuntimeObject = { uuid: 'button', type: 'cc.Button', enabledInHierarchy: true, interactable: true, clickEvents: [] };
  child: RuntimeObject = { uuid: 'child', name: 'Child', activeInHierarchy: true, children: [], getComponent: (type: unknown) => type === UiTransform ? this.transform : type === 'Menu' ? this.script : null, getComponents: () => [this.button, this.script] };
  root: RuntimeObject = { uuid: 'root', name: 'Root', activeInHierarchy: true, children: [this.child], getComponent: () => null, getComponents: () => [] };
  inspector = new SceneInspector({ major: 3, editor: true, cc: { UITransform: UiTransform, Vec3: Vec, director: { getScene: () => this.root }, js: {
    getClassName: (value: RuntimeObject) => value.type ?? 'Menu', getClassById: () => ({ type: 'Menu' }),
  } } });
  constructor() { this.child.parent = this.root; this.script.node = this.child; }
}

test('UI geometry returns transformed corners without executing layouts or callbacks', () => {
  const h = new InspectorHarness(), result = Json.object(new UiInspector(h.inspector).layout({ rootId: 'root' }));
  const row = (result.rows as JsonObject[])[0]!;
  assert.deepEqual(row.bounds, { x: -40, y: -5, width: 100, height: 50 }); assert.equal(h.calls, 0);
  h.transform.contentSize.width = 0;
  assert.equal((Json.object(new UiInspector(h.inspector).layout({ rootId: 'root' })).diagnostics as JsonObject[])[0]!.code, 'ZERO_SIZE');
});

test('UI event binding validates exact component and static inspection resolves serialized class IDs without invocation', () => {
  const h = new InspectorHarness(), tools = new UiInspector(h.inspector);
  assert.deepEqual(tools.eventBindings({ events: [{ componentId: 'script', handler: 'onClick', customEventData: 'ok' }] }), [{ target: { uuid: 'child' }, component: 'Menu', handler: 'onClick', customEventData: 'ok' }]);
  assert.throws(() => tools.eventBindings({ events: [{ componentId: 'script', handler: 'constructor' }] }), /public method/);
  h.button.clickEvents = [{ target: h.child, _componentId: 'class-id', component: '', handler: 'onClick' }];
  const result = Json.object(tools.interaction({ rootId: 'root' }));
  assert.deepEqual(result.diagnostics, []); assert.equal(result.runtimeClickVerified, false); assert.equal(h.calls, 0);
  h.button.clickEvents = [{ target: h.child, component: 'Menu', handler: 'missing' }];
  assert.equal((Json.object(tools.interaction({ rootId: 'root' })).diagnostics as JsonObject[])[0]!.code, 'INVALID_CLICK_HANDLER');
});

test('expanded UI inspection detects broken events, page membership and rich-text callbacks without invoking handlers', () => {
  const h = new InspectorHarness(), tools = new UiInspector(h.inspector);
  const page = { uuid: 'page', parent: h.root };
  const toggle = { uuid: 'toggle', type: 'cc.Toggle', checkEvents: [{ target: h.child, _componentId: 'missing', handler: 'onClick' }] };
  const edit = { uuid: 'edit', type: 'cc.EditBox', textChanged: [{ target: h.child, component: 'Menu', handler: 'missing' }], placeholderLabel: {} };
  const pages = { uuid: 'pages', type: 'cc.PageView', content: h.child, getPages: () => [page, page], pageEvents: [] };
  const rich = { uuid: 'rich', type: 'cc.RichText', string: '<on click="onClick">text</on>' };
  h.root.getComponents = () => [toggle, edit, pages, rich];
  (h.inspector.environment.cc.js as RuntimeObject).getClassById = () => null;
  const result = Json.object(tools.interaction({ rootId: 'root' }));
  const codes = (result.diagnostics as JsonObject[]).map(row => row.code);
  for (const code of ['INVALID_UI_EVENT_HANDLER', 'INVALID_EDITBOX_LABEL', 'MISSING_EDITBOX_TEXT_LABEL', 'INVALID_PAGEVIEW_PAGE', 'RICHTEXT_INLINE_EVENT_REQUIRES_REVIEW']) assert.ok(codes.includes(code), code);
  assert.equal(h.calls, 0); assert.equal(result.runtimeClickVerified, false);
});

test('persisted UI events reject ambiguous same-type script instances before creating bindings', () => {
  const h = new InspectorHarness(), second = { ...h.script, uuid: 'second' };
  h.child.getComponents = () => [h.button, h.script, second];
  assert.throws(() => new UiInspector(h.inspector).eventBindings({ events: [{ componentId: 'script', handler: 'onClick' }] }), { code: 'AMBIGUOUS_TARGET' });
  assert.equal(h.calls, 0);
});

test('UI checkpoint preparation flushes only the target native Label layout synchronously', () => {
  const h = new InspectorHarness();
  class Label {
    uuid = 'label'; type = 'cc.Label'; calls: boolean[] = [];
    updateRenderData(force: boolean): void { this.calls.push(force); h.transform.contentSize.width = 240; }
  }
  const label = new Label(); h.inspector.environment.cc.Label = Label;
  h.child.getComponents = () => [label, h.script];
  assert.deepEqual(h.inspector.execute('ui.flush_label', [{ componentId: 'label' }]), { flushed: true });
  assert.equal(h.transform.contentSize.width, 240); assert.deepEqual(label.calls, [true]);
  assert.deepEqual(h.inspector.execute('ui.flush_label', [{ componentId: 'script' }]), { flushed: false });
  assert.equal(h.calls, 0);
});
