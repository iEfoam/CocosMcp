import { GithubUpdate } from '../../../packages/native-adapters/src/github-update.js';
const [command, project, version] = process.argv.slice(2);
const major = Number(version);
if (!project || (major !== 2 && major !== 3)) throw new Error('Invalid extension update arguments');
try {
  const updater = new GithubUpdate();
  console.log(JSON.stringify(command === 'check' ? await updater.latest(major) : command === 'install' ? await updater.install(project, major) : (() => {throw new Error('Unknown update command');})()));
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
