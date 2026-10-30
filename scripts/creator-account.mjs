import { homedir } from 'node:os';
import { readFile, stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CreatorSessionStore } from './creator-session-store.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const inspectProcess = promisify(execFile);

/** 凭据只在本机读入内存并按原生格式保存，调用者只取得来源状态。 */
export class CreatorAccount {
  constructor(localHome = join(homedir(), '.CocosCreator')) { this.localHome = localHome; }
  async profile(path, major) {
    try {
      if ((await stat(path)).size > 1024 * 1024) throw new Error('Creator account profile exceeds limit');
      const bytes = await readFile(path), data = JSON.parse(bytes.toString());
      const object = data && typeof data === 'object' && !Array.isArray(data);
      const present = object && (major === 3 ? ['session_id', 'session_key'].every(key => typeof data[key] === 'string' && data[key].length > 0) && (typeof data.cocos_uid === 'string' && data.cocos_uid.length > 0 || Number.isInteger(data.cocos_uid) && data.cocos_uid > 0) : Object.keys(data).length > 0);
      return present ? bytes : null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Creator account profile cannot be read safely'); }
  }
  fingerprint(bytes, major = 3) {
    const data = JSON.parse(bytes.toString());
    return createHash('sha256').update(JSON.stringify(major === 3 ? [String(data.cocos_uid), data.session_id, data.session_key] : data)).digest('hex');
  }
  async prepare(project, major) {
    const root = await realpath(project), home = join(root, '.codex-work/cache/creator-home');
    const relative = major === 3 ? 'profiles/v2/editor/user.json' : 'profiles/user_token.json';
    const target = join(home, relative), sourcePath = join(this.localHome, relative), store = new CreatorSessionStore(root);
    return store.locked('profile', async () => {
      const before = await store.read(target);
      const existing = await this.profile(target, major);
      const result = (account, bytes, extra = {}) => ({ home, account, validation: 'not-checked', ...(bytes ? { credentialFingerprint: this.fingerprint(bytes, major) } : {}), ...extra });
      // 非空无效文件可能是原生登出结果，不能靠复制另一个账号将其自动重新登录。
      if (before && !existing) return result('unavailable', null, { nextAction: 'inspect-preserved-project-profile' });
      const source = await this.profile(sourcePath, major);
      if (!source) return existing ? result('existing-project-session', existing) : result('unavailable', null, { nextAction: major === 2 ? 'reuse-logged-in-dashboard' : 'native-session-unavailable' });
      if (existing) {
        if (major !== 3 || this.fingerprint(existing) === this.fingerprint(source)) return result('existing-project-session', existing);
        // 仅刷新同一账号的较新本机会话；不同账号或工程更晚登录时保留工程选择，不能静默换号。
        if (String(JSON.parse(existing).cocos_uid) !== String(JSON.parse(source).cocos_uid)) return result('existing-project-session', existing, { refreshDeferred: 'different-account' });
        if ((await stat(sourcePath)).mtimeMs <= (await stat(target)).mtimeMs) return result('existing-project-session', existing);
        if (await this.existing(root)) return result('existing-project-session', existing, { refreshDeferred: 'editor-open' });
        // 内容再核对后才备份及替换；mtime 只表示新旧，不作为官方登录有效性的证明。
        if (!(await this.profile(sourcePath, major))?.equals(source)) throw new Error('Native Creator session changed while preparing; retry later');
        const backupPath = await store.backup(before);
        await store.write(target, source, before);
        return result('refreshed-local-native-profile', source, { backupPath });
      }
      await store.write(target, source, null);
      return result('reused-local-native-profile', source);
    });
  }
  async local(major) {
    const relative = major === 3 ? 'profiles/v2/editor/user.json' : 'profiles/user_token.json';
    return { account: await this.profile(join(this.localHome, relative), major) ? 'existing-local-native-session' : 'unavailable' };
  }
  async processState(pid) {
    if (!['darwin', 'linux'].includes(process.platform)) return 'unknown';
    try {
      // 只读取可执行程序名，不读取参数、环境或凭据；历史 PID 存活不能证明它仍属于 Creator。
      const { stdout } = await inspectProcess('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 1500, maxBuffer: 64 * 1024, encoding: 'utf8' });
      const name = stdout.trim().split(/[\\/]/).pop();
      return /^CocosCreator(?:\.exe)?$/i.test(name ?? '') ? 'creator' : 'other';
    } catch (error) { return error.code === 1 ? 'other' : 'unknown'; }
  }
  async existing(project, options = {}) {
    const root = await realpath(project), directory = join(root, '.codex-work/cache/cocos-mcp/instances');
    const { readdir } = await import('node:fs/promises');
    let names;
    try {
      const actual = await realpath(directory);
      if (!actual.startsWith(root + '/')) throw new Error('Creator instance directory escapes project');
      names = await readdir(directory);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (names.length > 2000) throw new Error('Creator instance directory exceeds lookup limit');
    const verified = [], unverified = [];
    for (const name of names.filter(name => /^[a-f0-9]{24}\.json$/.test(name))) {
      let descriptor;
      try {
        const path = await realpath(join(directory, name));
        if (!path.startsWith(root + '/')) continue;
        const info = await stat(path); if (!info.isFile() || info.size > 1024 * 1024) continue;
        descriptor = JSON.parse(await readFile(path, 'utf8'));
      } catch { continue; }
      if (descriptor.projectPath !== root || descriptor.instanceId + '.json' !== name || ![2, 3].includes(descriptor.creatorMajor) || !Number.isInteger(descriptor.pid) || descriptor.pid <= 0) continue;
      try { process.kill(descriptor.pid, 0); } catch (error) { if (error.code === 'ESRCH') continue; }
      const metadata = { instanceId: descriptor.instanceId, creatorMajor: descriptor.creatorMajor, pid: descriptor.pid };
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/rpc$/.test(descriptor.endpoint) || typeof descriptor.token !== 'string' || descriptor.token.length < 32) {
        if (await this.processState(descriptor.pid) !== 'other') unverified.push({ ...metadata, loginState: 'unknown', status: 'existing-editor-present-unverified' });
        continue;
      }
      try {
        const response = await fetch(descriptor.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1500),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${descriptor.token}` },
          body: JSON.stringify({ protocolVersion: 1, projectId: descriptor.projectId, instanceId: descriptor.instanceId, operationId: 'launcher-identity', capabilityId: 'bridge.identity', params: {} }) });
        const chunks = []; let size = 0;
        for await (const chunk of response.body ?? []) {
          size += chunk.length; if (size > 1024 * 1024) throw new Error('Creator identity response exceeds limit'); chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (response.ok && body.result?.instanceId === descriptor.instanceId && body.result?.projectPath === root && body.result?.pid === descriptor.pid
          && (body.result.creatorMajor === undefined || body.result.creatorMajor === descriptor.creatorMajor)) {
          const loginState = ['logged-in', 'logged-out'].includes(body.result.loginState) ? body.result.loginState : 'unknown';
          verified.push({ ...metadata, loginState, status: loginState === 'logged-out' ? 'existing-editor-login-required' : 'existing-editor-reused' }); continue;
        }
      } catch { /* 老扩展或启动期间无法核验时仍保留在用实例，避免重复打开登录窗口。 */ }
      // 扫描全部认证身份后仅保留仍可能属于 Creator 的失联记录；明确复用到其他程序的 PID 不阻止启动。
      // 原生进程查询不可用时仍保守阻止重复打开，不能把查询失败当成编辑器已退出。
      if (await this.processState(descriptor.pid) !== 'other') unverified.push({ ...metadata, loginState: 'unknown', status: 'existing-editor-present-unverified' });
    }
    const matches = [...verified, ...unverified].filter(row => (!options.major || row.creatorMajor === options.major) && (!options.instanceId || row.instanceId === options.instanceId));
    const loggedIn = matches.filter(row => row.loginState === 'logged-in'), candidates = loggedIn.length ? loggedIn : matches;
    if (candidates.length > 1) return { status: 'existing-editor-ambiguous', loginState: 'unknown', rows: candidates };
    if (candidates.length === 1) return candidates[0];
    if (verified.length || unverified.length) return { status: 'existing-editor-mismatch', loginState: 'unknown', rows: [...verified, ...unverified] };
    if (options.instanceId) throw new Error('Requested Creator instance is not available; another window was not started');
    return null;
  }
}
