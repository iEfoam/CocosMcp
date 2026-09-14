import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const output='.codex-work/build/releases'; await mkdir(output,{recursive:true});
for(const major of [2,3]) {
 const root=`.codex-work/build/extensions/creator${major}`;
 const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 const ext=major===2?'js':'cjs'; const rows=[];
 for(const path of ['package.json','LICENSE',`dist/main.${ext}`,`dist/scene.${ext}`,`dist/panel.${ext}`,'dist/service.mjs','dist/update.mjs']) rows.push({path,content:(await readFile(join(root,path))).toString('base64')});
 await writeFile(join(output,`cocos-mcp-creator${major}.json`),JSON.stringify({major,version:manifest.version,buildId:manifest.buildId,rows}));
}
