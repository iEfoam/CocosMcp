import { PanelView, type PanelViewState } from './panel-view.js';
import { panelStyle } from './panel-style.js';
import { PanelDom } from './panel-dom.js';
import { PanelDropdown } from './panel-dropdown.js';
import { PanelLogCache } from './panel-log-cache.js';
import { PanelI18n } from './panel-i18n.js';
import type { PanelState } from '../../packages/editor-bridge/src/panel-state.js';
import { PanelLogs } from './panel-logs.js';

interface PanelEditor {
  Message?: { request(extension: string, message: string, ...args: unknown[]): Promise<unknown> };
  Ipc?: { sendToMain(message: string, ...args: unknown[]): void };
}
declare const Editor: PanelEditor;

function request(major: 2 | 3, message: 'panel-state', cursor?: string): Promise<PanelState>;
function request(major: 2 | 3, message: 'extension-check' | 'extension-update' | 'start' | 'stop' | 'service-start' | 'service-stop' | 'authorize-project' | 'revoke-project'): Promise<unknown>;
function request(major: 2 | 3, message: 'set-language' | 'copy-log' | 'copy-connection' | 'service-port', value: string): Promise<unknown>;
function request(major: 2 | 3, message: string, ...args: (string | undefined)[]): Promise<unknown> {
  // 面板只通过编辑器 IPC 读取脱敏状态；浏览器请求会带 Origin，不能使用外部 MCP 的认证通道。
  return new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error('编辑器响应超时，请检查扩展是否启用后刷新')), message === 'extension-update' ? 125000 : message.startsWith('service-') ? 25000 : 10000);
    const finish = (error: unknown, result?: unknown): void => {
      clearTimeout(timeout);
      if (error) reject(error); else accept(result);
    };
    try {
      if (major === 3 && Editor.Message) void Editor.Message.request('cocos-mcp-creator3', message, ...args).then(result => finish(null, result), finish);
      else if (major === 2 && Editor.Ipc) Editor.Ipc.sendToMain(`cocos-mcp-creator2:${message}`, ...args, finish);
      else finish(new Error('当前编辑器未提供面板消息接口'));
    } catch (error) { finish(error); }
  });
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

export function createPanelDefinition(major: 2 | 3) {
  const i18n = new PanelI18n();
  const dom = new PanelDom(), logCache = new PanelLogCache();
  const state: PanelViewState = { tab: 'overview', query: '', snapshot: null as PanelState | null, selected: null as PanelState['instance'], supported: [] as string[], logs: [] as PanelState['logs'], runtime: false, error: '', busy: false, connectionMode: 'stdio' as 'unified' | 'stdio' | 'http' };
  let connectionChosen = false;
  let navigationRevision = -1;
  let root: HTMLElement;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  let disposed = false;
  let composing = false;
  const logBrowser = new PanelLogs();
  let dropdowns: PanelDropdown | undefined;
  let copyFeedback = '';
  let copying = false;

  const render = (): void => {
    if (disposed || composing || dropdowns?.expanded) return;
    const previousSearch = root.querySelector<HTMLInputElement>('[data-search]');
    const focused = previousSearch && (root.getRootNode() as Document | ShadowRoot).activeElement === previousSearch;
    const selection = focused ? [previousSearch.selectionStart, previousSearch.selectionEnd] : null;
    const activeElement = (root.getRootNode() as Document | ShadowRoot).activeElement as HTMLElement | null;
    const activePageLabel = activeElement?.hasAttribute('data-log-page') ? activeElement.getAttribute('aria-label') : null;
    const scrollTop = root.querySelector<HTMLElement>('.content')?.scrollTop ?? 0;
    dom.update(root, PanelView.render({ major, state, i18n, logBrowser, dropdowns: dropdowns!, copyFeedback, copying }));
    bind();
    if (activePageLabel) root.querySelector<HTMLButtonElement>(`[data-log-page][aria-label="${activePageLabel}"]:not(:disabled)`)?.focus();
    const content = root.querySelector<HTMLElement>('.content');
    if (content) content.scrollTop = scrollTop;
    if (selection) {
      const input = root.querySelector<HTMLInputElement>('[data-search]');
      input?.focus();
      input?.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0);
    }
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    pending = request(major, 'panel-state', logCache.request()).then(snapshot => {
      if (disposed) return;
      if (snapshot.navigation && snapshot.navigation.revision !== navigationRevision) { state.tab = snapshot.navigation.page; navigationRevision = snapshot.navigation.revision; }
      state.snapshot = snapshot; i18n.locale = snapshot.locale === 'en' ? 'en' : 'zh'; state.selected = snapshot.instance;
      if (!connectionChosen && snapshot.service?.unifiedClient?.installed) { state.connectionMode = 'unified'; connectionChosen = true; }
      state.supported = snapshot.supportedCapabilities; state.logs = logCache.accept(snapshot);
      state.runtime = snapshot.runtimeConfigured; state.error = '';
    }).catch(error => {
      if (disposed) return;
      state.selected = null; state.supported = []; state.runtime = false;
      state.error = errorMessage(error);
    }).finally(() => {
      pending = undefined;
      // 自定义弹层展开时先更新数据，关闭后再渲染，保持键盘高亮与点击目标稳定。
      render();
    });
    return pending;
  };

  const command = async (action: 'extension-check' | 'extension-update' | 'start' | 'stop' | 'restart' | 'service-start' | 'service-stop' | 'service-restart' | 'copy-connection' | 'service-port' | 'authorize-project' | 'revoke-project'): Promise<void> => {
    if (state.busy || disposed) return;
    const parameter = action === 'copy-connection' ? state.connectionMode : root.querySelector<HTMLInputElement>('[data-service-port]')?.value ?? '';
    state.busy = true; render();
    try {
      // 先等待已有查询，避免停止后的界面被旧的在线状态覆盖。
      await pending;
      if (disposed) return;
      // 重启必须等停止成功后才启动；任何一步失败均保留真实状态，不能伪装成功。
      if (action === 'restart' || action === 'service-restart') {
        await request(major, action === 'restart' ? 'stop' : 'service-stop');
        await request(major, action === 'restart' ? 'start' : 'service-start');
      } else if (action === 'copy-connection' || action === 'service-port') { await request(major, action, parameter); if (action === 'copy-connection') copyFeedback = i18n.text('复制成功'); }
      else await request(major, action);
      await refresh();
    } catch (error) { await refresh(); state.error = errorMessage(error); }
    finally { state.busy = false; render(); }
  };

  const logViewRows = () => logBrowser.view(state.logs).rows;
  const serviceRunning = (): boolean => ['running', 'starting'].includes(state.snapshot?.service?.status ?? '');
  const bind = (): void => {
    dropdowns?.bind();
    root.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach(button => {
      button.disabled = state.busy;
      dom.on(button, 'click', () => {
        const locale = button.dataset.locale;
        if (state.busy || (locale !== 'zh' && locale !== 'en') || locale === i18n.locale) return;
        state.busy = true;
        render();
        void (async () => {
          try {
            await pending;
            if (disposed) return;
            await request(major, 'set-language', locale);
            i18n.locale = locale;
            if (state.snapshot) state.snapshot.locale = locale;
            copyFeedback = '';
          } catch (error) { state.error = i18n.text('语言设置失败') + ': ' + errorMessage(error); }
          finally { state.busy = false; render(); }
        })();
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-copy-log]').forEach(button => {
      button.disabled = copying || (button.dataset.copyLog === 'all' && !state.logs.some(log => log.level === 'error'));
      dom.on(button, 'click', () => {
        if (copying) return;
        const rows = button.dataset.copyLog === 'all' ? state.logs.filter(log => log.level === 'error') : logViewRows().filter(log => log.level === 'error' && String(log.sequence) === button.dataset.copyLog);
        if (!rows.length) { copyFeedback = i18n.text('没有可复制的错误日志'); render(); return; }
        copying = true;
        const text = rows.map(log => JSON.stringify(log, null, 2)).join('\n');
        void request(major, 'copy-log', text).then(() => { copyFeedback = i18n.text('复制成功'); }, error => { copyFeedback = i18n.text('复制失败') + ': ' + errorMessage(error); }).finally(() => { copying = false; render(); });
      });
    });
    root.querySelectorAll<HTMLElement>('[data-tab]').forEach(element => dom.on(element, 'click', () => { state.tab = element.dataset.tab ?? 'overview'; render(); }));
    root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
      const action = button.dataset.action;
      const serviceStarting = state.snapshot?.service?.status === 'starting' && action?.startsWith('service-') === true;
      const connectionUnavailable = (action === 'service-port' && serviceRunning()) || (action === 'copy-connection' && (state.connectionMode === 'unified' && !state.snapshot?.service?.unifiedClient?.installed || state.connectionMode === 'http' && (!state.snapshot?.service?.endpoint || state.snapshot.service.status !== 'running' || state.snapshot.service.shared === true))) || (action?.startsWith('service-') === true && state.snapshot?.service?.managed === false && serviceRunning());
      const stopUnavailable = (action === 'service-stop' && !serviceRunning()) || (action === 'stop' && !state.selected);
      button.disabled = state.busy || ((action === 'extension-check' || action === 'extension-update') && state.snapshot?.extension?.checking === true) || (action === 'extension-update' && state.snapshot?.extension?.updating === true) || serviceStarting || connectionUnavailable || stopUnavailable || (!state.snapshot && action !== 'refresh');
      dom.on(button, 'click', () => {
        const action = button.dataset.action;
        if (action === 'refresh') { if (state.tab === 'logs') logBrowser.latest(); void refresh(); }
        else if (action === 'extension-check' || action === 'extension-update' || action === 'start' || action === 'stop' || action === 'service-start' || action === 'service-stop' || action === 'restart' || action === 'service-restart' || action === 'copy-connection' || action === 'service-port' || action === 'authorize-project' || action === 'revoke-project') void command(action);
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-log-page]').forEach(button => {
      dom.on(button, 'click', () => {
        if (button.disabled) return;
        logBrowser.go(Number(button.dataset.logPage), state.logs);
        render();
        const nextButton = root.querySelector<HTMLButtonElement>(`[data-log-page][aria-label="${button.getAttribute('aria-label')}"]:not(:disabled)`);
        if (nextButton) nextButton.focus();
        else root.querySelector<HTMLButtonElement>('[data-log-page][aria-label]:not(:disabled)')?.focus();
      });
    });
    const search = root.querySelector<HTMLInputElement>('[data-search]');
    dom.on(search, 'compositionstart', () => { composing = true; });
    dom.on(search, 'compositionend', () => { composing = false; state.query = search?.value ?? ''; render(); });
    dom.on(search, 'input', () => { state.query = search?.value ?? ''; render(); });
  };

  const definition = {
    template: '<div id="cocos-mcp-control-center"></div>',
    $: { root: '#cocos-mcp-control-center' },
    style: panelStyle,
    async ready(this: { $?: { root: HTMLElement }; $root?: HTMLElement }): Promise<void> {
      // Creator 2 将选择器映射为 this.$root，Creator 3 才使用 this.$.root。
      const element = major === 2 ? this.$root : this.$?.root;
      if (!element) throw new Error(`Creator ${major} control center root element is unavailable`);
      root = element;
      dropdowns = new PanelDropdown(root, dom, (id, value) => {
        if (id === 'connection-mode' && (value === 'unified' || value === 'stdio' || value === 'http')) { state.connectionMode = value; connectionChosen = true; copyFeedback = ''; }
        else if (id === 'log-level') logBrowser.filter(value);
        else if (id === 'log-size') logBrowser.resize(Number(value));
        render();
      }, render);
      render();
      await refresh();
      // ready 等待 IPC 时用户可能已关闭面板，不能再创建轮询或写入已卸载的 DOM。
      if (!disposed) timer = setInterval(() => { if (!state.busy && !root.ownerDocument.hidden && root.getClientRects().length > 0) void refresh(); }, 5000);
    },
    // Creator 2 的 close 返回 true 才允许关闭；Creator 3 忽略该返回值。
    close(): boolean { disposed = true; dropdowns?.dispose(); if (timer) clearInterval(timer); timer = undefined; return true; },
  };
  return definition;
}
