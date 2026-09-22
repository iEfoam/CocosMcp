import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { GameplayTemplates } from '../packages/gameplay2d-core/src/templates.js';

class FakeNode {
  isValid = true; active = true; name = 'node'; children: FakeNode[] = []; emitted: Array<{ event: string; args: unknown[] }> = [];
  listeners = new Map<string, Map<(...args: unknown[]) => void, unknown>>(); components = new Map<unknown, unknown>();
  setParent(parent: FakeNode) { if (!parent.children.includes(this)) parent.children.push(this); }
  destroy() { this.isValid = false; }
  emit(event: string, ...args: unknown[]) { this.emitted.push({ event, args }); for (const [listener, target] of this.listeners.get(event) ?? []) listener.apply(target, args); }
  on(event: string, callback: (...args: unknown[]) => void, target?: unknown) { if (!this.listeners.has(event)) this.listeners.set(event, new Map()); this.listeners.get(event)!.set(callback, target); }
  off(event: string, callback: (...args: unknown[]) => void) { this.listeners.get(event)?.delete(callback); }
  getComponent(type: unknown) { return this.components.get(type) ?? null; }
}
class FakeComponent { node = new FakeNode(); getComponent(type: unknown) { return this.node.getComponent(type); } }
class FakeButton { static EventType = { CLICK: 'click' }; }
class FakeCollider extends FakeNode { uuid = 'collider'; sensor = true; node = new FakeNode(); }
class TemplateRuntime {
  load(name: string): any {
    const source = new GameplayTemplates().source(name, 'TestGenerated').source;
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true } }).outputText;
    const exports: Record<string, new () => unknown> = {};
    const property = (...args: unknown[]) => args.length >= 2 ? undefined : () => undefined;
    const cc = { _decorator: { property, ccclass: () => (type: unknown) => type }, Component: FakeComponent, Node: FakeNode, Button: FakeButton, Collider2D: FakeCollider, Contact2DType: { BEGIN_CONTACT: 'begin', END_CONTACT: 'end' }, Label: class {}, JsonAsset: class {}, Prefab: class {}, instantiate: () => new FakeNode() };
    runInNewContext(js, { exports, require: (id: string) => { assert.equal(id, 'cc'); return cc; } }, { timeout: 1000 });
    return new exports.TestGenerated!();
  }
}
test('generated object pool enforces capacity, ignores foreign/double returns and destroys only owned nodes', () => {
  const pool = new TemplateRuntime().load('pool'); pool.prefab = {}; pool.capacity = 2;
  const first = pool.acquire(), second = pool.acquire(), foreign = new FakeNode();
  assert.equal(pool.acquire(), null); assert.equal(pool.release(foreign), false);
  assert.equal(pool.release(first), true); assert.equal(pool.release(first), false);
  assert.equal(pool.acquire(), first); assert.equal(first.active, true);
  pool.onDestroy(); assert.equal(first.isValid, false); assert.equal(second.isValid, false); assert.equal(foreign.isValid, true);
});
test('generated pool reclaims capacity when a borrowed node was destroyed by business logic', () => {
  const pool = new TemplateRuntime().load('pool'); pool.prefab = {}; pool.capacity = 1;
  const first = pool.acquire(); first.destroy(); const second = pool.acquire();
  assert.ok(second); assert.notEqual(first, second); assert.equal(pool.statistics.total, 1);
});
test('generated hitbox includes existing overlaps once per window and removes owned listeners', () => {
  const hitbox = new TemplateRuntime().load('hitbox'), sensor = new FakeCollider(), target = new FakeCollider(); target.uuid = 'target';
  hitbox.node.components.set(FakeCollider, sensor); hitbox.onEnable();
  sensor.emit('begin', sensor, target); assert.equal(hitbox.node.emitted.length, 0);
  hitbox.activate(); assert.equal(hitbox.node.emitted.length, 1);
  sensor.emit('begin', sensor, target); assert.equal(hitbox.node.emitted.length, 1);
  hitbox.activate(); assert.equal(hitbox.node.emitted.length, 2);
  sensor.emit('end', sensor, target); hitbox.activate(); assert.equal(hitbox.node.emitted.length, 2);
  hitbox.onDisable(); assert.equal(sensor.listeners.get('begin')?.size, 0); assert.equal(sensor.listeners.get('end')?.size, 0);
});
test('generated UI forwards action names once per enable cycle and preserves foreign listeners', () => {
  const panel = new TemplateRuntime().load('ui'), button = new FakeNode(); button.name = 'Resume'; button.components.set(FakeButton, new FakeButton()); panel.node.children.push(button);
  let external = 0; button.on('click', () => external++);
  panel.onEnable(); button.emit('click'); panel.onDisable(); panel.onEnable(); button.emit('click'); panel.onDisable(); button.emit('click');
  assert.equal(panel.node.emitted.filter((row: { event: string }) => row.event === 'ui-action').length, 2); assert.equal(external, 3);
});
test('generated dialogue validates references before accepting data and follows explicit branches', () => {
  const dialogue = new TemplateRuntime().load('dialogue'); dialogue.label = { string: '' };
  dialogue.data = { json: { start: 'a', rows: [{ id: 'a', text: 'Hello', choices: [{ label: 'Next', next: 'missing' }] }] } };
  assert.throws(() => dialogue.begin(), /reference/); assert.equal(dialogue.label.string, '');
  dialogue.data.json.rows[0].choices[0].next = 'b'; dialogue.data.json.rows.push({ id: 'b', text: 'Bye', choices: [{ label: 'Close', next: null }] });
  dialogue.begin(); assert.equal(dialogue.label.string, 'Hello'); dialogue.choose(0); assert.equal(dialogue.label.string, 'Bye');
  dialogue.choose(0); assert.equal(dialogue.node.emitted.at(-1).event, 'dialogue-complete'); assert.throws(() => dialogue.choose(0));
});
