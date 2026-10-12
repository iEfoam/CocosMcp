import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientInstallation } from '../../../packages/native-adapters/src/client-installation.js';
import { ClientPackage } from '../../../packages/native-adapters/src/client-installation.js';
import { ProjectAuthorizations } from '../../../packages/native-adapters/src/project-authorization.js';
import { ProjectPaths } from '../../../packages/application/src/paths.js';
import { ProjectLocator } from '../../../packages/application/src/project-locator.js';

class InstallClient {
  async run(): Promise<void> {
    const { values } = parseArgs({ options: { workspace: { type: 'string' }, bundle: { type: 'string' }, 'allowed-root': { type: 'string', multiple: true }, rollback: { type: 'boolean' },
      installation: { type: 'string' }, 'authorize-project': { type: 'string' }, 'revoke-project': { type: 'string' } } });
    if (values['authorize-project'] || values['revoke-project']) {
      if (!values.installation || values['authorize-project'] && values['revoke-project'] || values.workspace || values.bundle || values.rollback || values['allowed-root']) throw new Error('Use --installation <client> with exactly one --authorize-project or --revoke-project');
      await new ClientPackage().installed(resolve(values.installation));
      const authorizations = new ProjectAuthorizations(resolve(values.installation));
      if (values['authorize-project']) {
        const project = await ProjectPaths.open(resolve(values['authorize-project'])), major = await new ProjectLocator([project.root]).major(project);
        if (!major) throw new Error('Authorization requires a Creator project root');
        console.log(JSON.stringify(await authorizations.grant(project.root, major), null, 2));
      } else console.log(JSON.stringify(await authorizations.revoke(resolve(values['revoke-project']!)), null, 2));
      return;
    }
    if (!values.workspace || values.installation) throw new Error('Usage: node install.mjs --workspace <directory> [--allowed-root <games-parent>] [--rollback]');
    const workspace = resolve(values.workspace), installer = new ClientInstallation();
    const result = values.rollback ? await installer.rollback(workspace) : await installer.install(workspace, resolve(values.bundle ?? dirname(fileURLToPath(import.meta.url))), (values['allowed-root'] ?? []).map(root => resolve(root)));
    console.log(JSON.stringify(result, null, 2));
  }
}
void new InstallClient().run().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
