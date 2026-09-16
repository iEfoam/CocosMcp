import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import files from '../packages/native-adapters/src/extension-files.json' with { type: 'json' };

const output = '.codex-work/build/releases';
await mkdir(output, { recursive: true });
for (const major of [2, 3]) {
  const root = `.codex-work/build/extensions/creator${major}`;
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const rows = [];
  for (const path of [...files[major], ...files.presentation]) {
    rows.push({ path, content: (await readFile(join(root, path))).toString('base64') });
  }
  const bundle = { major, version: manifest.version, buildId: manifest.buildId, rows };
  await writeFile(join(output, `cocos-mcp-creator${major}.full.json`), JSON.stringify(bundle));
  // 已发布的旧更新器要求精确的文件数；保留旧资产，避免用户升级时被新增资料阻断。
  await writeFile(join(output, `cocos-mcp-creator${major}.json`), JSON.stringify({
    ...bundle, rows: rows.filter(row => files[major].includes(row.path)),
  }));
}
