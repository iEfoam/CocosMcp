import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CreatorAccount } from './creator-account.mjs';
import { CreatorSessionStore } from './creator-session-store.mjs';

/** 只启动一次，登录未知/失效时保留现有窗口；原生登录由用户完成，不执行账号切换或登录请求。 */
export class CreatorLauncher {
  constructor(account = new CreatorAccount(), options = {}) {
    this.account = account; this.timeoutMs = options.timeoutMs ?? 45000; this.pollMs = options.pollMs ?? 500;
  }
  alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  }
  spawnEditor(executable, args, options) { return spawn(executable, args, options); }
  readJournal(bytes) {
    if (!bytes) return null;
    let journal;
    try { journal = JSON.parse(bytes); } catch { throw new Error('Creator launch state cannot be read safely; inspect the existing window'); }
    const states = ['reserved', 'starting', 'ready', 'login-required', 'unverified', 'spawn-failed'];
    const pidValid = Number.isInteger(journal?.pid) && journal.pid > 0 || ['reserved', 'spawn-failed'].includes(journal?.state) && journal.pid === null;
    if (journal?.schemaVersion !== 1 || !states.includes(journal.state) || !pidValid || !/^[a-f0-9]{64}$/.test(journal.credentialFingerprint ?? '') || typeof journal.attemptedAt !== 'string' || !Number.isFinite(Date.parse(journal.attemptedAt))) {
      throw new Error('Unknown or incomplete Creator launch state; another window was not started');
    }
    return journal;
  }
  async reuse(root, editor) {
    if (editor.loginState !== 'logged-in' || !editor.pid) return editor;
    const store = new CreatorSessionStore(root), path = join(root, '.codex-work/cache/creator-session/launch.json');
    const bytes = await store.read(path); if (!bytes) return editor;
    // 上一次等待超时后用户可能才完成登录；读到同一 PID 的已登录桥接后恢复正常关闭/重开路径。
    try {
      await store.locked('launch', async () => {
        const current = await store.read(path), journal = this.readJournal(current);
        if (journal.schemaVersion === 1 && journal.pid === editor.pid && journal.state !== 'ready') await store.write(path, JSON.stringify({ ...journal, state: 'ready' }), current);
      });
    } catch { return { ...editor, launchState: 'reconciliation-pending' }; }
    return editor;
  }
  async plan(project, executable, major) {
    const root = await realpath(project), binary = await realpath(executable);
    if (!(await stat(root)).isDirectory() || !(await stat(binary)).isFile()) throw new Error('Expected a project directory and a Creator executable');
    if (![2, 3].includes(major)) throw new Error('Specify Creator major 2 or 3');
    const work = join(root, '.codex-work'), home = join(work, 'cache/creator-home'), userData = join(work, 'cache/shader-editor');
    return { project: root, executable: binary, major, home, userData,
      args: major === 2 ? [`--user-data-dir=${userData}`, '--path', root] : ['--home', home, `--user-data-dir=${userData}`, '--project', root] };
  }
  async launch(project, executable, major, options = {}) {
    const plan = await this.plan(project, executable, major), root = plan.project, store = new CreatorSessionStore(root);
    const selection = { major, ...(options.instanceId ? { instanceId: options.instanceId } : {}) };
    const existing = await this.account.existing(root, selection);
    if (existing) return this.reuse(root, existing);
    // 2.x 必须由已登录 Dashboard 打开；提前拒绝，不复制另一种账号格式，更不启动登录窗口。
    if (major === 2) return { status: 'dashboard-required', loginState: 'unknown', nextAction: 'reuse-logged-in-dashboard' };
    return store.locked('launch', async () => {
      const opened = await this.account.existing(root, selection); if (opened) return opened;
      const journalPath = join(root, '.codex-work/cache/creator-session/launch.json');
      const journalBytes = await store.read(journalPath);
      const previous = this.readJournal(journalBytes);
      if (previous?.state === 'reserved') return { status: 'launch-outcome-unknown', loginState: 'unknown', nextAction: 'inspect-original-launch' };
      if (previous?.pid && this.alive(previous.pid) && await this.account.processState(previous.pid) !== 'other') return { status: 'existing-launch-present', loginState: 'unknown', pid: previous.pid, nextAction: 'inspect-existing-window' };
      const session = await this.account.prepare(root, major);
      if (session.account === 'unavailable' || !session.credentialFingerprint) return { status: 'session-unavailable', loginState: 'unknown', nextAction: session.nextAction ?? 'reuse-logged-in-dashboard' };
      const appeared = await this.account.existing(root, selection); if (appeared) return appeared;
      // 同一凭据已启动却未确认登录，不靠重复打开窗口来探测。只有会话变化或已确认正常登录后关闭才允许再次启动。
      if (previous && previous.credentialFingerprint === session.credentialFingerprint && !['ready', 'spawn-failed'].includes(previous.state)) return { status: 'session-retry-blocked', loginState: 'unknown', nextAction: 'refresh-native-login-or-inspect-original-launch' };
      const work = join(root, '.codex-work');
      const environment = { ...process.env, TMPDIR: join(work, 'tmp/creator-launch'), TMP: join(work, 'tmp/creator-launch'), TEMP: join(work, 'tmp/creator-launch'),
        XDG_CACHE_HOME: join(work, 'cache'), XDG_CONFIG_HOME: join(work, 'cache/config'), XDG_DATA_HOME: join(work, 'cache/data'), XDG_STATE_HOME: join(work, 'cache/state'), NODE_COMPILE_CACHE: join(work, 'cache/node') };
      for (const path of [plan.home, plan.userData, environment.TMPDIR, environment.XDG_CONFIG_HOME, environment.XDG_DATA_HOME, environment.XDG_STATE_HOME, environment.NODE_COMPILE_CACHE]) await store.directory(path);
      let journal = { schemaVersion: 1, state: 'reserved', credentialFingerprint: session.credentialFingerprint, pid: null, attemptedAt: new Date().toISOString() };
      await store.write(journalPath, JSON.stringify(journal), journalBytes);
      const record = async (state, pid = journal.pid) => {
        const before = Buffer.from(JSON.stringify(journal)); journal = { ...journal, state, pid };
        await store.write(journalPath, JSON.stringify(journal), before);
      };
      let child;
      try {
        // 不将原生进程的账号/会话日志透传到 MCP；启动结果由认证桥接和脱敏状态确认。
        child = this.spawnEditor(plan.executable, plan.args, { cwd: root, env: environment, stdio: 'ignore', detached: true, shell: false });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      } catch { await record('spawn-failed'); return { status: 'editor-spawn-failed', loginState: 'unknown' }; }
      try { await record('starting', child.pid); } finally { child.unref(); }
      const deadline = Date.now() + this.timeoutMs;
      do {
        const editor = await this.account.existing(root, selection);
        if (editor) {
          await record(editor.loginState === 'logged-in' ? 'ready' : editor.loginState === 'logged-out' ? 'login-required' : 'unverified');
          return { ...editor, sessionSource: session.account, ...(session.backupPath ? { backupPath: session.backupPath } : {}) };
        }
        if (!this.alive(child.pid)) break;
        await delay(this.pollMs);
      } while (Date.now() < deadline);
      await record('unverified');
      return { status: 'editor-start-unverified', loginState: 'unknown', pid: child.pid, nextAction: 'inspect-existing-window; do-not-relaunch', ...(session.backupPath ? { backupPath: session.backupPath } : {}) };
    });
  }
}
