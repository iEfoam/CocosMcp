import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BuildJobs } from '../packages/native-adapters/src/build.js';
import { Json } from '../packages/contracts/src/index.js';

// 先关闭本任务的 GUI 实例，避免同一工程被两个 Creator 进程同时导入和构建。
const project = resolve('.codex-work/build/creator2-test-project');
const scene = JSON.parse(await readFile(resolve(project, 'assets/Scenes/Creator2Coverage.fire.meta'), 'utf8'));
const builds = new BuildJobs();
const job = Json.object(await builds.start('creator2-coverage', project, '/Applications/Cocos/Creator/2.4.15/CocosCreator.app', 'web-desktop', { debug: true, startScene: scene.uuid }));
console.log(JSON.stringify(job));
const deadline = Date.now() + 300000;
let status = job;
while (status.state === 'running' && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  status = Json.object(await builds.status('creator2-coverage', project, String(job.jobId)));
}
if (status.state === 'running') status = Json.object(await builds.cancel('creator2-coverage', project, String(job.jobId)));
await writeFile(resolve('.codex-work/logs/creator2-native/build-report.json'), JSON.stringify(status, null, 2));
console.log(JSON.stringify(status));
if (status.state !== 'succeeded') process.exitCode = 1;
