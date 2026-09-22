import { stat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AsarArchive } from '../../catalog-generator/src/asar.js';
import { CocosError } from '../../contracts/src/index.js';

export interface CreatorInstallation { root: string; executable: string; resources: string; archive: string; engine: string; version: string; major: 2 | 3 }

export class CreatorLocator {
  async inspect(input: string): Promise<CreatorInstallation> {
    let root = resolve(input);
    if (!root.endsWith('.app') && process.platform === 'darwin') {
      const app = join(root, 'CocosCreator.app');
      if (await stat(app).then(value => value.isDirectory(), () => false)) root = app;
    }
    const resources = process.platform === 'darwin' ? join(root, 'Contents', 'Resources') : join(root, 'resources');
    const archive = join(resources, 'app.asar');
    let manifest: { version: string };
    if (await stat(archive).then(value => value.isFile(), () => false)) manifest = JSON.parse(await (await AsarArchive.open(archive)).read('package.json')) as { version: string };
    else manifest = JSON.parse(await readFile(join(resources, 'app', 'package.json'), 'utf8')) as { version: string };
    const major = Number(manifest.version.split('.')[0]);
    if (major !== 2 && major !== 3) throw new CocosError('UNSUPPORTED_VERSION', `Unsupported Creator: ${manifest.version}`);
    const executable = process.platform === 'darwin' ? join(root, 'Contents', 'MacOS', 'CocosCreator') : join(root, process.platform === 'win32' ? 'CocosCreator.exe' : 'CocosCreator');
    await stat(executable);
    return { root, resources, archive, executable, engine: join(resources, major === 3 ? 'resources/3d/engine' : 'engine'), version: manifest.version, major };
  }
}
