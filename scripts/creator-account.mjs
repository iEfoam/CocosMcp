import { homedir } from 'node:os';
import { readFile, mkdir, stat, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

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
  async prepare(project, major) {
    const root = await realpath(project), home = join(root, '.codex-work/cache/creator-home');
    const relative = major === 3 ? 'profiles/v2/editor/user.json' : 'profiles/user_token.json';
    const target = join(home, relative);
    let checked = target;
    while (true) { try { const actual = await realpath(checked); if (actual !== root && !actual.startsWith(root + '/')) throw new Error('Creator account path escapes project'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; checked = join(checked, '..'); } }
    const existing = await this.profile(target, major);
    if (existing) return { home, account: 'existing-project-session' };
    const source = await this.profile(join(this.localHome, relative), major);
    if (!source) return { home, account: 'unavailable', nextAction: major === 2 ? 'reuse-logged-in-dashboard' : 'native-session-unavailable' };
    // 不覆盖现有登录状态，也不改写跨版本凭据格式。账号目录始终处于本工程。
    const directory = join(target, '..'); let ancestor = directory;
    while (true) { try { const actual = await realpath(ancestor); if (actual !== root && !actual.startsWith(root + '/')) throw new Error('Creator account path escapes project'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = join(ancestor, '..'); } }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await writeFile(target, source, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; return { home, account: 'unavailable', nextAction: 'inspect-preserved-project-profile' }; }
    return { home, account: 'reused-local-native-profile' };
  }
  async local(major) {
    const relative = major === 3 ? 'profiles/v2/editor/user.json' : 'profiles/user_token.json';
    return { account: await this.profile(join(this.localHome, relative), major) ? 'existing-local-native-session' : 'unavailable' };
  }
  async existing(project) {
    const root = await realpath(project), directory = join(root, '.codex-work/cache/cocos-mcp/instances');
    const { readdir } = await import('node:fs/promises');
    let names;
    try {
      const actual = await realpath(directory);
      if (!actual.startsWith(root + '/')) throw new Error('Creator instance directory escapes project');
      names = await readdir(directory);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (names.length > 2000) throw new Error('Creator instance directory exceeds lookup limit');
    let unverified = null;
    for (const name of names.filter(name => /^[a-f0-9]{24}\.json$/.test(name))) {
      let descriptor;
      try {
        const path = await realpath(join(directory, name));
        if (!path.startsWith(root + '/')) continue;
        const info = await stat(path); if (!info.isFile() || info.size > 1024 * 1024) continue;
        descriptor = JSON.parse(await readFile(path, 'utf8'));
      } catch { continue; }
      if (descriptor.projectPath !== root || descriptor.instanceId + '.json' !== name || ![2, 3].includes(descriptor.creatorMajor) || !Number.isInteger(descriptor.pid) || descriptor.pid <= 0) continue;
      try { process.kill(descriptor.pid, 0); } catch { continue; }
      const metadata = { instanceId: descriptor.instanceId, creatorMajor: descriptor.creatorMajor };
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/rpc$/.test(descriptor.endpoint) || typeof descriptor.token !== 'string' || descriptor.token.length < 32) continue;
      try {
        const response = await fetch(descriptor.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1500),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${descriptor.token}` },
          body: JSON.stringify({ protocolVersion: 1, projectId: descriptor.projectId, instanceId: descriptor.instanceId, operationId: 'launcher-identity', capabilityId: 'bridge.identity', params: {} }) });
        const chunks = []; let size = 0;
        for await (const chunk of response.body ?? []) {
          size += chunk.length; if (size > 1024 * 1024) throw new Error('Creator identity response exceeds limit'); chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (response.ok && body.result?.instanceId === descriptor.instanceId && body.result?.projectPath === root && body.result?.pid === descriptor.pid) return { ...metadata, status: 'existing-editor-reused' };
      } catch { /* 老扩展或启动期间无法核验时仍保留在用实例，避免重复打开登录窗口。 */ }
      // 历史 PID 可能被其他进程复用；先扫描全部认证身份，不能让失联描述符挡住现有登录实例。
      unverified ??= { ...metadata, status: 'existing-editor-present-unverified' };
    }
    return unverified;
  }
}
