import { Operations } from '../../packages/capability-catalog/src/operations.js';
import type { PanelState } from '../../packages/editor-bridge/src/panel-state.js';

interface PanelEditor {
  Message?: { request(extension: string, message: string): Promise<unknown> };
  Ipc?: { sendToMain(message: string, callback: (error: { message?: string } | null, result: unknown) => void): void };
}
declare const Editor: PanelEditor;
const operations = new Operations().list();
function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

function request(major: 2 | 3, message: 'panel-state'): Promise<PanelState>;
function request(major: 2 | 3, message: 'extension-update' | 'start' | 'stop' | 'service-start' | 'service-stop'): Promise<unknown>;
function request(major: 2 | 3, message: string): Promise<unknown> {
  // 面板只通过编辑器 IPC 读取脱敏状态；浏览器请求会带 Origin，不能使用外部 MCP 的认证通道。
  return new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error('编辑器响应超时，请检查扩展是否启用后刷新')), message === 'extension-update' ? 125000 : message.startsWith('service-') ? 25000 : 10000);
    const finish = (error: unknown, result?: unknown): void => {
      clearTimeout(timeout);
      if (error) reject(error); else accept(result);
    };
    try {
      if (major === 3 && Editor.Message) void Editor.Message.request('cocos-mcp-creator3', message).then(result => finish(null, result), finish);
      else if (major === 2 && Editor.Ipc) Editor.Ipc.sendToMain(`cocos-mcp-creator2:${message}`, finish);
      else finish(new Error('当前编辑器未提供面板消息接口'));
    } catch (error) { finish(error); }
  });
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

export function createPanelDefinition(major: 2 | 3) {
  const state = { tab: 'overview', query: '', snapshot: null as PanelState | null, selected: null as PanelState['instance'], supported: [] as string[], logs: [] as PanelState['logs'], runtime: false, error: '', busy: false };
  let root: HTMLElement;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  let disposed = false;
  let composing = false;

  const render = (): void => {
    if (disposed || composing) return;
    const previousSearch = root.querySelector<HTMLInputElement>('[data-search]');
    const focused = previousSearch && (root.getRootNode() as Document | ShadowRoot).activeElement === previousSearch;
    const selection = focused ? [previousSearch.selectionStart, previousSearch.selectionEnd] : null;
    const scrollTop = root.querySelector<HTMLElement>('.content')?.scrollTop ?? 0;
    const descriptor = state.selected;
    const status = state.error ? '连接异常' : descriptor ? '桥接已启动' : state.snapshot ? '已停止' : '正在连接';
    const statusClass = !state.error && descriptor ? 'online' : 'offline';
    const service = state.snapshot?.service;
    const serviceLabel = service?.status === 'running' ? '已启动' : service?.status === 'starting' ? '启动中' : service?.status === 'error' ? '启动失败' : '未启动';
    const serviceCard = `<section class="panel-card service-card"><h2>MCP 服务 · ${serviceLabel}</h2><p>启动本工程的 MCP 服务及运行时网关。游戏预览仍需接入运行时桥接。</p>${service?.endpoint ? `<p>连接地址：<code>${esc(service.endpoint)}</code></p><p>客户端使用 Bearer token，凭证文件：<code>.codex-work/cache/cocos-mcp/mcp-http-token</code></p>` : ''}${service?.error ? `<div class="notice error">${esc(service.error)}</div>` : ''}<div class="card-footer"><button class="primary" data-action="${service?.status === 'running' ? 'service-restart' : 'service-start'}">${service?.status === 'running' ? '重启' : '启动'} MCP 服务</button><button class="secondary" data-action="service-stop">停止 MCP 服务</button></div><p>由此处启动的服务随扩展卸载或编辑器退出而停止；关闭面板不停止服务。</p></section>`;
    const runtimeStatus = state.snapshot?.runtimeStatus;
    const runtimeLabel = runtimeStatus?.error ? '查询异常' : runtimeStatus?.connected ? `已连接 ${runtimeStatus.connected}` : state.runtime ? '等待游戏连接' : '网关未启动';
    const supportedCount = operations.filter(row => state.supported.includes(row.id)).length;
    const filtered = operations.filter(row => !state.query || `${row.id} ${row.title} ${row.module}`.toLowerCase().includes(state.query.toLowerCase()));
    const capabilities = filtered.slice(0, 120).map(row => {
      const active = state.supported.includes(row.id);
      const stateText = row.implementation === 'planned' ? '规划中' : !(row.supportedMajors ?? row.versions).includes(major) ? '版本不支持' : row.context === 'runtime' ? '需运行时' : active ? (descriptor ? '可用' : '需启动桥接') : '未暴露';
      const stateKind = row.implementation === 'planned' ? 'planned' : active ? 'active' : 'muted';
      return `<article class="capability-row"><div class="capability-mark ${stateKind}"></div><div class="capability-main"><strong>${esc(row.id)}</strong><span>${esc(row.title)}</span></div><div class="capability-meta"><span class="tag">${esc(row.module)}</span><span class="tag">${esc(row.effect)}</span><span class="state ${stateKind}">${stateText}</span></div></article>`;
    }).join('');
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const clock = new Intl.DateTimeFormat(undefined, { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const logs = state.logs.slice(-80).reverse().map(log => {
      const date = typeof log.occurredAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(log.occurredAt) ? new Date(log.occurredAt) : null;
      const time = date && Number.isFinite(date.getTime()) ? clock.format(date) : '—';
      return `<div class="log-row"><span class="log-sequence">#${esc(log.sequence)}</span><span class="log-level ${esc(log.level)}">${esc(log.level)}</span><span class="log-message">${esc(log.message)}</span><time title="${esc(timeZone)}">${esc(time)}</time></div>`;
    }).join('');
    const instances = descriptor ? `<div class="instance-row"><div class="instance-icon">C${descriptor.creatorMajor}</div><div class="instance-main"><strong>Creator ${esc(descriptor.editorVersion)}</strong><span>${esc(descriptor.instanceId.slice(0, 12))} · PID ${esc(descriptor.pid)}</span></div><span class="state online">桥接已启动</span></div>` : '';
    root.innerHTML = `<div class="shell">
      <header class="hero"><div class="brand"><div class="brand-icon">✦</div><div><div class="eyebrow">COCOSMCP CONTROL CENTER</div><h1>控制中心</h1><p>让编辑器状态、能力和运行时保持可见</p></div></div><div class="hero-actions"><span class="status-pill ${statusClass}"><i></i>${status}</span><button class="icon-button" data-action="refresh" aria-label="刷新">↻</button></div></header>
      <nav class="tabs" role="tablist"><button class="tab ${state.tab === 'overview' ? 'selected' : ''}" data-tab="overview">总览</button><button class="tab ${state.tab === 'capabilities' ? 'selected' : ''}" data-tab="capabilities">能力 <em>${supportedCount} / ${operations.length}</em></button><button class="tab ${state.tab === 'logs' ? 'selected' : ''}" data-tab="logs">桥接日志 ${state.logs.length ? `<em>${state.logs.length}</em>` : ''}</button><button class="tab ${state.tab === 'runtime' ? 'selected' : ''}" data-tab="runtime">运行时</button></nav>
      <main class="content">${state.error ? `<div class="notice error"><span>!</span>${esc(state.error)}</div>` : ''}
        ${state.tab === 'overview' ? `<section class="overview">${serviceCard}<div class="metric-grid"><div class="metric-card accent"><span>编辑器</span><strong>${state.snapshot ? `Creator ${esc(state.snapshot.editorVersion)}` : '等待连接'}</strong><small>${state.snapshot ? `大版本 ${major}.x` : '正在读取编辑器状态'}</small></div><div class="metric-card"><span>工程</span><strong>${state.snapshot ? '已识别' : '读取中'}</strong><small class="truncate" title="${esc(state.snapshot?.projectPath)}">${esc(state.snapshot?.projectPath)}</small></div><div class="metric-card"><span>实例</span><strong>${descriptor ? 1 : 0}</strong><small>当前窗口的桥接实例</small></div><div class="metric-card"><span>运行时</span><strong>${runtimeLabel}</strong><small>${runtimeStatus?.error ? esc(runtimeStatus.error) : '开发游戏会话状态'}</small></div></div><div class="split-grid"><section class="panel-card"><div class="card-heading"><div><span class="section-kicker">EDITOR INSTANCES</span><h2>当前窗口实例</h2></div><button class="text-button" data-tab="capabilities">查看能力 →</button></div><div class="instance-list">${instances || '<div class="empty"><span>◌</span><strong>尚未连接 Creator</strong><small>在 Creator 菜单中启动 CocosMCP 桥接</small></div>'}</div><div class="card-footer"><button class="primary" data-action="${descriptor ? 'restart' : 'start'}">${descriptor ? '重启' : '启动'}桥接</button><button class="secondary" data-action="stop">停止桥接</button></div></section><section class="panel-card insight"><div class="section-kicker">QUICK INSIGHT</div><h2>连接范围</h2><p>桥接已启动仅表示当前编辑器监听就绪。此面板尚未监测 MCP 客户端连接；游戏连接请查看运行时状态。</p><div class="check-list"><span><i>✓</i>路径限制在工程内</span><span><i>✓</i>操作支持幂等重试</span><span><i>✓</i>运行时默认开发模式</span></div></section></div></section>` : ''}
        ${state.tab === 'capabilities' ? `<section class="tab-page"><div class="page-heading"><div><span class="section-kicker">CAPABILITY CATALOG</span><h2>能力目录</h2><p>当前适配器支持 ${supportedCount} 项 / 注册目录 ${operations.length} 项；支持不代表已通过实机验证</p></div><div class="search"><span>⌕</span><input data-search placeholder="搜索能力、模块或描述" value="${esc(state.query)}" aria-label="搜索能力" /></div></div><div class="capability-list">${capabilities || '<div class="empty"><span>⌕</span><strong>没有匹配的能力</strong><small>尝试搜索 scene、asset 或 runtime</small></div>'}</div>${filtered.length > 120 ? `<div class="list-hint">仅显示前 120 项，请缩小搜索范围</div>` : ''}</section>` : ''}
        ${state.tab === 'logs' ? `<section class="tab-page"><div class="page-heading"><div><span class="section-kicker">BRIDGE EVENTS</span><h2>桥接日志</h2><p>桥接启停和操作事件，每 5 秒刷新；不包含 Creator 控制台日志</p></div><button class="secondary" data-action="refresh">刷新日志</button></div><div class="log-list">${logs || '<div class="empty"><span>◌</span><strong>暂无日志</strong><small>启动桥接后会显示连接和操作事件</small></div>'}</div></section>` : ''}
        ${state.tab === 'runtime' ? `<section class="tab-page runtime-page">${serviceCard}<div class="page-heading"><div><span class="section-kicker">DEVELOPMENT RUNTIME</span><h2>运行时状态</h2><p>开发预览连接和调试能力</p></div><span class="status-pill ${state.runtime ? 'online' : 'offline'}"><i></i>${runtimeLabel}</span></div><div class="runtime-card"><div class="runtime-orb ${state.runtime ? 'active' : ''}"><span>◎</span></div><div><h3>${runtimeLabel}</h3><p>${runtimeStatus?.error ? esc(runtimeStatus.error) : runtimeStatus?.connected ? '已从开发网关读取游戏会话，超过 30 秒没有心跳的会话不计入连接数。' : '启动 MCP 服务并在开发预览中接入运行时桥接。'}</p></div></div><div class="runtime-features"><span>对象检查</span><span>属性读写</span><span>事件订阅</span><span>截图</span><span>性能指标</span></div></section>` : ''}
      </main><footer class="footer"><span>CocosMCP ${esc(state.snapshot?.extension?.version ?? '读取中')} <code>${esc(state.snapshot?.extension?.buildId)}</code> <button class="text-button" data-action="extension-update">${state.snapshot?.extension?.updating ? '更新中…' : '更新版本'}</button><small style="display:block">${state.snapshot?.extension?.reloadRequired ? `已安装 ${esc(state.snapshot.extension.installedVersion)} · ${esc(state.snapshot.extension.installedBuildId)}，待重载。` : ''}${esc(state.snapshot?.extension?.message ?? (state.snapshot?.extension?.latestVersion ? `GitHub 最新：${state.snapshot.extension.latestVersion}` : state.snapshot?.extension?.checking ? '正在检查 GitHub 版本…' : '更新源：GitHub · iEfoam/CocosMcp'))}</small></span><span>日志时区：${esc(timeZone)}</span></footer>
    </div>`;
    bind();
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
      state.snapshot = snapshot; state.selected = snapshot.instance;
      state.supported = snapshot.supportedCapabilities; state.logs = snapshot.logs;
      state.runtime = snapshot.runtimeConfigured; state.error = '';
    }).catch(error => {
      if (disposed) return;
      state.selected = null; state.supported = []; state.runtime = false;
      state.error = errorMessage(error);
    }).finally(() => { pending = undefined; render(); });
    return pending;
  };

  const command = async (action: 'extension-update' | 'start' | 'stop' | 'restart' | 'service-start' | 'service-stop' | 'service-restart'): Promise<void> => {
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

  const serviceRunning = (): boolean => ['running', 'starting'].includes(state.snapshot?.service?.status ?? '');
  const bind = (): void => {
    root.querySelectorAll<HTMLElement>('[data-tab]').forEach(element => element.addEventListener('click', () => { state.tab = element.dataset.tab ?? 'overview'; render(); }));
    root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
      const action = button.dataset.action;
      const serviceStarting = state.snapshot?.service?.status === 'starting' && action?.startsWith('service-') === true;
      const stopUnavailable = (action === 'service-stop' && !serviceRunning()) || (action === 'stop' && !state.selected);
      button.disabled = state.busy || (action === 'extension-update' && state.snapshot?.extension?.updating === true) || serviceStarting || stopUnavailable || (!state.snapshot && action !== 'refresh');
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'refresh') void refresh();
        else if (action === 'extension-update' || action === 'start' || action === 'stop' || action === 'service-start' || action === 'service-stop' || action === 'restart' || action === 'service-restart') void command(action);
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
      .hero { padding: 26px 28px 22px; display:flex; align-items:flex-start; justify-content:space-between; border-bottom:1px solid rgba(255,255,255,.07); } .brand { display:flex; gap:14px; align-items:center; } .brand-icon { width:42px; height:42px; border-radius:13px; display:grid; place-items:center; font-size:22px; color:#fff; background:linear-gradient(145deg,#6c8cff,#8366e8); box-shadow:0 8px 24px rgba(89,105,255,.32); } .eyebrow,.section-kicker { letter-spacing:.14em; font-size:9px; color:#8c9ac5; font-weight:700; } h1,h2,h3,p { margin:0; } h1 { margin-top:4px; font-size:24px; letter-spacing:-.03em; } .brand p { margin-top:5px; color:#8790a5; } .hero-actions { display:flex; gap:9px; align-items:center; } .status-pill { display:inline-flex; align-items:center; gap:7px; border-radius:999px; padding:6px 10px; color:#aeb6c8; background:rgba(255,255,255,.06); font-size:11px; } .status-pill i { width:7px; height:7px; border-radius:50%; background:#798297; } .status-pill.online { color:#79ddb4; background:rgba(70,194,139,.11); } .status-pill.online i { background:#52d99c; box-shadow:0 0 0 3px rgba(82,217,156,.13); } .icon-button,.secondary,.primary,.text-button { border:0; cursor:pointer; font:inherit; } .icon-button { width:29px; height:29px; border-radius:9px; color:#b3bdd4; background:rgba(255,255,255,.07); font-size:18px; } .icon-button:hover,.secondary:hover { background:rgba(255,255,255,.12); color:#fff; }
      .tabs { display:flex; gap:5px; padding:10px 28px 0; border-bottom:1px solid rgba(255,255,255,.07); } .tab { border:0; background:none; color:#7e879b; cursor:pointer; padding:10px 13px 12px; font:600 12px inherit; border-bottom:2px solid transparent; } .tab.selected { color:#fff; border-color:#7188ff; } .tab em { font-style:normal; margin-left:4px; color:#8894b5; font-size:10px; }
      .content { flex:1; min-height:0; overflow:auto; padding:22px 28px; } .metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; } .metric-card,.panel-card,.runtime-card { border:1px solid rgba(255,255,255,.07); background:rgba(255,255,255,.035); border-radius:14px; } .metric-card { padding:15px; min-height:94px; } .metric-card.accent { background:linear-gradient(135deg,rgba(99,118,255,.2),rgba(99,118,255,.04)); border-color:rgba(112,134,255,.3); } .metric-card span { display:block; color:#8a94aa; font-size:11px; } .metric-card strong { display:block; margin-top:10px; color:#f1f3fa; font-size:17px; letter-spacing:-.02em; } .metric-card small { display:block; margin-top:6px; color:#7d879e; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .split-grid { display:grid; grid-template-columns:1.35fr 1fr; gap:12px; margin-top:12px; } .panel-card { padding:18px; min-height:245px; } .card-heading,.page-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; } h2 { margin-top:4px; font-size:17px; letter-spacing:-.02em; } .card-heading h2,.page-heading h2 { margin-bottom:4px; } .text-button { color:#8fa4ff; background:none; padding:3px 0; } .instance-list { margin-top:17px; } .instance-row { display:flex; align-items:center; gap:10px; padding:9px 0; border-bottom:1px solid rgba(255,255,255,.055); } .instance-icon { width:29px; height:29px; display:grid; place-items:center; border-radius:9px; color:#b5c0ff; background:rgba(108,131,255,.15); font-weight:700; font-size:10px; } .instance-main { flex:1; min-width:0; } .instance-main strong,.instance-main span { display:block; } .instance-main strong { color:#dce1ef; font-size:12px; } .instance-main span { margin-top:3px; color:#788399; font-size:10px; } .state { font-size:10px; white-space:nowrap; color:#aab3c7; } .state.online { color:#71d4a8; } .state.active { color:#7de1b7; } .state.planned { color:#e5bd74; } .state.muted { color:#7e8798; } .card-footer { display:flex; gap:8px; margin-top:15px; } .primary,.secondary { border-radius:8px; padding:8px 12px; } .primary { color:#fff; background:#5c73eb; box-shadow:0 5px 14px rgba(92,115,235,.25); } .primary:hover { background:#7188ff; } .secondary { color:#bbc3d4; background:rgba(255,255,255,.065); } .insight { background:linear-gradient(145deg,rgba(255,255,255,.055),rgba(255,255,255,.018)); } .insight h2 { margin-top:9px; } .insight p { margin-top:10px; line-height:1.65; color:#8992a8; } .check-list { display:grid; gap:9px; margin-top:18px; color:#aeb7ca; } .check-list i { display:inline-grid; place-items:center; width:17px; height:17px; margin-right:8px; border-radius:50%; color:#6ee0af; background:rgba(73,206,147,.12); font-style:normal; font-size:10px; }
      .tab-page { min-height:300px; } .page-heading p { margin-top:5px; color:#80899e; } .search { display:flex; align-items:center; gap:7px; width:220px; height:31px; padding:0 10px; border:1px solid rgba(255,255,255,.1); border-radius:9px; background:rgba(0,0,0,.14); color:#8995b3; } .search input { width:100%; border:0; outline:0; color:#e7eaf3; background:transparent; font:inherit; } .search input::placeholder { color:#727b90; } .capability-list { margin-top:17px; border-top:1px solid rgba(255,255,255,.07); } .capability-row { display:flex; align-items:center; gap:10px; min-height:54px; border-bottom:1px solid rgba(255,255,255,.055); } .capability-mark { width:7px; height:7px; margin-left:3px; border-radius:50%; background:#6f7a8e; } .capability-mark.active { background:#56d79e; box-shadow:0 0 0 3px rgba(86,215,158,.12); } .capability-mark.planned { background:#d6a75b; } .capability-main { display:flex; flex-direction:column; gap:4px; flex:1; min-width:0; } .capability-main strong { color:#dfe4f1; font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace; } .capability-main span { color:#818ba0; font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .capability-meta { display:flex; align-items:center; gap:6px; } .tag { border-radius:5px; padding:3px 5px; color:#909bb5; background:rgba(255,255,255,.06); font-size:9px; } .list-hint { padding:13px; text-align:center; color:#7d879c; } .log-list { margin-top:17px; border-top:1px solid rgba(255,255,255,.07); } .log-row { display:flex; align-items:center; gap:9px; min-height:38px; border-bottom:1px solid rgba(255,255,255,.05); font-size:10px; } .log-sequence { width:28px; color:#606b80; text-align:right; } .log-level { width:36px; text-transform:uppercase; font-size:9px; font-weight:700; } .log-level.info { color:#76a5ff; } .log-level.warn { color:#e3b86e; } .log-level.error { color:#f17f8b; } .log-message { flex:1; color:#b5bdce; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .log-row time { color:#697489; } .runtime-card { display:flex; align-items:center; gap:18px; margin-top:18px; padding:24px; } .runtime-orb { width:58px; height:58px; display:grid; place-items:center; border-radius:50%; color:#788398; background:rgba(255,255,255,.06); font-size:27px; } .runtime-orb.active { color:#6be0ad; background:rgba(74,207,148,.11); box-shadow:0 0 0 8px rgba(74,207,148,.05); } .runtime-card h3 { font-size:14px; } .runtime-card p { margin-top:6px; color:#828da3; } .runtime-features { display:flex; flex-wrap:wrap; gap:7px; margin-top:13px; } .runtime-features span { padding:7px 10px; border-radius:7px; color:#a9b2c6; background:rgba(255,255,255,.05); } .notice { margin-bottom:14px; padding:10px 12px; border-radius:9px; font-size:11px; } .notice.error { color:#ffabb4; background:rgba(231,91,111,.12); border:1px solid rgba(231,91,111,.2); } .notice span { display:inline-grid; place-items:center; width:16px; height:16px; margin-right:7px; border-radius:50%; background:#d85f73; color:#fff; } .empty { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:145px; text-align:center; color:#818ba1; } .empty > span { margin-bottom:8px; color:#68758f; font-size:26px; } .empty strong { color:#bdc5d5; font-size:12px; } .empty small { margin-top:5px; color:#727e96; } .footer { display:flex; justify-content:space-between; padding:11px 28px 14px; color:#626d83; font-size:10px; } @media (max-width: 620px) { .hero,.content { padding-left:18px; padding-right:18px; } .tabs { padding-left:18px; } .metric-grid { grid-template-columns:repeat(2,1fr); } .split-grid { grid-template-columns:1fr; } .capability-meta .tag { display:none; } }
      /* 固定区域不参与纵向压缩，只有内容区滚动，避免卡片滑到标签栏下方。 */
      :host { display:block; height:100%; min-height:0; overflow:hidden; }
      .shell { min-height:0; overflow:hidden; }
      .hero,.tabs,.footer { flex-shrink:0; }
      .content { scroll-padding-top:22px; }
      .service-card { min-height:0; margin-bottom:18px; } .service-card p { margin-top:10px; line-height:1.6; overflow-wrap:anywhere; } .service-card code { user-select:text; }
      .metric-grid,.split-grid { align-items:stretch; }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration:.01ms !important; animation-duration:.01ms !important; } }
    `,
    async ready(this: { $: { root: HTMLElement } }): Promise<void> {
      root = this.$.root;
      render();
      await refresh();
      // ready 等待 IPC 时用户可能已关闭面板，不能再创建轮询或写入已卸载的 DOM。
      if (!disposed) timer = setInterval(() => { if (!state.busy) void refresh(); }, 5000);
    },
    close(): void { disposed = true; if (timer) clearInterval(timer); timer = undefined; },
  };
  return definition;
}
