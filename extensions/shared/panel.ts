import { capabilityEnglish } from './panel-capabilities-en.js';
import { PanelI18n } from './panel-i18n.js';
import { Operations } from '../../packages/capability-catalog/src/operations.js';
import type { PanelState } from '../../packages/editor-bridge/src/panel-state.js';
import { logLevels, PanelLogs } from './panel-logs.js';

interface PanelEditor {
  Message?: { request(extension: string, message: string, ...args: unknown[]): Promise<unknown> };
  Ipc?: { sendToMain(message: string, ...args: unknown[]): void };
}
declare const Editor: PanelEditor;
const operations = new Operations().list();
const copyIcon = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
const refreshIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17"/></svg>';
function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

function request(major: 2 | 3, message: 'panel-state'): Promise<PanelState>;
function request(major: 2 | 3, message: 'extension-check' | 'extension-update' | 'start' | 'stop' | 'service-start' | 'service-stop'): Promise<unknown>;
function request(major: 2 | 3, message: 'set-language' | 'copy-log', value: string): Promise<unknown>;
function request(major: 2 | 3, message: string, ...args: string[]): Promise<unknown> {
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
  const state = { tab: 'overview', query: '', snapshot: null as PanelState | null, selected: null as PanelState['instance'], supported: [] as string[], logs: [] as PanelState['logs'], runtime: false, error: '', busy: false };
  let navigationRevision = -1;
  let root: HTMLElement;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  let disposed = false;
  let composing = false;
  const logBrowser = new PanelLogs();
  let logSelectFocused = false;
  let copyFeedback = '';
  let copying = false;

  const render = (): void => {
    if (disposed || composing) return;
    const previousSearch = root.querySelector<HTMLInputElement>('[data-search]');
    const focused = previousSearch && (root.getRootNode() as Document | ShadowRoot).activeElement === previousSearch;
    const selection = focused ? [previousSearch.selectionStart, previousSearch.selectionEnd] : null;
    const activeElement = (root.getRootNode() as Document | ShadowRoot).activeElement as HTMLElement | null;
    const activePageLabel = activeElement?.hasAttribute('data-log-page') ? activeElement.getAttribute('aria-label') : null;
    const scrollTop = root.querySelector<HTMLElement>('.content')?.scrollTop ?? 0;
    const descriptor = state.selected;
    const status = state.error ? i18n.text('连接异常') : descriptor ? i18n.text('桥接已启动') : state.snapshot ? i18n.text('已停止') : i18n.text('正在连接');
    const statusClass = !state.error && descriptor ? 'online' : 'offline';
    const service = state.snapshot?.service;
    const serviceLabel = service?.status === 'running' ? i18n.text('已启动') : service?.status === 'starting' ? i18n.text('启动中') : service?.status === 'error' ? i18n.text('启动失败') : i18n.text('未启动');
    const serviceCard = i18n.html`<section class="panel-card service-card"><h2>MCP 服务 · ${serviceLabel}</h2><p>启动本工程的 MCP 服务及运行时网关。游戏预览仍需接入运行时桥接。</p>${service?.endpoint ? i18n.html`<p>连接地址：<code>${esc(service.endpoint)}</code></p><p>客户端使用 Bearer token，凭证文件：<code>.codex-work/cache/cocos-mcp/mcp-http-token</code></p>` : ''}${service?.error ? `<div class="notice error">${esc(service.error)}</div>` : ''}<div class="card-footer"><button class="primary" data-action="${service?.status === 'running' ? 'service-restart' : 'service-start'}">${service?.status === 'running' ? i18n.text('重启') : i18n.text('启动')} MCP 服务</button><button class="secondary" data-action="service-stop">停止 MCP 服务</button></div><p>由此处启动的服务随扩展卸载或编辑器退出而停止；关闭面板不停止服务。</p></section>`;
    const runtimeStatus = state.snapshot?.runtimeStatus;
    const runtimeLabel = runtimeStatus?.error ? i18n.text('查询异常') : runtimeStatus?.connected ? i18n.html`已连接 ${runtimeStatus.connected}` : state.runtime ? i18n.text('等待游戏连接') : i18n.text('网关未启动');
    const supportedCount = operations.filter(row => state.supported.includes(row.id)).length;
    const filtered = operations.filter(row => !state.query || `${row.id} ${row.title} ${capabilityEnglish[row.id] ?? ''} ${row.module}`.toLowerCase().includes(state.query.toLowerCase()));
    const capabilities = filtered.slice(0, 120).map(row => {
      const active = state.supported.includes(row.id);
      const stateText = row.implementation === 'planned' ? i18n.text('规划中') : !(row.supportedMajors ?? row.versions).includes(major) ? i18n.text('版本不支持') : row.context === 'runtime' ? i18n.text('需运行时') : active ? (descriptor ? i18n.text('可用') : i18n.text('需启动桥接')) : i18n.text('未暴露');
      const stateKind = row.implementation === 'planned' ? 'planned' : active ? 'active' : 'muted';
      return `<article class="capability-row"><div class="capability-mark ${stateKind}"></div><div class="capability-main"><strong>${esc(row.id)}</strong><span>${esc(i18n.locale === 'en' ? (capabilityEnglish[row.id] ?? row.id) : row.title)}</span></div><div class="capability-meta"><span class="tag">${esc(row.module)}</span><span class="tag">${esc(row.effect)}</span><span class="state ${stateKind}">${stateText}</span></div></article>`;
    }).join('');
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const clock = new Intl.DateTimeFormat(undefined, { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const logView = logBrowser.view(state.logs);
    const logs = logView.rows.map(log => {
      const date = typeof log.occurredAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(log.occurredAt) ? new Date(log.occurredAt) : null;
      const time = date && Number.isFinite(date.getTime()) ? clock.format(date) : '—';
      return `<div class="log-row"><span class="log-sequence">#${esc(log.sequence)}</span><span class="log-level ${esc(log.level)}">${esc(log.level)}</span><span class="log-message" title="${esc(log.message)}">${esc(log.message)}</span>${log.level === 'error' ? i18n.html`<button class="log-icon-button log-copy" data-copy-log="${esc(log.sequence)}" aria-label="复制错误日志" title="复制错误日志">${copyIcon}</button>` : ''}<time title="${esc(timeZone)}">${esc(time)}</time></div>`;
    }).join('');
    const instances = descriptor ? i18n.html`<div class="instance-row"><div class="instance-icon">C${descriptor.creatorMajor}</div><div class="instance-main"><strong>Creator ${esc(descriptor.editorVersion)}</strong><span>${esc(descriptor.instanceId.slice(0, 12))} · PID ${esc(descriptor.pid)}</span></div><span class="state online">桥接已启动</span></div>` : '';
    const extension = state.snapshot?.extension;
    root.innerHTML = i18n.html`<div class="shell">
      <header class="hero"><div class="brand"><div class="brand-icon">✦</div><div><div class="eyebrow">COCOSMCP CONTROL CENTER</div><h1>控制中心</h1><p>让编辑器状态、能力和运行时保持可见</p></div></div><div class="hero-actions"><div class="language-switch" role="group" aria-label="语言"><button data-locale="zh" class="language-option" aria-pressed="${i18n.locale === 'zh'}" title="简体中文">中文</button><button data-locale="en" class="language-option" aria-pressed="${i18n.locale === 'en'}" title="English">EN</button></div><span class="status-pill ${statusClass}"><i></i>${status}</span><button class="icon-button" data-action="refresh" aria-label="刷新">↻</button></div></header>
      <nav class="tabs" role="tablist"><button class="tab ${state.tab === 'overview' ? 'selected' : ''}" data-tab="overview">总览</button><button class="tab ${state.tab === 'capabilities' ? 'selected' : ''}" data-tab="capabilities">能力 <em>${supportedCount} / ${operations.length}</em></button><button class="tab ${state.tab === 'logs' ? 'selected' : ''}" data-tab="logs">桥接日志 ${state.logs.length ? `<em>${state.logs.length}</em>` : ''}</button><button class="tab ${state.tab === 'runtime' ? 'selected' : ''}" data-tab="runtime">运行时</button><button class="tab ${state.tab === 'about' ? 'selected' : ''}" data-tab="about">关于 CocosMCP</button><button class="tab ${state.tab === 'updates' ? 'selected' : ''}" data-tab="updates">检查更新</button></nav>
      <main class="content">${state.error ? `<div class="notice error"><span>!</span>${esc(state.error)}</div>` : ''}
        ${state.tab === 'about' ? i18n.html`<section class="tab-page"><div class="page-heading"><h2>关于 CocosMCP</h2></div><section class="panel-card info-card"><h3>CocosMCP</h3><p>免费开源的 Cocos Creator MCP 插件</p><p>连接 AI 客户端、编辑器场景、资源和开发运行时。</p><dl><dt>当前版本</dt><dd>${esc(extension?.version ?? '—')}</dd><dt>构建标识</dt><dd><code>${esc(extension?.buildId || '—')}</code></dd><dt>编辑器</dt><dd>Creator ${esc(state.snapshot?.editorVersion ?? '—')}</dd><dt>许可证</dt><dd>MIT</dd><dt>作者</dt><dd>iefoam@foxmail.com</dd><dt>项目主页</dt><dd>https://github.com/iEfoam/CocosMcp</dd><dt>问题反馈</dt><dd>https://github.com/iEfoam/CocosMcp/issues</dd></dl><button class="primary" data-tab="updates">检查更新</button></section></section>` : ''}
        ${state.tab === 'updates' ? i18n.html`<section class="tab-page"><div class="page-heading"><h2>检查更新</h2></div><section class="panel-card info-card"><p>更新源：GitHub · iEfoam/CocosMcp</p><dl><dt>当前版本</dt><dd>${esc(extension?.version ?? '—')}</dd><dt>已安装版本</dt><dd>${esc(extension?.installedVersion ?? '—')}</dd><dt>最新版本</dt><dd>${esc(extension?.latestVersion ?? '—')}</dd></dl><p role="status" aria-live="polite">${extension?.checking ? i18n.text('正在检查 GitHub 版本…') : esc(extension?.message ?? (extension?.latestVersion ? i18n.text('版本信息已获取，可按需安装最新版本。') : i18n.text('点击检查更新获取最新版本。')))}</p>${extension?.reloadRequired ? i18n.html`<p>新版已安装，请重载扩展后重新启动 MCP 服务。</p>` : ''}<div class="info-actions"><button class="primary" data-action="extension-check">${extension?.checking ? i18n.text('检查中…') : i18n.text('检查更新')}</button><button class="secondary" data-action="extension-update">${extension?.updating ? i18n.text('更新中…') : i18n.text('安装最新版本')}</button></div><p>检查不会安装；安装前会备份当前扩展。</p></section></section>` : ''}
        ${state.tab === 'overview' ? i18n.html`<section class="overview">${serviceCard}<div class="metric-grid"><div class="metric-card accent"><span>编辑器</span><strong>${state.snapshot ? `Creator ${esc(state.snapshot.editorVersion)}` : i18n.text('等待连接')}</strong><small>${state.snapshot ? i18n.html`大版本 ${major}.x` : i18n.text('正在读取编辑器状态')}</small></div><div class="metric-card"><span>工程</span><strong>${state.snapshot ? i18n.text('已识别') : i18n.text('读取中')}</strong><small class="truncate" title="${esc(state.snapshot?.projectPath)}">${esc(state.snapshot?.projectPath)}</small></div><div class="metric-card"><span>实例</span><strong>${descriptor ? 1 : 0}</strong><small>当前窗口的桥接实例</small></div><div class="metric-card"><span>运行时</span><strong>${runtimeLabel}</strong><small>${runtimeStatus?.error ? esc(runtimeStatus.error) : i18n.text('开发游戏会话状态')}</small></div></div><div class="split-grid"><section class="panel-card"><div class="card-heading"><div><span class="section-kicker">EDITOR INSTANCES</span><h2>当前窗口实例</h2></div><button class="text-button" data-tab="capabilities">查看能力 →</button></div><div class="instance-list">${instances || i18n.text('<div class="empty"><span>◌</span><strong>尚未连接 Creator</strong><small>在此控制中心启动 CocosMCP 桥接</small></div>')}</div><div class="card-footer"><button class="primary" data-action="${descriptor ? 'restart' : 'start'}">${descriptor ? i18n.text('重启') : i18n.text('启动')}桥接</button><button class="secondary" data-action="stop">停止桥接</button></div></section><section class="panel-card insight"><div class="section-kicker">QUICK INSIGHT</div><h2>连接范围</h2><p>桥接已启动仅表示当前编辑器监听就绪。此面板尚未监测 MCP 客户端连接；游戏连接请查看运行时状态。</p><div class="check-list"><span><i>✓</i>路径限制在工程内</span><span><i>✓</i>操作支持幂等重试</span><span><i>✓</i>运行时默认开发模式</span></div></section></div></section>` : ''}
        ${state.tab === 'capabilities' ? i18n.html`<section class="tab-page"><div class="page-heading"><div><span class="section-kicker">CAPABILITY CATALOG</span><h2>能力目录</h2><p>当前适配器支持 ${supportedCount} 项 / 注册目录 ${operations.length} 项；支持不代表已通过实机验证</p></div><div class="search"><span>⌕</span><input data-search placeholder="搜索能力、模块或描述" value="${esc(state.query)}" aria-label="搜索能力" /></div></div><div class="capability-list">${capabilities || i18n.text('<div class="empty"><span>⌕</span><strong>没有匹配的能力</strong><small>尝试搜索 scene、asset 或 runtime</small></div>')}</div>${filtered.length > 120 ? i18n.html`<div class="list-hint">仅显示前 120 项，请缩小搜索范围</div>` : ''}</section>` : ''}
        ${state.tab === 'logs' ? i18n.html`<section class="tab-page logs-page"><div class="page-heading log-header"><div class="log-heading-main"><h2>桥接日志</h2><div class="log-heading-actions"><label class="log-filter"><span class="select-shell"><i class="level-dot ${logBrowser.level}" aria-hidden="true"></i><select data-log-select="level" aria-label="日志级别">${logLevels.map(row => `<option value="${row.value}" ${logBrowser.level === row.value ? 'selected' : ''}>${i18n.text(row.label)}</option>`).join('')}</select><span class="select-chevron" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg></span></span></label><span class="log-action-divider" aria-hidden="true"></span><button class="log-icon-button" data-copy-log="all" title="复制全部错误" aria-label="复制全部错误" ${copying || !state.logs.some(log => log.level === 'error') ? 'disabled' : ''}>${copyIcon}</button><button class="log-icon-button" data-action="refresh" title="刷新日志" aria-label="刷新日志">${refreshIcon}</button></div></div><div class="log-heading-foot"><p>保留最近 5,000 条桥接事件；不包含 Creator 控制台日志</p><span class="log-update-state"><i class="${logView.history ? 'paused' : ''}" aria-hidden="true"></i>${logView.history ? i18n.text('历史快照 · 翻页时保持稳定') : i18n.text('实时更新 · 每 5 秒')}${logView.history ? i18n.text('<button class="text-button" data-log-page="1">返回最新</button>') : ''}</span></div><div class="copy-feedback" role="status">${esc(copyFeedback)}</div></div>
          <div class="log-list" aria-label="桥接日志列表">${logs || `<div class="empty"><span>◌</span><strong>${logBrowser.level === 'all' ? i18n.text('暂无日志') : i18n.text('暂无该级别日志')}</strong><small>${logBrowser.level === 'all' ? i18n.text('启动桥接后会显示连接和操作事件') : i18n.text('可以切换级别查看其他桥接事件')}</small></div>`}</div>
          <div class="log-pagination"><span class="log-range" role="status">${logView.start}–${logView.end} / 共 ${logView.total} 条</span><div class="log-page-controls"><label class="page-size"><span>每页</span><span class="select-shell compact"><select data-log-select="size" aria-label="每页日志条数">${[20, 50, 100].map(size => i18n.html`<option value="${size}" ${logBrowser.pageSize === size ? 'selected' : ''}>${size} 条</option>`).join('')}</select><span class="select-chevron" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg></span></span></label><nav class="page-navigation" aria-label="日志分页"><button class="page-button" data-log-page="${logBrowser.page - 1}" aria-label="上一页" ${logBrowser.page === 1 ? 'disabled' : ''}>‹</button><span class="page-position" aria-label="第 ${logBrowser.page} 页，共 ${logView.pages} 页"><strong>${logBrowser.page}</strong><span>/ ${logView.pages}</span></span><button class="page-button" data-log-page="${logBrowser.page + 1}" aria-label="下一页" ${logBrowser.page === logView.pages ? 'disabled' : ''}>›</button></nav></div></div></section>` : ''}
        ${state.tab === 'runtime' ? i18n.html`<section class="tab-page runtime-page">${serviceCard}<div class="page-heading"><div><span class="section-kicker">DEVELOPMENT RUNTIME</span><h2>运行时状态</h2><p>开发预览连接和调试能力</p></div><span class="status-pill ${state.runtime ? 'online' : 'offline'}"><i></i>${runtimeLabel}</span></div><div class="runtime-card"><div class="runtime-orb ${state.runtime ? 'active' : ''}"><span>◎</span></div><div><h3>${runtimeLabel}</h3><p>${runtimeStatus?.error ? esc(runtimeStatus.error) : runtimeStatus?.connected ? i18n.text('已从开发网关读取游戏会话，超过 30 秒没有心跳的会话不计入连接数。') : i18n.text('启动 MCP 服务并在开发预览中接入运行时桥接。')}</p></div></div><div class="runtime-features"><span>对象检查</span><span>属性读写</span><span>事件订阅</span><span>截图</span><span>性能指标</span></div></section>` : ''}
      </main><footer class="footer"><span>CocosMCP ${esc(state.snapshot?.extension?.version ?? i18n.text('读取中'))} <code>${esc(state.snapshot?.extension?.buildId)}</code> <button class="text-button" data-action="extension-update">${state.snapshot?.extension?.updating ? i18n.text('更新中…') : i18n.text('更新版本')}</button><small style="display:block">${state.snapshot?.extension?.reloadRequired ? i18n.html`已安装 ${esc(state.snapshot.extension.installedVersion)} · ${esc(state.snapshot.extension.installedBuildId)}，待重载。` : ''}${esc(state.snapshot?.extension?.message ?? (state.snapshot?.extension?.latestVersion ? i18n.html`GitHub 最新：${state.snapshot.extension.latestVersion}` : state.snapshot?.extension?.checking ? i18n.text('正在检查 GitHub 版本…') : i18n.text('更新源：GitHub · iEfoam/CocosMcp')))}</small></span><span>日志时区：${esc(timeZone)}</span></footer>
    </div>`;
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
    pending = request(major, 'panel-state').then(snapshot => {
      if (disposed) return;
      if (snapshot.navigation && snapshot.navigation.revision !== navigationRevision) { state.tab = snapshot.navigation.page; navigationRevision = snapshot.navigation.revision; }
      state.snapshot = snapshot; i18n.locale = snapshot.locale === 'en' ? 'en' : 'zh'; state.selected = snapshot.instance;
      state.supported = snapshot.supportedCapabilities; state.logs = snapshot.logs;
      state.runtime = snapshot.runtimeConfigured; state.error = '';
    }).catch(error => {
      if (disposed) return;
      state.selected = null; state.supported = []; state.runtime = false;
      state.error = errorMessage(error);
    }).finally(() => {
      pending = undefined;
      // 原生下拉框展开或键盘选择时，轮询不能替换其 DOM 并打断选择。
      if (!logSelectFocused) render();
    });
    return pending;
  };

  const command = async (action: 'extension-check' | 'extension-update' | 'start' | 'stop' | 'restart' | 'service-start' | 'service-stop' | 'service-restart'): Promise<void> => {
    if (state.busy || disposed) return;
    state.busy = true; render();
    try {
      // 先等待已有查询，避免停止后的界面被旧的在线状态覆盖。
      await pending;
      if (disposed) return;
      // 重启必须等停止成功后才启动；任何一步失败均保留真实状态，不能伪装成功。
      if (action === 'restart' || action === 'service-restart') {
        await request(major, action === 'restart' ? 'stop' : 'service-stop');
        await request(major, action === 'restart' ? 'start' : 'service-start');
      } else await request(major, action);
      await refresh();
    } catch (error) { await refresh(); state.error = errorMessage(error); }
    finally { state.busy = false; render(); }
  };

  const logViewRows = () => logBrowser.view(state.logs).rows;
  const serviceRunning = (): boolean => ['running', 'starting'].includes(state.snapshot?.service?.status ?? '');
  const bind = (): void => {
    root.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach(button => {
      button.disabled = state.busy;
      button.addEventListener('click', () => {
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
      button.addEventListener('click', () => {
        if (copying) return;
        const rows = button.dataset.copyLog === 'all' ? state.logs.filter(log => log.level === 'error') : logViewRows().filter(log => log.level === 'error' && String(log.sequence) === button.dataset.copyLog);
        if (!rows.length) { copyFeedback = i18n.text('没有可复制的错误日志'); render(); return; }
        copying = true;
        const text = rows.map(log => JSON.stringify(log, null, 2)).join('\n');
        void request(major, 'copy-log', text).then(() => { copyFeedback = i18n.text('复制成功'); }, error => { copyFeedback = i18n.text('复制失败') + ': ' + errorMessage(error); }).finally(() => { copying = false; render(); });
      });
    });
    root.querySelectorAll<HTMLElement>('[data-tab]').forEach(element => element.addEventListener('click', () => { state.tab = element.dataset.tab ?? 'overview'; render(); }));
    root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
      const action = button.dataset.action;
      const serviceStarting = state.snapshot?.service?.status === 'starting' && action?.startsWith('service-') === true;
      const stopUnavailable = (action === 'service-stop' && !serviceRunning()) || (action === 'stop' && !state.selected);
      button.disabled = state.busy || ((action === 'extension-check' || action === 'extension-update') && state.snapshot?.extension?.checking === true) || (action === 'extension-update' && state.snapshot?.extension?.updating === true) || serviceStarting || stopUnavailable || (!state.snapshot && action !== 'refresh');
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'refresh') { if (state.tab === 'logs') logBrowser.latest(); void refresh(); }
        else if (action === 'extension-check' || action === 'extension-update' || action === 'start' || action === 'stop' || action === 'service-start' || action === 'service-stop' || action === 'restart' || action === 'service-restart') void command(action);
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-log-page]').forEach(button => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        logBrowser.go(Number(button.dataset.logPage), state.logs);
        render();
        const nextButton = root.querySelector<HTMLButtonElement>(`[data-log-page][aria-label="${button.getAttribute('aria-label')}"]:not(:disabled)`);
        if (nextButton) nextButton.focus();
        else root.querySelector<HTMLButtonElement>('[data-log-page][aria-label]:not(:disabled)')?.focus();
      });
    });
    root.querySelectorAll<HTMLSelectElement>('[data-log-select]').forEach(select => {
      select.addEventListener('focus', () => { logSelectFocused = true; });
      select.addEventListener('blur', () => { logSelectFocused = false; });
      select.addEventListener('change', () => {
        if (select.dataset.logSelect === 'level') logBrowser.filter(select.value);
        else logBrowser.resize(Number(select.value));
        logSelectFocused = false;
        render();
        root.querySelector<HTMLSelectElement>(`[data-log-select="${select.dataset.logSelect}"]`)?.focus();
      });
    });
    const search = root.querySelector<HTMLInputElement>('[data-search]');
    search?.addEventListener('compositionstart', () => { composing = true; });
    search?.addEventListener('compositionend', () => { composing = false; state.query = search.value; render(); });
    search?.addEventListener('input', () => { state.query = search.value; render(); });
  };

  const definition = {
    template: '<div id="cocos-mcp-control-center"></div>',
    $: { root: '#cocos-mcp-control-center' },
    style: `
      :host { color: var(--color-normal-contrast, #e6e9f0); background: var(--color-normal-fill, #171a21); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif; font-size: 12px; }
      * { box-sizing: border-box; } #cocos-mcp-control-center { height: 100%; } .shell { height: 100%; display:flex; flex-direction:column; background: radial-gradient(circle at 0% 0%, rgba(79,125,255,.16), transparent 34%), var(--color-normal-fill, #171a21); }
      .hero { padding: 16px 18px 14px; display:flex; align-items:flex-start; justify-content:space-between; border-bottom:1px solid rgba(255,255,255,.07); } .brand { display:flex; gap:14px; align-items:center; } .brand-icon { width:42px; height:42px; border-radius:13px; display:grid; place-items:center; font-size:22px; color:#fff; background:linear-gradient(145deg,#6c8cff,#8366e8); box-shadow:0 8px 24px rgba(89,105,255,.32); } .eyebrow,.section-kicker { letter-spacing:.14em; font-size:9px; color:#8c9ac5; font-weight:700; } h1,h2,h3,p { margin:0; } h1 { margin-top:4px; font-size:20px; letter-spacing:-.03em; } .brand p { margin-top:5px; color:#8790a5; } .hero-actions { display:flex; gap:9px; align-items:center; } .status-pill { display:inline-flex; align-items:center; gap:7px; border-radius:999px; padding:6px 10px; color:#aeb6c8; background:rgba(255,255,255,.06); font-size:11px; } .status-pill i { width:7px; height:7px; border-radius:50%; background:#798297; } .status-pill.online { color:#79ddb4; background:rgba(70,194,139,.11); } .status-pill.online i { background:#52d99c; box-shadow:0 0 0 3px rgba(82,217,156,.13); } .icon-button,.secondary,.primary,.text-button { border:0; cursor:pointer; font:inherit; } .icon-button { width:29px; height:29px; border-radius:9px; color:#b3bdd4; background:rgba(255,255,255,.07); font-size:18px; } .icon-button:hover,.secondary:hover { background:rgba(255,255,255,.12); color:#fff; }
      .tabs { display:flex; flex-wrap:wrap; gap:5px; padding:6px 18px 0; border-bottom:1px solid rgba(255,255,255,.07); } .tab { border:0; background:none; color:#7e879b; cursor:pointer; padding:10px 13px 12px; font:600 12px inherit; border-bottom:2px solid transparent; } .tab.selected { color:#fff; border-color:#7188ff; } .tab em { font-style:normal; margin-left:4px; color:#8894b5; font-size:10px; }
      .content { flex:1; min-height:0; overflow:auto; padding:14px 18px; } .metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; } .metric-card,.panel-card,.runtime-card { border:1px solid rgba(255,255,255,.07); background:rgba(255,255,255,.035); border-radius:14px; } .metric-card { padding:15px; min-height:94px; } .metric-card.accent { background:linear-gradient(135deg,rgba(99,118,255,.2),rgba(99,118,255,.04)); border-color:rgba(112,134,255,.3); } .metric-card span { display:block; color:#8a94aa; font-size:11px; } .metric-card strong { display:block; margin-top:10px; color:#f1f3fa; font-size:17px; letter-spacing:-.02em; } .metric-card small { display:block; margin-top:6px; color:#7d879e; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .split-grid { display:grid; grid-template-columns:1.35fr 1fr; gap:12px; margin-top:12px; } .panel-card { padding:18px; min-height:245px; } .card-heading,.page-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; } h2 { margin-top:4px; font-size:17px; letter-spacing:-.02em; } .card-heading h2,.page-heading h2 { margin-bottom:4px; } .text-button { color:#8fa4ff; background:none; padding:3px 0; } .instance-list { margin-top:17px; } .instance-row { display:flex; align-items:center; gap:10px; padding:9px 0; border-bottom:1px solid rgba(255,255,255,.055); } .instance-icon { width:29px; height:29px; display:grid; place-items:center; border-radius:9px; color:#b5c0ff; background:rgba(108,131,255,.15); font-weight:700; font-size:10px; } .instance-main { flex:1; min-width:0; } .instance-main strong,.instance-main span { display:block; } .instance-main strong { color:#dce1ef; font-size:12px; } .instance-main span { margin-top:3px; color:#788399; font-size:10px; } .state { font-size:10px; white-space:nowrap; color:#aab3c7; } .state.online { color:#71d4a8; } .state.active { color:#7de1b7; } .state.planned { color:#e5bd74; } .state.muted { color:#7e8798; } .card-footer { display:flex; gap:8px; margin-top:15px; } .primary,.secondary { border-radius:8px; padding:8px 12px; } .primary { color:#fff; background:#5c73eb; box-shadow:0 5px 14px rgba(92,115,235,.25); } .primary:hover { background:#7188ff; } .secondary { color:#bbc3d4; background:rgba(255,255,255,.065); } .insight { background:linear-gradient(145deg,rgba(255,255,255,.055),rgba(255,255,255,.018)); } .insight h2 { margin-top:9px; } .insight p { margin-top:10px; line-height:1.65; color:#8992a8; } .check-list { display:grid; gap:9px; margin-top:18px; color:#aeb7ca; } .check-list i { display:inline-grid; place-items:center; width:17px; height:17px; margin-right:8px; border-radius:50%; color:#6ee0af; background:rgba(73,206,147,.12); font-style:normal; font-size:10px; }
      .tab-page { min-height:300px; } .page-heading p { margin-top:5px; color:#80899e; } .search { display:flex; align-items:center; gap:7px; width:220px; height:31px; padding:0 10px; border:1px solid rgba(255,255,255,.1); border-radius:9px; background:rgba(0,0,0,.14); color:#8995b3; } .search input { width:100%; border:0; outline:0; color:#e7eaf3; background:transparent; font:inherit; } .search input::placeholder { color:#727b90; } .capability-list { margin-top:17px; border-top:1px solid rgba(255,255,255,.07); } .capability-row { display:flex; align-items:center; gap:10px; min-height:54px; border-bottom:1px solid rgba(255,255,255,.055); } .capability-mark { width:7px; height:7px; margin-left:3px; border-radius:50%; background:#6f7a8e; } .capability-mark.active { background:#56d79e; box-shadow:0 0 0 3px rgba(86,215,158,.12); } .capability-mark.planned { background:#d6a75b; } .capability-main { display:flex; flex-direction:column; gap:4px; flex:1; min-width:0; } .capability-main strong { color:#dfe4f1; font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace; } .capability-main span { color:#818ba0; font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .capability-meta { display:flex; align-items:center; gap:6px; } .tag { border-radius:5px; padding:3px 5px; color:#909bb5; background:rgba(255,255,255,.06); font-size:9px; } .list-hint { padding:13px; text-align:center; color:#7d879c; } .log-list { margin-top:17px; border-top:1px solid rgba(255,255,255,.07); } .log-row { display:flex; align-items:center; gap:9px; min-height:38px; border-bottom:1px solid rgba(255,255,255,.05); font-size:10px; } .log-sequence { width:28px; color:#606b80; text-align:right; } .log-level { width:36px; text-transform:uppercase; font-size:9px; font-weight:700; } .log-level.info { color:#76a5ff; } .log-level.warn { color:#e3b86e; } .log-level.error { color:#f17f8b; } .log-message { flex:1; color:#b5bdce; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .log-row time { color:#697489; } .runtime-card { display:flex; align-items:center; gap:18px; margin-top:18px; padding:24px; } .runtime-orb { width:58px; height:58px; display:grid; place-items:center; border-radius:50%; color:#788398; background:rgba(255,255,255,.06); font-size:27px; } .runtime-orb.active { color:#6be0ad; background:rgba(74,207,148,.11); box-shadow:0 0 0 8px rgba(74,207,148,.05); } .runtime-card h3 { font-size:14px; } .runtime-card p { margin-top:6px; color:#828da3; } .runtime-features { display:flex; flex-wrap:wrap; gap:7px; margin-top:13px; } .runtime-features span { padding:7px 10px; border-radius:7px; color:#a9b2c6; background:rgba(255,255,255,.05); } .notice { margin-bottom:14px; padding:10px 12px; border-radius:9px; font-size:11px; } .notice.error { color:#ffabb4; background:rgba(231,91,111,.12); border:1px solid rgba(231,91,111,.2); } .notice span { display:inline-grid; place-items:center; width:16px; height:16px; margin-right:7px; border-radius:50%; background:#d85f73; color:#fff; } .empty { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:145px; text-align:center; color:#818ba1; } .empty > span { margin-bottom:8px; color:#68758f; font-size:26px; } .empty strong { color:#bdc5d5; font-size:12px; } .empty small { margin-top:5px; color:#727e96; } .footer { display:flex; justify-content:space-between; padding:11px 28px 14px; color:#626d83; font-size:10px; } @media (max-width: 620px) { .hero,.content { padding-left:18px; padding-right:18px; } .tabs { padding-left:18px; } .metric-grid { grid-template-columns:repeat(2,1fr); } .split-grid { grid-template-columns:1fr; } .capability-meta .tag { display:none; } }
      /* 固定区域不参与纵向压缩，只有内容区滚动，避免卡片滑到标签栏下方。 */
      .info-card { margin-top:18px; padding:24px; } .info-card p { margin:14px 0; line-height:1.65; color:#a9b2c6; } .info-card dl { display:grid; grid-template-columns:100px minmax(0,1fr); gap:12px; margin:20px 0; } .info-card dt { color:#8995ad; } .info-card dd { margin:0; overflow-wrap:anywhere; user-select:text; } .info-actions { display:flex; gap:10px; flex-wrap:wrap; }
      :host { display:block; height:100%; min-height:0; overflow:hidden; }
      .shell { min-height:0; overflow:hidden; }
      .hero,.tabs,.footer { flex-shrink:0; }
      .content { scroll-padding-top:22px; }
      .service-card { min-height:0; margin-bottom:18px; } .service-card p { margin-top:10px; line-height:1.6; overflow-wrap:anywhere; } .service-card code { user-select:text; }
      .metric-grid,.split-grid { align-items:stretch; }
      .log-filter,.page-size { display:flex; align-items:center; gap:10px; } .control-label { color:#b4bed3; font-size:11px; }
      .select-shell { position:relative; display:inline-flex; align-items:center; border:1px solid rgba(156,173,219,.22); border-radius:9px; background:#262c3a; box-shadow:0 2px 6px rgba(0,0,0,.12),inset 0 1px 0 rgba(255,255,255,.04); transition:border-color 140ms ease,background 140ms ease; }
      .select-shell:hover { border-color:#7387ba; background:#30384a; } .select-shell:focus-within { border-color:#92a6ff; outline:2px solid rgba(146,166,255,.35); outline-offset:2px; }
      .select-shell select { appearance:none; -webkit-appearance:none; color:#e4e9f6; background:transparent; border:0; border-radius:inherit; font:500 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; padding:0 30px 0 26px; height:28px; min-width:132px; line-height:normal; cursor:pointer; outline:none; color-scheme:dark; }
      .select-shell option { color:#e4e9f6; background:#262c3a; } .select-chevron { position:absolute; top:0; bottom:0; right:4px; width:22px; display:flex; align-items:center; justify-content:center; color:#9caac5; pointer-events:none; } .select-chevron svg { display:block; flex-shrink:0; }
      .level-dot { position:absolute; left:10px; top:50%; transform:translateY(-50%); width:6px; height:6px; border-radius:50%; background:#a5b4d6; pointer-events:none; } .level-dot.error { background:#ff95a2; } .level-dot.warn { background:#efc77c; } .level-dot.info { background:#8eb6ff; }
      .log-update-state { display:flex; align-items:center; flex-wrap:wrap; gap:7px; color:#a3aec5; font-size:10px; } .log-update-state > i { width:5px; height:5px; border-radius:50%; background:#71d4a8; } .log-update-state > i.paused { background:#e3b86e; } .log-update-state button { margin-left:4px; }
      .logs-page .log-list { margin-top:0; border-top:0; } .logs-page .log-row { min-height:32px; } .logs-page .log-sequence { width:42px; flex-shrink:0; font-variant-numeric:tabular-nums; }
      .log-pagination { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; padding:10px 0; } .log-range { color:#a3aec5; font-size:11px; font-variant-numeric:tabular-nums; }
      .log-page-controls { display:flex; align-items:center; flex-wrap:wrap; gap:16px; } .page-size { color:#a3aec5; font-size:11px; gap:8px; } .compact select { min-width:82px; padding-left:12px; }
      .page-navigation { display:flex; align-items:center; gap:5px; } .page-button { width:30px; height:30px; border:1px solid rgba(156,173,219,.18); border-radius:9px; background:rgba(255,255,255,.045); color:#d7dff2; font:22px -apple-system,sans-serif; cursor:pointer; }
      .page-button:hover:not(:disabled) { background:rgba(113,136,255,.16); border-color:#7387ba; } .page-button:active:not(:disabled) { background:rgba(113,136,255,.28); } .page-button:disabled { opacity:.32; cursor:default; } .page-button:focus-visible,.logs-page button:focus-visible { outline:2px solid #92a6ff; outline-offset:3px; }
      .page-position { display:flex; gap:6px; justify-content:center; min-width:64px; font-size:11px; font-variant-numeric:tabular-nums; } .page-position strong { color:#e3e9ff; } .page-position > span { color:#a3aec5; }
      @media (max-width:480px) { .log-page-controls { width:100%; justify-content:space-between; gap:8px; } }
      .hero-actions { flex-wrap:wrap; justify-content:flex-end; }
      .language-switch { display:inline-flex; align-items:center; padding:3px; gap:2px; border:1px solid rgba(160,174,203,.13); border-radius:9px; background:rgba(0,0,0,.14); }
      .language-option { border:0; border-radius:6px; min-width:35px; min-height:24px; padding:3px 8px; background:transparent; color:#8e99af; font:500 10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; cursor:pointer; transition:background .15s,color .15s; }
      .language-option[aria-pressed="true"] { color:#e3eaff; background:rgba(135,157,226,.2); box-shadow:0 1px 3px rgba(0,0,0,.16); }
      .language-option:hover:not([aria-pressed="true"]) { color:#e3eaff; background:rgba(255,255,255,.05); }
      .language-option:focus-visible,.log-icon-button:focus-visible { outline:2px solid #92a6ff; outline-offset:2px; }
      .logs-page .log-header { display:flex; flex-direction:column; gap:7px; padding:0 0 12px; border-bottom:1px solid rgba(156,173,219,.14); }
      .log-heading-main { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; flex-wrap:wrap; }
      .log-heading-main h2 { margin:0; font-size:15px; }
      .log-heading-actions { display:flex; align-items:center; gap:4px; }
      .log-heading-actions .select-shell { background:rgba(255,255,255,.025); border-color:rgba(156,173,219,.16); border-radius:7px; }
      .log-heading-actions select { width:132px; min-width:132px; height:28px; font-size:11px; }
      .log-action-divider { height:16px; width:1px; margin:0 4px; background:rgba(156,173,219,.16); }
      .log-icon-button { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; flex-shrink:0; border:1px solid transparent; border-radius:6px; background:transparent; color:#9daecb; cursor:pointer; }
      .log-icon-button:hover:not(:disabled) { color:#e2eaff; background:rgba(135,157,226,.13); border-color:rgba(156,173,219,.15); }
      .log-icon-button:disabled { opacity:.3; cursor:default; }
      .log-copy { width:24px; height:24px; color:#8998b3; }
      .log-heading-foot { display:flex; align-items:center; justify-content:space-between; gap:6px 14px; flex-wrap:wrap; width:100%; }
      .log-heading-foot p { margin:0; font-size:10px; line-height:1.5; }
      .log-heading-foot .log-update-state { font-size:9px; }
      .log-message { min-width:0; } .log-row time { flex-shrink:0; }
      .copy-feedback { color:#a8b9ed; font-size:10px; overflow-wrap:anywhere; } .copy-feedback:empty { display:none; }
      @media (max-width:620px) { .hero { gap:10px; flex-wrap:wrap; } .brand p { display:none; } .log-update-state { margin-left:0; } }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration:.01ms !important; animation-duration:.01ms !important; } }
    `,
    async ready(this: { $?: { root: HTMLElement }; $root?: HTMLElement }): Promise<void> {
      // Creator 2 将选择器映射为 this.$root，Creator 3 才使用 this.$.root。
      const element = major === 2 ? this.$root : this.$?.root;
      if (!element) throw new Error(`Creator ${major} control center root element is unavailable`);
      root = element;
      render();
      await refresh();
      // ready 等待 IPC 时用户可能已关闭面板，不能再创建轮询或写入已卸载的 DOM。
      if (!disposed) timer = setInterval(() => { if (!state.busy) void refresh(); }, 5000);
    },
    // Creator 2 的 close 返回 true 才允许关闭；Creator 3 忽略该返回值。
    close(): boolean { disposed = true; if (timer) clearInterval(timer); timer = undefined; return true; },
  };
  return definition;
}
