import { readFile, writeFile, mkdir, lstat, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import { ClientPolicies } from '../../application/src/client-policy.js';
import { AtomicJson } from '../../application/src/atomic-json.js';
import files from './client-files.json' with { type: 'json' };

export const clientFiles = files;
export interface ClientManifest {
  schemaVersion: 1; kind: 'cocos-unified-client'; apiVersion: 1; version: string; buildId: string; builtAt: string;
  sourceFingerprint: string; verificationReportSha256: string | null; fileHashes: Record<string, string>;
}
interface InstalledClient { schemaVersion: 1; buildId: string; versionPath: string; workspaceRoot: string }

/** 离线包、持久安装和配置复制共用严格白名单；安装包不能包含工程凭据或本机路径。 */
export class ClientPackage {
  async json(paths: ProjectPaths, name: string): Promise<JsonObject> {
    const path = await paths.resolve(name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new CocosError('VERIFICATION_FAILED', 'Invalid client metadata');
    return Json.object(Json.value(JSON.parse(await readFile(path, 'utf8'))));
  }
  async verify(root: string): Promise<ClientManifest> {
    const paths = await ProjectPaths.open(root), value = await this.json(paths, 'manifest.json');
    if (value.schemaVersion !== 1 || value.kind !== 'cocos-unified-client' || value.apiVersion !== 1 || typeof value.version !== 'string' ||
      typeof value.buildId !== 'string' || !/^[a-f\d]{16}$/.test(value.buildId) || typeof value.builtAt !== 'string' || !value.builtAt.endsWith('Z') || !Number.isFinite(Date.parse(value.builtAt)) ||
      typeof value.sourceFingerprint !== 'string' || !/^[a-f\d]{64}$/.test(value.sourceFingerprint) || (value.verificationReportSha256 !== null && (typeof value.verificationReportSha256 !== 'string' || !/^[a-f\d]{64}$/.test(value.verificationReportSha256)))) throw new CocosError('VERIFICATION_FAILED', 'Invalid unified client manifest');
    const hashes = Json.object(value.fileHashes!);
    if (Object.keys(hashes).sort().join('|') !== [...clientFiles].sort().join('|')) throw new CocosError('VERIFICATION_FAILED', 'Unexpected client package files');
    let size = 0;
    for (const name of clientFiles) {
      const path = await paths.resolve(name), info = await lstat(path);
      size += info.size;
      if (!info.isFile() || info.isSymbolicLink() || !info.size || size > 40 * 1024 * 1024) throw new CocosError('VERIFICATION_FAILED', 'Invalid or oversized client file');
      if (createHash('sha256').update(await readFile(path)).digest('hex') !== hashes[name]) throw new CocosError('VERIFICATION_FAILED', 'Client file checksum mismatch', { name });
    }
    return value as unknown as ClientManifest;
  }
  async installed(root: string, verify = true): Promise<{ current: InstalledClient; manifest: ClientManifest }> {
    const paths = await ProjectPaths.open(root), row = await this.json(paths, 'current.json');
    if (row.schemaVersion !== 1 || typeof row.buildId !== 'string' || !/^[a-f\d]{16}$/.test(row.buildId) || row.versionPath !== `versions/${row.buildId}` || typeof row.workspaceRoot !== 'string' || !isAbsolute(row.workspaceRoot)) throw new CocosError('VERIFICATION_FAILED', 'Invalid client version pointer');
    const version = await paths.resolve(String(row.versionPath));
    const manifest = verify ? await this.verify(version) : await this.json(await ProjectPaths.open(version), 'manifest.json') as unknown as ClientManifest;
    if (manifest.buildId !== row.buildId) throw new CocosError('VERIFICATION_FAILED', 'Client version pointer does not match manifest');
    return { current: row as unknown as InstalledClient, manifest };
  }
  async configuration(root: string, nodeExecutable: string): Promise<string> {
    if (!isAbsolute(nodeExecutable)) throw new CocosError('INVALID_ARGUMENT', 'Node executable must be absolute');
    const { current, manifest } = await this.installed(root), installation = await ProjectPaths.open(root), workspace = await ProjectPaths.open(current.workspaceRoot);
    if (await workspace.resolve('.codex-work/artifacts/cocos-client') !== installation.root) throw new CocosError('VERIFICATION_FAILED', 'Client workspace does not match installation');
    const launcher = await installation.resolve('launcher.mjs'), info = await lstat(launcher);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 || createHash('sha256').update(await readFile(launcher)).digest('hex') !== manifest.fileHashes['launcher.mjs']) throw new CocosError('VERIFICATION_FAILED', 'Client launcher checksum mismatch');
    await new ClientPolicies().load(installation);
    const temporary = await workspace.work('tmp', 'cocos-client'), cache = await workspace.work('cache', 'cocos-client');
    const q = (value: string): string => JSON.stringify(value);
    // Codex 会合并多层同名配置；独立名称避免旧 cocos HTTP 的 url 与 stdio 参数混合。
    const server = 'cocos_unified';
    return `[mcp_servers.${server}]\ncommand = ${q(nodeExecutable)}\nargs = [${q(await installation.resolve('launcher.mjs'))}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 120\n\n[mcp_servers.${server}.env]\nTMPDIR = ${q(temporary)}\nTMP = ${q(temporary)}\nTEMP = ${q(temporary)}\nXDG_CACHE_HOME = ${q(cache)}\nNODE_COMPILE_CACHE = ${q(join(cache, 'node'))}\nTZ = "UTC"\n`;
  }
}

export class ClientInstallation {
  private readonly packages = new ClientPackage();
  async install(workspaceRoot: string, bundleRoot: string, allowedRoots: string[]): Promise<JsonValue> {
    const workspace = await ProjectPaths.open(workspaceRoot), bundle = await ProjectPaths.open(bundleRoot), manifest = await this.packages.verify(bundle.root);
    const root = await workspace.work('artifacts', 'cocos-client'), installation = await ProjectPaths.open(root);
    const release = await this.lock(installation);
    let staging: string | undefined;
    let successful = false;
    try {
      staging = await workspace.work('tmp', `cocos-client-install-${randomUUID()}`);
      await mkdir(await installation.resolve('versions'), { recursive: true });
      const target = await installation.resolve(`versions/${manifest.buildId}`);
      let exists = false;
      try { const info = await lstat(target); if (!info.isDirectory() || info.isSymbolicLink()) throw new CocosError('VERIFICATION_FAILED', 'Invalid installed client version directory'); exists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (exists) await this.packages.verify(target);
      else {
        for (const name of [...clientFiles, 'manifest.json']) await writeFile(join(staging, name), await readFile(await bundle.resolve(name)), { flag: 'wx', mode: 0o600 });
        await this.packages.verify(staging); await rename(staging, target);
      }
      const policy = await installation.resolve('policy.json');
      try { await new ClientPolicies().load(installation); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const roots = await Promise.all(allowedRoots.map(root => ProjectPaths.open(root)));
        const value = new ClientPolicies().parse({ schemaVersion: 1, allowedRoots: roots.map(root => root.root), autoStartBackend: true, allowProjectCode: false,
          clientHeartbeatSeconds: 10, clientLeaseTtlSeconds: 60, idleExitSeconds: 90 });
        await new AtomicJson().write(policy, Json.value(value), true);
      }
      const current: InstalledClient = { schemaVersion: 1, buildId: manifest.buildId, versionPath: `versions/${manifest.buildId}`, workspaceRoot: workspace.root };
      let previous: JsonObject | undefined;
      try { previous = await this.packages.json(installation, 'current.json'); await this.packages.installed(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (previous && previous.buildId !== manifest.buildId) await new AtomicJson().write(await installation.resolve('previous.json'), previous);
      await this.launcher(installation, target);
      await new AtomicJson().write(await installation.resolve('current.json'), Json.value(current));
      successful = true;
      return { installedPath: root, version: manifest.version, buildId: manifest.buildId, sourceFingerprint: manifest.sourceFingerprint, configuration: await this.packages.configuration(root, process.execPath) };
    } finally {
      await release();
      if (successful && staging) await rm(staging, { recursive: true, force: true });
      // 失败候选留在本任务 tmp，不能用失败安装清理其他版本或唯一回退点。
    }
  }
  private async launcher(installation: ProjectPaths, versionRoot: string): Promise<void> {
    const target = await installation.resolve('launcher.mjs');
    try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw new CocosError('VERIFICATION_FAILED', 'Client launcher must be a regular file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = await installation.resolve(`launcher-${randomUUID()}.tmp`);
    try { await writeFile(temporary, await readFile(join(versionRoot, 'launcher.mjs')), { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
    finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  private async lock(installation: ProjectPaths): Promise<() => Promise<void>> {
    const path = await installation.resolve('.install-lock');
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CocosError('RESOURCE_BUSY', 'Another client installation is in progress; inspect its lock before recovery'); throw error; }
    const owner = join(path, 'owner.json');
    try { await writeFile(owner, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { await rmdir(path); throw error; }
    return async () => { await unlink(owner); await rmdir(path); };
  }
  async rollback(workspaceRoot: string): Promise<JsonValue> {
    const workspace = await ProjectPaths.open(workspaceRoot), root = await workspace.resolve('.codex-work/artifacts/cocos-client'), installation = await ProjectPaths.open(root), release = await this.lock(installation);
    try {
      const previous = await this.packages.json(installation, 'previous.json'), current = await this.packages.json(installation, 'current.json');
      if (previous.schemaVersion !== 1 || typeof previous.buildId !== 'string' || !/^[a-f\d]{16}$/.test(previous.buildId) || previous.versionPath !== `versions/${previous.buildId}` || previous.workspaceRoot !== workspace.root) throw new CocosError('VERIFICATION_FAILED', 'Invalid client rollback pointer');
      const version = await installation.resolve(String(previous.versionPath)); await this.packages.verify(version);
      await this.launcher(installation, version);
      await new AtomicJson().write(await installation.resolve('current.json'), previous); await new AtomicJson().write(await installation.resolve('previous.json'), current);
      return { installedPath: root, buildId: previous.buildId, configuration: await this.packages.configuration(root, process.execPath) };
    } finally { await release(); }
  }
}
