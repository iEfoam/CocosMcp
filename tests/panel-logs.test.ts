import assert from 'node:assert/strict';
import test from 'node:test';
import { PanelLogs } from '../extensions/shared/panel-logs.js';
import { EditorBridge } from '../packages/editor-bridge/src/index.js';

class LogFixture {
  rows(count: number) {
    return Array.from({ length: count }, (_, index) => ({ sequence: index + 1, level: index % 3 === 0 ? 'error' : index % 3 === 1 ? 'warn' : 'info', message: `Event ${index + 1}` }));
  }
}

test('log filtering precedes pagination and reaches historical errors beyond the old 100-row limit', () => {
  const browser = new PanelLogs();
  const rows = new LogFixture().rows(135);
  browser.filter('error');
  assert.equal(browser.view(rows).total, 45);
  assert.equal(browser.view(rows).pages, 3);
  assert.ok(browser.view(rows).rows.every(row => row.level === 'error'));
  browser.go(3, rows);
  assert.deepEqual(browser.view(rows).rows.map(row => row.sequence), [13, 10, 7, 4, 1]);
  assert.equal(browser.view(rows).start, 41);
  assert.equal(browser.view(rows).end, 45);
  browser.filter('warn');
  assert.equal(browser.page, 1);
  assert.equal(browser.view(rows).history, false);
  assert.ok(browser.view(rows).rows.every(row => row.level === 'warn'));
});

test('historical pages stay stable when fresh logs arrive or retained logs are evicted', () => {
  const browser = new PanelLogs();
  const rows = new LogFixture().rows(100);
  browser.go(2, rows);
  const before = browser.view(rows).rows;
  const fresh = new LogFixture().rows(150).slice(50);
  assert.deepEqual(browser.view(fresh).rows, before);
  browser.go(3, fresh);
  assert.equal(browser.view(fresh).rows[0]!.sequence, 60);
  browser.go(1, fresh);
  assert.equal(browser.view(fresh).rows[0]!.sequence, 150);
  assert.equal(browser.view(fresh).history, false);
});

test('page sizes, bounds, empty filters, and invalid control values are safe', () => {
  const browser = new PanelLogs();
  const rows = new LogFixture().rows(101);
  browser.go(999, rows);
  assert.equal(browser.page, 6);
  browser.resize(50);
  assert.equal(browser.page, 1);
  assert.equal(browser.view(rows).pages, 3);
  browser.resize(100);
  assert.equal(browser.view(rows).rows.length, 100);
  browser.resize(0);
  browser.filter('<invalid>');
  browser.go(Number.NaN, rows);
  assert.equal(browser.pageSize, 100);
  assert.equal(browser.level, 'all');
  browser.filter('error');
  const empty = browser.view([{ sequence: 1, level: 'info', message: 'OK' }]);
  assert.deepEqual([empty.total, empty.start, empty.end, empty.pages], [0, 0, 0, 1]);
  browser.go(-1, rows);
  assert.equal(browser.page, 1);
});

test('panel receives the full bounded bridge history without allowing client mutation', () => {
  const bridge = new EditorBridge({ major: 3, supportedCapabilities: () => [], dispose: async () => {}, revision: async () => '', execute: async () => null }, process.cwd(), '3.8.8');
  for (let index = 0; index < 5010; index++) bridge.log(index === 10 ? 'error' : 'info', `Event ${index}`);
  const state = bridge.panelState();
  assert.equal(state.logs.length, 5000);
  assert.equal(state.logs[0]!.level, 'error');
  state.logs[0]!.message = 'Client mutation';
  assert.equal(bridge.panelState().logs[0]!.message, 'Event 10');
});
