#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { CocosApplication, ProjectRegistry, ProjectPaths } from '../../../packages/application/src/index.js';
import { RuntimeGateway } from '../../../packages/application/src/runtime-gateway.js';
import { CatalogGenerator } from '../../../packages/catalog-generator/src/index.js';
import { CreatorLocator } from '../../../packages/native-adapters/src/creator.js';
import { ExtensionInstaller } from '../../../packages/native-adapters/src/installer.js';
import { BuildJobs } from '../../../packages/native-adapters/src/build.js';
import { CocosError, Json } from '../../../packages/contracts/src/index.js';
import { CocosMcpServer } from './mcp.js';
import { McpTransport } from './transport.js';

class CommandLine {
  async run(): Promise<void> {
    const parsed = parseArgs({ allowPositionals: true, options: {
      project: { type: 'string', multiple: true }, creator: { type: 'string' }, engine: { type: 'string' },
      major: { type: 'string' }, transport: { type: 'string', default: 'stdio' }, port: { type: 'string', default: '0' },
      'token-file': { type: 'string' }, 'allow-project-code': { type: 'boolean', default: false },
      'all-tools': { type: 'boolean', default: false }, 'no-runtime': { type: 'boolean', default: false },
      capability: { type: 'string' }, params: { type: 'string' }, instance: { type: 'string' },
      'operation-id': { type: 'string' }, revision: { type: 'string' }, help: { type: 'boolean' },
    } });
    const { values, positionals } = parsed; const command = positionals[0] ?? 'serve';
    if (values.help) { this.help(); return; }
    const roots = values.project ?? [process.cwd()]; const projects = new ProjectRegistry();
    for (const root of roots) await projects.add(root);
    const first = projects.list().rows[0]!;
    if (command === 'install') {
      const major = values.creator ? (await new CreatorLocator().inspect(values.creator)).major : Number(values.major);
      if (major !== 2 && major !== 3) throw new CocosError('INVALID_ARGUMENT', 'Specify --creator <installation> or --major 2|3');
      const buildRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      console.log(JSON.stringify(await new ExtensionInstaller().install(first.projectPath, major, buildRoot), null, 2)); return;
    }
    if (command === 'catalog') {
      const generator = new CatalogGenerator(); const paths = await ProjectPaths.open(first.projectPath);
      const output = await paths.work('cache', 'catalog'); const reports: unknown[] = [];
      if (values.creator) {
        const installation = await new CreatorLocator().inspect(values.creator);
        const report = await generator.editor(installation.archive); const path = join(output, `editor-${installation.version}.json`);
        await writeFile(path, JSON.stringify(report, null, 2)); reports.push({ path, candidates: report.rows.length, inspectedFiles: report.inspectedFiles, fingerprint: report.fingerprint });
      }
      if (values.engine) {
        const report = await generator.engine(values.engine); const path = join(output, 'engine.json'); const manifestPath = join(output, 'engine-capabilities.json');
        await writeFile(path, JSON.stringify(report, null, 2)); await writeFile(manifestPath, JSON.stringify(report.manifest, null, 2));
        reports.push({ path, manifestPath, candidates: report.rows.length, publicCandidates: report.manifest.publicRows, inspectedFiles: report.inspectedFiles, fingerprint: report.fingerprint, excludedDirectories: report.excludedDirectories });
      }
      if (!reports.length) throw new CocosError('INVALID_ARGUMENT', 'Specify --creator or --engine');
      console.log(JSON.stringify({ reports, verification: 'source-only' }, null, 2)); return;
    }
    if (command === 'doctor') {
      const application = new CocosApplication(projects);
      console.log(JSON.stringify({ node: process.version, platform: process.platform, architecture: process.arch, projects: projects.list(),
        instances: await application.instances(first.projectId), creator: values.creator ? await new CreatorLocator().inspect(values.creator) : null,
        registeredCapabilities: application.catalog.search().total, coverage: application.catalog.coverage() }, null, 2)); return;
    }
    if (command === 'call') {
      const application = new CocosApplication(projects, undefined, undefined, values['allow-project-code']);
      const capabilityId = values.capability;
      if (!capabilityId) throw new CocosError('INVALID_ARGUMENT', '--capability is required');
      const params = Json.object(JSON.parse(values.params ?? '{}'));
      console.log(JSON.stringify(await application.execute({ projectId: first.projectId, capabilityId, params,
        ...(values.instance ? { instanceId: values.instance } : {}), ...(values['operation-id'] ? { operationId: values['operation-id'] } : {}),
        ...(values.revision ? { expectedRevision: values.revision } : {}) }), null, 2)); return;
    }
    if (command !== 'serve') throw new CocosError('INVALID_ARGUMENT', `Unknown command: ${command}`);
    if (!['stdio', 'http'].includes(values.transport)) throw new CocosError('INVALID_ARGUMENT', 'transport must be stdio or http');
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CocosError('INVALID_ARGUMENT', 'Invalid port');
    const gateway = values['no-runtime'] ? undefined : new RuntimeGateway(projects);
    const builds = new BuildJobs();
    if (gateway) console.error(`[CocosMCP] Development runtime gateway: 127.0.0.1:${await gateway.start()}`);
    const application = new CocosApplication(projects, undefined, undefined, values['allow-project-code'], gateway);
    const factory = new CocosMcpServer(application, gateway, builds, values['all-tools']); const transport = new McpTransport();
    let closing = false;
    const close = async (): Promise<void> => { if (closing) return; closing = true; await transport.close(); await gateway?.close(); await builds.close(); };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().catch(error => { console.error(error); process.exitCode = 1; }); });
    if (values.transport === 'stdio') { transport.startStdio(factory); process.stdin.once('end', () => { void close(); }); }
    else {
      const paths = projects.paths(first.projectId); const directory = await paths.work('cache', 'cocos-mcp');
      const tokenPath = values['token-file'] ? await paths.resolve(values['token-file']) : join(directory, 'mcp-http-token');
      let token: string;
      try { token = (await readFile(tokenPath, 'utf8')).trim(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; token = randomBytes(32).toString('hex'); await writeFile(tokenPath, token, { mode: 0o600, flag: 'wx' }); }
      if (token.length < 32) throw new CocosError('INVALID_ARGUMENT', 'HTTP token must be at least 32 characters');
      console.error(`[CocosMCP] HTTP MCP: http://127.0.0.1:${await transport.startHttp(factory, port, token)}/mcp; token file: ${tokenPath}`);
    }
  }

  private help(): void {
    console.log(`CocosMCP — MIT, free, no account or usage quotas\n\nCommands:\n  serve   --project <path> [--transport stdio|http] [--port 0] [--allow-project-code]\n  install --project <path> --creator <Creator installation>\n  doctor  --project <path> [--creator <installation>]\n  catalog --project <path> [--creator <installation>] [--engine <source path>]\n  call    --project <path> --capability <id> [--params '{...}']\n\nBuild first with pnpm build. Artifacts and caches stay under .codex-work/.`);
  }
}

void new CommandLine().run().catch(error => { console.error(JSON.stringify({ error: CocosError.from(error).toJSON() })); process.exitCode = 1; });
