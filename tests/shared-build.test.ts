import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BuildJobs } from '../packages/native-adapters/src/build.js';
import { CreatorAccount } from '../scripts/creator-account.mjs';
import { OperationAudit } from '../packages/application/src/operation-audit.js';
import { ProjectPaths } from '../packages/application/src/paths.js';
import { Json } from '../packages/contracts/src/index.js';
import { TestWorkspace } from './workspace.js';

class AccountGate extends CreatorAccount {
  started = false; release: () => void = () => {};
  private readonly gate = new Promise<void>(resolve => { this.release = resolve; });
  override async prepare(project: string, _major: number) { this.started = true; await this.gate; return { home: project, account: 'fixture' }; }
}
class BuildFixture {
  root = ''; creator = ''; readonly account = new AccountGate();
  async setup() {
    this.root = await new TestWorkspace().create('shared-build-'); this.creator = join(this.root, 'Creator.app');
    await mkdir(join(this.creator, 'Contents/Resources/app'), { recursive: true }); await mkdir(join(this.creator, 'Contents/MacOS'), { recursive: true });
    await writeFile(join(this.creator, 'Contents/Resources/app/package.json'), JSON.stringify({ version: '3.8.8' }));
    const executable = join(this.creator, 'Contents/MacOS/CocosCreator');
    await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs'; import path from 'node:path';\nconst config=JSON.parse(fs.readFileSync(process.argv.at(-1).slice(11)));\nfs.appendFileSync(path.join(process.cwd(), 'spawn-count'), '1');\nsetTimeout(()=>{ fs.writeFileSync(path.join(config.buildPath, 'index.html'), 'fixture'); process.exit(36); }, 300);\n`); await chmod(executable, 0o700);
  }
  async prepared() { for (let i=0; i<100 && !this.account.started; i++) await delay(5); assert.equal(this.account.started, true); }
  async completed(jobs: BuildJobs, id: string) { for (let i=0; i<100; i++) { const job=Json.object(await jobs.status('project', this.root, id)); if (job.state!=='running') return job; await delay(20); } throw new Error('Build did not finish'); }
}

test('shared builds reserve preparation immediately, reuse stable operationId and survive a service restart without a duplicate process', { skip: process.platform !== 'darwin' }, async () => {
  const f=new BuildFixture(); await f.setup(); const jobs=new BuildJobs(f.account);
  try {
    const first=jobs.start('project', f.root, f.creator, 'web-mobile', {}, 'build-one'); await f.prepared();
    const duplicate=jobs.start('project', f.root, f.creator, 'web-mobile', {}, 'build-one');
    await assert.rejects(jobs.start('project', f.root, f.creator, 'web-mobile', {}, 'build-two'), { code: 'RESOURCE_BUSY' });
    await assert.rejects(jobs.start('project', f.root, f.creator, 'web-mobile', { debug: true }, 'build-one'), { code: 'OPERATION_CONFLICT' });
    f.account.release(); const a=Json.object(await first), b=Json.object(await duplicate); assert.equal(a.jobId, b.jobId);
    assert.equal((await f.completed(jobs, String(a.jobId))).state, 'succeeded'); await jobs.close();
    const restarted=new BuildJobs(f.account);
    try { assert.equal(Json.object(await restarted.start('project', f.root, f.creator, 'web-mobile', {}, 'build-one')).jobId, a.jobId); assert.equal(await readFile(join(f.root,'spawn-count'),'utf8'), '1'); }
    finally { await restarted.close(); }
    assert.ok((await jobs.operation('project', f.root, 'build-one')));
  } finally { f.account.release(); await jobs.close(); }
});
test('closing a runner during account preparation prevents later spawn and rejects new starts', { skip: process.platform !== 'darwin' }, async () => {
  const f=new BuildFixture(); await f.setup(); const jobs=new BuildJobs(f.account), pending=jobs.start('project', f.root, f.creator, 'web-mobile', {}, 'close-preparing');
  const rejected=assert.rejects(pending, { code: 'CANCELLED' }); await f.prepared(); const closing=jobs.close(); f.account.release(); await rejected; await closing;
  await assert.rejects(readFile(join(f.root,'spawn-count')), { code: 'ENOENT' }); await assert.rejects(jobs.start('project', f.root, f.creator, 'web-mobile'), { code: 'RESOURCE_BUSY' });
});
test('persisted unknown builds retain live PID protection and missing PID requires explicit recovery', async () => {
  const root=await new TestWorkspace().create('build-recovery-'), paths=await ProjectPaths.open(root), logs=await paths.work('logs','builds'), cache=await paths.work('cache','cocos-mcp');
  const live=randomUUID(), unknown=randomUUID();
  await writeFile(join(cache,'build-jobs.json'),JSON.stringify([live,unknown].map(jobId=>({ jobId,projectId:'project',projectPath:root,state:'running',platform:'web-mobile',creatorVersion:'3.8.8',logPath:join(logs,`${jobId}.log`),outputPath:join(root,'.codex-work/build/creator',jobId),spawnAttempted:true,...(jobId===live?{childPid:process.pid}:{}) }))));
  const jobs=new BuildJobs(); assert.equal(Json.object(await jobs.status('project',root,unknown)).recoveryRequired,true);
  await assert.rejects(jobs.recover('project',root,live),{code:'RESOURCE_BUSY'}); assert.equal(Json.object(await jobs.recover('project',root,unknown)).recoveryRequired,false);
  await assert.rejects(jobs.start('project',root,'/missing/Creator.app','web-mobile',{},'new-build'),{code:'RESOURCE_BUSY'});
});
test('build operation identifiers cannot replace an already journaled editor write', { skip: process.platform !== 'darwin' }, async () => {
  const f=new BuildFixture(); await f.setup(); f.account.release(); const paths=await ProjectPaths.open(f.root); await new OperationAudit().reserve(paths,'same-id','another-request',{capabilityId:'scene.save'});
  const jobs=new BuildJobs(f.account);
  try { await assert.rejects(jobs.start('project',f.root,f.creator,'web-mobile',{},'same-id'),{code:'OPERATION_CONFLICT'}); await assert.rejects(readFile(join(f.root,'spawn-count')),{code:'ENOENT'}); }
  finally { await jobs.close(); }
});
