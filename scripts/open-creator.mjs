import { parseArgs } from 'node:util';
import { CreatorLauncher } from './creator-launcher.mjs';

const { values } = parseArgs({ options: {
  project: { type: 'string' }, creator: { type: 'string' }, major: { type: 'string' }, instance: { type: 'string' }, 'dry-run': { type: 'boolean' },
} });
if (!values.project || !values.creator) throw new Error('Usage: node scripts/open-creator.mjs --project <project> --creator <Creator executable> [--major 2|3] [--instance <instanceId>] [--dry-run]');
// 非标准安装路径必须显式指定版本，不能把所有非 2.4.15 路径都猜成 Creator 3。
const detectedMajor = values.creator.match(/(?:^|[\\/])([23])\.\d+\.\d+(?:[\\/]|$)/)?.[1];
if (values.major && detectedMajor && values.major !== detectedMajor) throw new Error('Creator major conflicts with the installation path');
const major = Number(values.major ?? detectedMajor);
if (![2, 3].includes(major)) throw new Error('Cannot identify Creator major from installation path; specify --major 2 or 3');
const launcher = new CreatorLauncher();
if (values['dry-run']) console.log(JSON.stringify(await launcher.plan(values.project, values.creator, major), null, 2));
else {
  const result = await launcher.launch(values.project, values.creator, major, { instanceId: values.instance });
  console.log(JSON.stringify(result));
  if (result.status !== 'existing-editor-reused') process.exitCode = 1;
}
