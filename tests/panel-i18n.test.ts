import { capabilityEnglish } from '../extensions/shared/panel-capabilities-en.js';
import { Operations } from '../packages/capability-catalog/src/operations.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PanelI18n } from '../extensions/shared/panel-i18n.js';
import { PanelPreferences, type PanelMenuHost } from '../extensions/shared/panel-preferences.js';

test('panel translates static text without rewriting log and path interpolations', () => {
  const language = new PanelI18n();
  assert.equal(language.text('桥接日志'), '桥接日志');
  language.locale = 'en';
  assert.equal(language.text('桥接日志'), 'Bridge logs');
  assert.equal(language.text('全部级别'), 'All levels');
  assert.equal(language.html`桥接日志 ${'启动失败 <script>'}`, 'Bridge logs 启动失败 <script>');
});

for (const major of [2, 3] as const) {
  test(`Creator ${major} language persists, updates only extension menus and preserves clipboard payload`, () => {
    const project = mkdtempSync(resolve('.codex-work/tmp/panel-language-'));
    const calls: { operation: string; path: string; options?: unknown }[] = [];
    let applications = 0;
    let copied = '';
    const api = {
      remove: (path: string, options?: unknown) => { calls.push({ operation: 'remove', path, options }); },
      add: (path: string, options: unknown) => { calls.push({ operation: 'add', path, options }); },
      apply: () => { applications++; },
    };
    const host: PanelMenuHost = { Menu: api, MainMenu: api };
    const preferences = new PanelPreferences(() => project, major, host, () => ({ writeText: text => { copied = text; } }));
    assert.equal(preferences.read(), 'zh');
    assert.throws(() => preferences.set('invalid'), /Unsupported/);
    preferences.set('en');
    assert.equal(applications, 1);
    assert.ok(calls.every(row => row.path === 'CocosMCP' || row.path.startsWith('CocosMCP/')));
    assert.equal(calls.filter(row => row.operation === 'add').length, major === 3 ? 4 : 3);
    assert.equal(new PanelPreferences(() => project, major, host).read(), 'en');
    assert.equal(JSON.parse(readFileSync(join(project, '.codex-work/cache/cocos-mcp/panel-preferences.json'), 'utf8')).locale, 'en');
    preferences.applyMenu();
    assert.equal(applications, 1);
    preferences.copy('错误\n<script>stack & details</script>');
    assert.equal(copied, '错误\n<script>stack & details</script>');
    assert.throws(() => preferences.copy(''), /Invalid/);
    preferences.restoreMenu();
    assert.equal(applications, 2);
    assert.equal(preferences.read(), 'en');
  });
}

test('every registered capability has an English panel description', () => {
  assert.deepEqual(new Operations().list().filter(row => !capabilityEnglish[row.id]).map(row => row.id), []);
});
