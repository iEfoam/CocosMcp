import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientInstallation } from '../../../packages/native-adapters/src/client-installation.js';

class InstallClient {
  async run(): Promise<void> {
    const { values } = parseArgs({ options: { workspace: { type: 'string' }, bundle: { type: 'string' }, 'allowed-root': { type: 'string', multiple: true }, rollback: { type: 'boolean' } } });
    if (!values.workspace) throw new Error('Usage: node install.mjs --workspace <directory> --allowed-root <games-parent> [--rollback]');
    const workspace = resolve(values.workspace), installer = new ClientInstallation();
    const result = values.rollback ? await installer.rollback(workspace) : await installer.install(workspace, resolve(values.bundle ?? dirname(fileURLToPath(import.meta.url))), (values['allowed-root'] ?? []).map(root => resolve(root)));
    console.log(JSON.stringify(result, null, 2));
  }
}
void new InstallClient().run().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
