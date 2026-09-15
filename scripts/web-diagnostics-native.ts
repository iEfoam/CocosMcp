import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';

// 仅对明确授权的测试扩展临时附加固定错误样例，finally 原样恢复 runtime.js；不暴露通用执行入口。
const project = process.argv[2]; if (!project) throw new Error('Provide authorized test project');
const registry = new ProjectRegistry();const {projectId}=await registry.add(project), gateway=new RuntimeGateway(registry), port=await gateway.start();
const app=new CocosApplication(registry,undefined,undefined,false,gateway);
const call=async(capabilityId:string,params:JsonObject={})=>Json.object((await app.execute({projectId,capabilityId,params})).result);
const fixture=createServer((_req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');res.writeHead(503);res.end('diagnostic fixture');});
await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve)); const httpPort=(fixture.address() as {port:number}).port;
const runtime=join(project,'extensions/cocos-mcp-creator3/dist/runtime.js'), original=await readFile(runtime);let owned=false,changed=false;
try {
 assert.equal((await call('scene.query')).dirty,false);assert.equal((await call('preview.status')).running,false);
 const source=`\nsetTimeout(()=>{throw new Error('MCP_NATIVE_SYNC_ERROR')},50);setTimeout(()=>{Promise.reject(new Error('MCP_NATIVE_PROMISE_ERROR'))},70);fetch('http://127.0.0.1:${httpPort}/fixture?token=discarded').catch(()=>{});fetch('http://127.0.0.1:1/failure').catch(()=>{});\n//# sourceURL=cocos-mcp-diagnostic-fixture.js\n`;
 await writeFile(runtime,Buffer.concat([original,Buffer.from(source)]));changed=true;
 await call('preview.start',{width:640,height:480,visible:false});owned=true;
 // 诊断必须覆盖场景启动前；注入已完成时，场景加载超时不妨碍检查浏览器异常。
 try { await call('shader.preview.connect',{gatewayPort:port}); } catch (error) { if (!String(error).includes('Target preview scene has not launched')) throw error; }
 await setTimeout(1500);
 const first=await call('preview.logs',{limit:1});const all=await call('preview.logs',{sessionId:first.sessionId!,limit:500});
 await writeFile(join(process.cwd(),'.codex-work/logs/web-diagnostics-native.json'),JSON.stringify(all,null,2));
 const rows=all.rows as JsonObject[];
 for(const kind of ['error','unhandledrejection','http-error','network-failure'])assert.ok(rows.some(row=>row.kind===kind),`Missing ${kind}`);
 assert.ok(rows.some(row=>String(row.stack).includes('MCP_NATIVE_SYNC_ERROR')));
 assert.ok(rows.some(row=>String(row.stack).includes('MCP_NATIVE_PROMISE_ERROR')));
 const second=await call('preview.logs',{sessionId:first.sessionId!,cursor:first.nextCursor!,limit:1});assert.ok(Number(second.nextCursor)>Number(first.nextCursor));
 console.log(JSON.stringify({status:'passed',sessionId:first.sessionId,rows:rows.length}));
}finally{if(changed)await writeFile(runtime,original);if(owned)await call('preview.stop');await gateway.close();fixture.close();}
