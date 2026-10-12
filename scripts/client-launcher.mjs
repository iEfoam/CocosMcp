import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// 固定入口仅加载已安装的不可变版本；stdout 保持纯 MCP 协议。
class ClientLauncher {
  async file(root, name, limit) {
    const target = join(root, name), actual = await realpath(target), suffix = relative(root, actual), info = await lstat(target);
    if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith('..' + sep) || !info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Invalid installed client file: ' + name);
    return readFile(target);
  }
  async run() {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Unified Cocos MCP requires Node.js 24 or higher');
    const installation = await realpath(dirname(fileURLToPath(import.meta.url)));
    const current = JSON.parse(await this.file(installation, 'current.json', 65536));
    if (current.schemaVersion !== 1 || !/^[a-f\d]{16}$/.test(current.buildId) || current.versionPath !== 'versions/' + current.buildId || typeof current.workspaceRoot !== 'string' || !isAbsolute(current.workspaceRoot)) throw new Error('Invalid client version pointer');
    const workspace = await realpath(current.workspaceRoot);
    if (await realpath(join(workspace, '.codex-work/artifacts/cocos-client')) !== installation) throw new Error('Client workspace does not match installation');
    const version = join(installation, current.versionPath), manifest = JSON.parse(await this.file(installation, current.versionPath + '/manifest.json', 65536));
    const names = ['launcher.mjs', 'router.mjs', 'worker.mjs', 'install.mjs', 'LICENSE'];
    if (manifest.schemaVersion !== 1 || manifest.kind !== 'cocos-unified-client' || manifest.apiVersion !== 1 || manifest.buildId !== current.buildId || !manifest.fileHashes || Object.keys(manifest.fileHashes).sort().join('|') !== names.slice().sort().join('|')) throw new Error('Invalid installed client manifest');
    let size = 0;
    for (const name of names) {
      const bytes = await this.file(installation, current.versionPath + '/' + name, 40 * 1024 * 1024);
      size += bytes.byteLength;
      if (size > 40 * 1024 * 1024) throw new Error('Client package is too large');
      if (createHash('sha256').update(bytes).digest('hex') !== manifest.fileHashes[name]) throw new Error('Client checksum mismatch: ' + name);
    }
    const { RouterService } = await import(pathToFileURL(join(version, 'router.mjs')).href);
    await new RouterService().run(installation, workspace, join(version, 'worker.mjs'));
  }
}
void new ClientLauncher().run().catch(error => { console.error('[CocosMCP client]', error.message); process.exitCode = 1; });
