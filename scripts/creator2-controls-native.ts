import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';

const project = resolve('.codex-work/build/creator2-test-project'), registry = new ProjectRegistry(), { projectId } = await registry.add(project);
const gateway = new RuntimeGateway(registry), gatewayPort = await gateway.start(), app = new CocosApplication(registry, undefined, undefined, true, gateway);
const rows: JsonObject[] = []; let preview = false;
const call = async (id: string, params: JsonObject = {}): Promise<JsonObject> => { const result = Json.object((await app.execute({ projectId, capabilityId: id, params })).result); rows.push({ id, result: id === 'preview.input' ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'dataUrl')) : result }); console.log(`PASS ${id}`); return result; };
try {
  const location = await call('asset.location', { url: 'db://assets/Scenes/Creator2Controls.fire' });
  if ((await call('scene.query')).dirty) await call('scene.save');
  if (location.targetExists) await call('scene.open', { uuid: (await call('asset.resolve', { reference: location.url! })).uuid! });
  else await call('scene.create', { url: location.url! });
  const old = (await call('scene.hierarchy', { limit: 1000 })).rows as JsonObject[];
  for (const row of old) if (String(row.name).startsWith('ControlsCoverage-')) await call('node.set', { nodeId: row.nodeId!, properties: { active: false } });
  const scene = Json.object((await call('scene.query')).scene).sceneId!;
  const node = async (parentId: import('../packages/contracts/src/index.js').JsonValue, name: string, width = 200, height = 100) => {
    const nodeId = (await call('node.create', { parentId, name })).nodeId!;
    await call('node.set', { nodeId, properties: { width, height } }); return nodeId;
  };
  const root = await node(scene, `ControlsCoverage-${Date.now()}`, 800, 600);
  const canvas = (await call('component.add', { nodeId: root, type: 'cc.Canvas' })).componentId!;
  await call('component.set', { componentId: canvas, properties: { designResolution: { width: 800, height: 600 }, fitWidth: true, fitHeight: true } });
  const ids: Record<string, import('../packages/contracts/src/index.js').JsonValue> = {};
  for (const type of ['Slider', 'Toggle', 'EditBox', 'ScrollView', 'PageView']) {
    const nodeId = await node(root, type);
    ids[type] = nodeId;
    const positions: Record<string, number[]> = { Toggle: [0, 0], Slider: [0, 150], EditBox: [0, -160], ScrollView: [-230, 0], PageView: [-230, -160] };
    await call('node.set', { nodeId, properties: { position: { x: positions[type]![0]!, y: positions[type]![1]!, z: 0 } } });
    const componentId = (await call('component.add', { nodeId, type: `cc.${type}` })).componentId!;
    if (type === 'Slider') {
      const handle = await node(nodeId, 'Handle', 20, 30);
      const handleComponent = (await call('component.add', { nodeId: handle, type: 'cc.Button' })).componentId!;
      await call('component.set', { componentId, properties: { handle: { uuid: handleComponent } } });
    }
    if (type === 'EditBox') {
      const labelNode = await node(nodeId, 'Text', 180, 80);
      const label = (await call('component.add', { nodeId: labelNode, type: 'cc.Label' })).componentId!;
      await call('component.set', { componentId, properties: { maxLength: 4, textLabel: { uuid: label } } });
    }
    if (type === 'ScrollView' || type === 'PageView') {
      const content = await node(nodeId, 'Content', 600, type === 'PageView' ? 100 : 300);
      await call('component.set', { componentId, properties: { content: { uuid: content } } });
      if (type === 'PageView') {
        const layout = (await call('component.add', { nodeId: content, type: 'cc.Layout' })).componentId!;
        await call('component.set', { componentId: layout, properties: { type: 1, resizeMode: 1, spacingX: 0 } });
        const pages = [];
        for (let index = 0; index < 3; index++) pages.push({ uuid: await node(content, `Page${index}`) });
        await call('component.set', { componentId, properties: { _pages: pages } });
      }
    }
  }
  const blocker = await node(root, 'InputBlocker', 220, 120);
  await call('component.add', { nodeId: blocker, type: 'cc.BlockInputEvents' });
  await call('node.set', { nodeId: blocker, properties: { active: false } });
  await call('scene.save'); await call('preview.start', { width: 800, height: 600, visible: true }); preview = true;
  await call('shader.preview.connect', { gatewayPort });
  const hierarchy = (await call('runtime.hierarchy', { limit: 1000 })).rows as JsonObject[];
  const component = (type: string) => (hierarchy.find(row => row.nodeId === ids[type])!.components as JsonObject[]).find(row => row.type === `cc.${type}`)!.componentId!;
  for (const type of Object.keys(ids)) await call('runtime.control.inspect', { componentId: component(type) });
  const slider = await call('runtime.control.slider', { componentId: component('Slider'), progress: 0.75 });
  assert.equal(slider.accepted, true); assert.equal(Json.object(slider.after).progress, 0.75);
  const toggle = await call('runtime.control.toggle', { componentId: component('Toggle'), checked: false });
  assert.equal(toggle.accepted, true); assert.equal(Json.object(toggle.after).checked, false);
  const text = await call('runtime.control.text', { componentId: component('EditBox'), text: 'abcdef' });
  assert.equal(text.accepted, false); assert.equal(Json.object(text.after).text, 'abcd');
  const page = await call('runtime.control.page', { componentId: component('PageView'), index: 2 });
  assert.equal(page.accepted, true);
  const scroll = await call('runtime.control.scroll', { componentId: component('ScrollView'), x: 100, y: 50 });
  const offset = Json.object(Json.object(scroll.after).offset);
  assert.equal(Math.abs(Number(offset.x)), 100); assert.equal(Number(offset.y), 50);
  await assert.rejects(() => call('runtime.control.page', { componentId: component('PageView'), index: 3 }), error => CocosError.from(error).code === 'INVALID_ARGUMENT');
  await call('runtime.control.slider', { componentId: component('Slider'), progress: 0 });
  await call('runtime.control.toggle', { componentId: component('Toggle'), checked: true });
  await call('runtime.control.text', { componentId: component('EditBox'), text: '' });
  await call('runtime.control.page', { componentId: component('PageView'), index: 0 });
  await call('runtime.control.scroll', { componentId: component('ScrollView'), x: 0, y: 0 });
  await call('runtime.ui.inspect', { rootId: root });
  const capture = await call('preview.capture');
  await writeFile(resolve('.codex-work/logs/creator2-expansion/controls.png'), Buffer.from(String(capture.dataUrl).split(',')[1]!, 'base64')); delete capture.dataUrl;
  const sub = await call('runtime.subscribe', { target: `node:${ids.Toggle}`, event: 'toggle' });
  const click = () => call('preview.input', { action: 'click', x: 400, y: 300, durationMs: 30 });
  await click();
  assert.equal((await call('runtime.control.inspect', { componentId: component('Toggle') })).checked, false);
  const events = await call('runtime.events', {});
  assert.equal((events.rows as JsonObject[]).filter(row => row.subscriptionId === sub.subscriptionId).length, 1);
  await call('runtime.set', { target: `component:${component('Toggle')}`, path: 'interactable', value: false });
  await click();
  assert.equal((await call('runtime.control.inspect', { componentId: component('Toggle') })).checked, false);
  await call('runtime.set', { target: `component:${component('Toggle')}`, path: 'interactable', value: true });
  await call('runtime.set', { target: `node:${blocker}`, path: 'active', value: true });
  await click();
  assert.equal((await call('runtime.control.inspect', { componentId: component('Toggle') })).checked, false);
  assert.equal(((await call('runtime.events', { cursor: events.nextCursor! })).rows as JsonObject[]).length, 0);
  await call('runtime.set', { target: `node:${blocker}`, path: 'active', value: false });
  await click();
  assert.equal((await call('runtime.control.inspect', { componentId: component('Toggle') })).checked, true);
  await call('runtime.unsubscribe', { subscriptionId: sub.subscriptionId! });
  const slideSub = await call('runtime.subscribe', { target: `node:${ids.Slider}`, event: 'slide' });
  const cursor = (await call('runtime.events', {})).nextCursor!;
  await call('preview.input', { action: 'drag', x: 330, y: 180, endX: 470, endY: 180, steps: 8, durationMs: 160 });
  const dragged = await call('runtime.control.inspect', { componentId: component('Slider') });
  assert.ok(Number(dragged.progress) > 0.6, JSON.stringify(dragged));
  const slideEvents = (await call('runtime.events', { cursor })).rows as JsonObject[];
  assert.ok(slideEvents.some(row => row.subscriptionId === slideSub.subscriptionId));
  await call('runtime.unsubscribe', { subscriptionId: slideSub.subscriptionId! });
  const scrollSub = await call('runtime.subscribe', { target: `node:${ids.ScrollView}`, event: 'scrolling' });
  const scrollCursor = (await call('runtime.events', {})).nextCursor!;
  await call('preview.input', { action: 'drag', x: 180, y: 330, endX: 110, endY: 260, durationMs: 240, steps: 10 });
  const scrolled = await call('runtime.control.inspect', { componentId: component('ScrollView') });
  assert.ok(Math.abs(Number(Json.object(scrolled.offset).x)) + Math.abs(Number(Json.object(scrolled.offset).y)) > 10, JSON.stringify(scrolled));
  assert.ok(((await call('runtime.events', { cursor: scrollCursor })).rows as JsonObject[]).some(row => row.subscriptionId === scrollSub.subscriptionId));
  await call('runtime.unsubscribe', { subscriptionId: scrollSub.subscriptionId! });
  const pageSub = await call('runtime.subscribe', { target: `node:${ids.PageView}`, event: 'page-turning' });
  const pageCursor = (await call('runtime.events', {})).nextCursor!;
  await call('preview.input', { action: 'drag', x: 220, y: 490, endX: 80, endY: 490, durationMs: 200, steps: 10 });
  let paged = await call('runtime.control.inspect', { componentId: component('PageView') });
  for (let attempt = 0; attempt < 10 && Number(paged.index) === 0; attempt++) { await new Promise(resolve => setTimeout(resolve, 100)); paged = await call('runtime.control.inspect', { componentId: component('PageView') }); }
  assert.ok(Number(paged.index) > 0, JSON.stringify(paged));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(((await call('runtime.events', { cursor: pageCursor })).rows as JsonObject[]).some(row => row.subscriptionId === pageSub.subscriptionId));
  await call('runtime.unsubscribe', { subscriptionId: pageSub.subscriptionId! });
  rows.push({ scrollInputVerified: true, pageInputVerified: true });
  const editSub = await call('runtime.subscribe', { target: `node:${ids.EditBox}`, event: 'text-changed' });
  const editCursor = (await call('runtime.events', {})).nextCursor!;
  await call('preview.input', { action: 'click', x: 400, y: 490, durationMs: 30 });
  await call('runtime.invoke', { target: `component:${component('EditBox')}`, method: 'isFocused', args: [] });
  await call('preview.input', { action: 'key', x: 400, y: 490, key: 'A', focusTarget: 'window', durationMs: 30 });
  const edited = await call('runtime.control.inspect', { componentId: component('EditBox') });
  assert.equal(String(edited.text).toLowerCase(), 'a');
  assert.ok(((await call('runtime.events', { cursor: editCursor })).rows as JsonObject[]).some(row => row.subscriptionId === editSub.subscriptionId));
  await call('runtime.unsubscribe', { subscriptionId: editSub.subscriptionId! });
  const cleanupCursor = (await call('runtime.events', {})).nextCursor!;
  await call('preview.input', { action: 'key', x: 400, y: 490, key: 'B', focusTarget: 'window', durationMs: 30 });
  assert.equal(String((await call('runtime.control.inspect', { componentId: component('EditBox') })).text).toLowerCase(), 'ab');
  assert.equal(((await call('runtime.events', { cursor: cleanupCursor })).rows as JsonObject[]).length, 0);
  await call('runtime.invoke', { target: `component:${component('EditBox')}`, method: 'blur', args: [] });
  await call('runtime.control.slider', { componentId: component('Slider'), progress: 0 });
  await call('runtime.control.text', { componentId: component('EditBox'), text: '' });
  await call('runtime.control.page', { componentId: component('PageView'), index: 0 });
  await call('runtime.control.scroll', { componentId: component('ScrollView'), x: 0, y: 0 });
  rows.push({ editInputVerified: true, subscriptionCleanupVerified: true });
  rows.push({ sliderInputVerified: true, progress: dragged.progress!, events: slideEvents.length });
  rows.push({ toggleInputVerified: true, assertions: 'native click, one toggle event, disabled and blocked clicks ignored, unblocked click succeeds' });
  rows.push({ passed: true, assertions: 'five native controls, truncation, bounds rejection, restore', remainingInputCoverage: [] });
} catch (error) { rows.push({ passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); process.exitCode = 1; console.error(error); }
finally { try { if (preview) await call('preview.stop'); } finally { await gateway.close(); await mkdir(resolve('.codex-work/logs/creator2-expansion'), { recursive: true }); await writeFile(resolve('.codex-work/logs/creator2-expansion/controls.json'), JSON.stringify({ project, rows }, null, 2)); } }
