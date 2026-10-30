import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceStorage } from './workspace-storage.mjs';

const storage = new WorkspaceStorage(process.cwd()), report = await storage.inventory();
const output = await storage.workDirectory('artifacts/storage-inventory/' + report.createdAtUTC.replace(/[:.]/g, '-'));
await writeFile(join(output, 'REPORT.json'), JSON.stringify(report, null, 2));
const lines = ['# 工作区存储与所有权清单', '', `UTC：${report.createdAtUTC}`, '', '只读盘点，未执行删除。大小不代表可释放物理空间；不完整记录为下限。PID 存在不证明原任务仍在运行。', '', '| 路径 | 逻辑 MiB | 完整 | 任务 / 状态 | PID / 观察 | 用途 / 创建 UTC | 保留原因 |', '| --- | ---: | --- | --- | --- | --- | --- |'];
const cell = value => String(value ?? '未知').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
for (const row of report.rows) lines.push(`| ${cell(row.path)} | ${row.logicalBytes === undefined ? '未知' : (row.logicalBytes / 1048576).toFixed(2)} | ${row.complete ? '是' : '否'} | ${cell(row.owner?.taskId)} / ${cell(row.owner?.state)} | ${cell(row.owner?.pid)} / ${cell(row.owner?.processState)} | ${cell(row.owner?.purpose)} / ${cell(row.owner?.createdAtUTC)} | ${cell(row.retentionReason)} |`);
await writeFile(join(output, 'REPORT.md'), lines.join('\n') + '\n');
console.log(JSON.stringify({ report: join(output, 'REPORT.md'), rows: report.rows.length, visited: report.visited, incomplete: report.rows.filter(row => !row.complete).length }));
