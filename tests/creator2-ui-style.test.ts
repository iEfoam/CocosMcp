import assert from 'node:assert/strict';
import { OutputContracts } from '../packages/capability-catalog/src/output-contracts.js';
import test from 'node:test';
import { Creator2Ui } from '../extensions/creator2/src/ui.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';

class Color {
  constructor(public r = 255, public g = 255, public b = 255, public a = 255) {}
  clone(): Color { return new Color(this.r, this.g, this.b, this.a); }
}
class Label {
  uuid = 'label'; kind = 'cc.Label'; horizontalAlign = 0; verticalAlign = 0; spacingX = 0;
}
class Button {
  uuid = 'button'; kind = 'cc.Button'; transition = 0; normalColor = new Color(); pressedColor = new Color();
}
class Layout {
  uuid = 'layout'; kind = 'cc.Layout'; startAxis = 0; horizontalDirection = 0; verticalDirection = 1; affectedByScale = false;
  updateLayout(): void {}
}
class Widget {
  uuid = 'widget'; kind = 'cc.Widget'; top = 0; isAbsoluteTop = true; isAlignTop = false;
  updateAlignment(): void {}
}
class UiNode {
  uuid: string; children: UiNode[] = []; parent: UiNode | undefined; color = new Color(); opacity = 255;
  components: Array<Label | Button | Layout | Widget> = [];
  constructor(public name = 'Canvas') { this.uuid = name; }
  addChild(node: UiNode): void { node.parent = this; this.children.push(node); }
  addComponent(type: new () => Label | Button | Layout | Widget): void { this.components.push(new type()); }
  getComponent(type: new () => Label | Button | Layout | Widget): unknown { return this.components.find(c => c instanceof type); }
  getComponents(): unknown[] { return this.components; }
  removeFromParent(): void { if (this.parent) this.parent.children = this.parent.children.filter(row => row !== this); }
  destroy(): void {}
}
class Creator2StyleHarness {
  root = new UiNode(); recorded: string[] = []; failCommit = false;
  classes: Record<string, unknown> = { 'cc.Label': Label, 'cc.Button': Button, 'cc.Layout': Layout, 'cc.Widget': Widget };
  inspector = new SceneInspector({ major: 2, cc: { Node: UiNode, Color, director: { getScene: () => this.root }, js: {
    getClassByName: (name: string) => this.classes[name], getClassName: (object: { kind?: string }) => object.kind ?? 'cc.Node',
  } } });
  service = new Creator2Ui(this.inspector, {
    recordObject: (id: string) => this.recorded.push(id), recordCreateNode: (id: string) => this.recorded.push(id),
    commit: () => { if (this.failCommit) throw new Error('Injected commit failure'); }, cancel: () => {},
  }, async () => { throw new Error('No assets expected'); });
  color: JsonObject = { r: 10, g: 20, b: 30, a: 255 };
  document: JsonObject = { version: 1, root: { key: 'panel', name: 'Panel', components: [
    { type: 'cc.Label', properties: { color: this.color, horizontalAlign: 1, verticalAlign: 2, spacingX: 2 } },
    { type: 'cc.UIOpacity', properties: { opacity: 180 } },
    { type: 'cc.Button', properties: { transition: 1, pressedColor: { r: 20, g: 30, b: 40, a: 100 } } },
    { type: 'cc.Layout', properties: { startAxis: 1, horizontalDirection: 1, verticalDirection: 0, affectedByScale: true } },
    { type: 'cc.Widget', properties: { top: 0.1, isAbsoluteTop: false, isAlignTop: true } },
  ] } };
  async build(): Promise<JsonObject> {
    const result = Json.object(await this.service.execute('ui.build', { parentId: 'Canvas', document: this.document }));
    new OutputContracts().validate('ui.build', result); return result;
  }
  update(): JsonObject { return { rootId: 'Panel', mapping: [{ key: 'panel', nodeId: 'Panel' }], document: this.document }; }
}

test('Creator 2 style creation uses native Color, maps renderer color to Node and preserves opacity', async () => {
  const h = new Creator2StyleHarness();
  await h.service.execute('ui.plan', { parentId: 'Canvas', document: h.document }); assert.equal(h.root.children.length, 0);
  const result = await h.build(), panel = h.root.children[0]!;
  assert.equal(result.needsSave, true); assert.equal(panel.opacity, 180);
  assert.ok(panel.color instanceof Color); assert.deepEqual(panel.color, new Color(10, 20, 30, 255));
  const label = panel.getComponent(Label) as Label; assert.equal('color' in label, false); assert.equal(label.horizontalAlign, 1); assert.equal(label.verticalAlign, 2);
  const button = panel.getComponent(Button) as Button; assert.ok(button.pressedColor instanceof Color); assert.equal(button.pressedColor.a, 100);
  assert.equal((panel.getComponent(Layout) as Layout).startAxis, 1);
  assert.equal((panel.getComponent(Widget) as Widget).top, 0.1);
});

test('Creator 2 diff targets node color and native update rollback restores cloned color and UUIDs', async () => {
  const h = new Creator2StyleHarness(); await h.build(); const panel = h.root.children[0]!;
  const components = Json.object(h.document.root).components as JsonObject[];
  Json.object(components[0]!.properties).color = { r: 70, g: 80, b: 90, a: 255 };
  // 未声明的透明度必须保持原值，不能被颜色更新重置为 255。
  Json.object(h.document.root).components = components.filter(row => row.type !== 'cc.UIOpacity');
  const diff = Json.object(await h.service.execute('ui.diff', h.update()));
  assert.equal((diff.rows as JsonObject[]).find(row => row.property === 'color')!.objectId, panel.uuid);
  assert.deepEqual(panel.color, new Color(10, 20, 30, 255));
  h.failCommit = true; await assert.rejects(h.service.execute('ui.apply', h.update()), /commit failure/);
  assert.deepEqual(panel.color, new Color(10, 20, 30, 255)); assert.equal(panel.opacity, 180);
  h.failCommit = false; await h.service.execute('ui.apply', h.update());
  assert.deepEqual(panel.color, new Color(70, 80, 90, 255)); assert.equal(panel.opacity, 180);
  assert.equal(h.root.children[0], panel); assert.ok(h.recorded.includes(panel.uuid));
});

test('Creator 2 rejects unsupported renderer alpha before creation or modifying an existing tree', async () => {
  const h = new Creator2StyleHarness(); h.color.a = 100;
  for (const method of ['ui.plan', 'ui.build']) await assert.rejects(h.service.execute(method, { parentId: 'Canvas', document: h.document }), /use cc.UIOpacity/);
  assert.equal(h.root.children.length, 0); assert.deepEqual(h.recorded, []);
  h.color.a = 255; await h.build(); h.color.a = 100;
  for (const method of ['ui.diff', 'ui.apply']) await assert.rejects(h.service.execute(method, h.update()), /use cc.UIOpacity/);
  assert.equal(h.root.children[0]!.color.a, 255);
});
