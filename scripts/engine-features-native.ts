import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { setTimeout } from 'node:timers/promises';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
import { MinimalSkinnedFixture } from './minimal-skinned-fixture.js';

class EngineFeatureSmoke {
  async run(project:string):Promise<void>{
    const registry=new ProjectRegistry(),{projectId}=await registry.add(project),gateway=new RuntimeGateway(registry),gatewayPort=await gateway.start(),app=new CocosApplication(registry,undefined,undefined,false,gateway);
    const rows:JsonObject[]=[],suffix=randomUUID().slice(0,8),report=join(process.cwd(),'.codex-work/logs',`engine-features-native-${suffix}.json`);
    const call=async(id:string,params:JsonObject={}):Promise<JsonObject>=>{
      const result=Json.object((await app.execute({projectId,capabilityId:id,params})).result);rows.push({id,result});return result;
    };
    let previous:string|undefined,created=false,previewOwned=false,failed:unknown;
    try{
      const initial=await call('scene.query');assert.equal(initial.dirty,false,'Do not replace an unsaved scene');previous=Json.string(Json.object(initial.scene).sceneId,'sceneId');
      const settings=Json.object((await call('project.settings.get',{name:'engine'})).settings);
      const modules=Json.object(settings.modules),configs=Json.object(modules.configs),config=Json.object(configs[String(modules.globalConfigKey)]),cache=Json.object(config.cache);
      const required=['procedural-animation','sorting-2d','custom-pipeline-post-process','geometry-renderer'];
      for(const feature of required)cache[feature]={...Json.object(cache[feature]),_value:true};
      config.includeModules=[...new Set([...(config.includeModules as string[]),...required])].sort();
      Json.object(modules.graphics)['custom-pipeline-post-process']=true;
      await call('project.settings.set',{name:'engine',key:'modules',value:modules});
      const path={points:[{x:0,y:0,z:0},{x:10,y:0,z:0}],samples:5,uniformSpeed:true};
      const samples=await call('path.sample',path);assert.equal(samples.supported,true);assert.equal((samples.rows as unknown[]).length,5);
      const grid={min:{x:-1,y:-1,z:-1},max:{x:1,y:1,z:1},counts:{x:2,y:2,z:2}};
      assert.equal((await call('probe.generate',{...grid,method:'adaptive'})).supported,false);
      const generated=await call('probe.generate',grid);assert.equal((generated.rows as unknown[]).length,8);
      const location=await call('asset.location',{url:`db://assets/EngineFeatureTest_${suffix}.scene`});
      await call('scene.create',{url:location.url!});created=true;
      const root=await call('node.create',{name:'EngineFeatureTest'}),nodeId=Json.string(root.nodeId,'nodeId');
      const animation=await call('asset.location',{url:`db://assets/EnginePath_${suffix}.anim`});
      const baked=await call('path.bake_clip',{...path,url:animation.url!,rootId:nodeId,name:'EnginePath',duration:2});assert.notEqual(baked.supported,false);
      const rig=await call('node.create',{name:'MinimalIK',parentId:nodeId});
      const boneRoot=await call('node.create',{name:'Root',parentId:rig.nodeId!});
      const middle=await call('node.create',{name:'Middle',parentId:boneRoot.nodeId!});
      const end=await call('node.create',{name:'End',parentId:middle.nodeId!});
      for(const bone of [middle,end])await call('node.set',{nodeId:bone.nodeId!,properties:{position:{x:0,y:1,z:0}}});
      const graphLocation=await call('asset.location',{url:`db://assets/MinimalIK_${suffix}.animgraph`});
      const ikParams={rootId:rig.nodeId!,endEffectorPath:'Root/Middle/End',target:{x:1,y:1,z:0},pole:{x:0,y:0,z:1},name:'MinimalIK',url:graphLocation.url!,enabledParameter:'ikEnabled'};
      const ikPlan=await call('ik.plan',ikParams);assert.equal(ikPlan.supported,true);
      const ikGraph=await call('ik.apply',{...ikParams,planHash:ikPlan.planHash!});assert.equal(ikGraph.supported,true);
      assert.equal(Json.object(ikGraph.asset).invalid,false);
      const controller=await call('component.add',{nodeId:rig.nodeId!,type:'cc.animation.AnimationController'});
      const controllerId=(controller.componentIds as string[])[0]!;
      await call('component.set',{componentId:controllerId,properties:{graph:{uuid:Json.object(ikGraph.asset).uuid!}}});
      const maskLocation=await call('asset.location',{url:`db://assets/MinimalIK_${suffix}.animask`});
      const mask=await call('ik.mask_create',{rootId:rig.nodeId!,name:'MinimalIKMask',url:maskLocation.url!,joints:[{path:'Root',enabled:true},{path:'Root/Middle',enabled:true},{path:'Root/Middle/End',enabled:true}]});assert.equal(mask.supported,true);
      const modelLocation=await call('asset.location',{url:`db://assets/MinimalSkin_${suffix}.gltf`});
      const model=await call('asset.create',{url:modelLocation.url!,content:new MinimalSkinnedFixture().document()});
      const subAssets=Object.values(Json.object(Json.object(model.asset).subAssets)).map(Json.object);
      const prefab=subAssets.find(asset=>asset.type==='cc.Prefab');assert.ok(prefab,'Native importer must create a prefab');
      const skinRoot=await call('node.create',{name:'MinimalSkin',parentId:nodeId,assetUuid:prefab.uuid!});
      const skinTree=await call('scene.hierarchy',{rootId:skinRoot.nodeId!,includeComponents:true});
      const sources=(skinTree.rows as JsonObject[]).flatMap(node=>node.components as JsonObject[]).filter(component=>component.type==='cc.SkinnedMeshRenderer');assert.equal(sources.length,2);
      const effectLocation=await call('asset.location',{url:`db://assets/MinimalBatch_${suffix}.effect`});
      const effectSource=await readFile('/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/Resources/resources/3d/engine/editor/assets/effects/util/batched-unlit.effect','utf8');
      await call('shader.create',{url:effectLocation.url!,content:effectSource});
      const materialLocation=await call('asset.location',{url:`db://assets/MinimalBatch_${suffix}.mtl`});
      const batchMaterial=await call('material.create',{url:materialLocation.url!,effectUrl:effectLocation.url!});
      const sourceEffectLocation=await call('asset.location',{url:`db://assets/MinimalSkin_${suffix}.effect`});
      await call('shader.create',{url:sourceEffectLocation.url!,content:await readFile('/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/Resources/resources/3d/engine/editor/assets/effects/builtin-unlit.effect','utf8')});
      const sourceMaterialLocation=await call('asset.location',{url:`db://assets/MinimalSkin_${suffix}.mtl`});
      const sourceMaterial=await call('material.create',{url:sourceMaterialLocation.url!,effectUrl:sourceEffectLocation.url!});
      const materialRef={uuid:Json.object(sourceMaterial.asset).uuid!};
      for(const source of sources)await call('component.set',{componentId:source.componentId!,properties:{sharedMaterials:[materialRef]}});
      const batchNode=await call('node.create',{name:'BatchResult',parentId:skinRoot.nodeId!});
      // 当前 3.8.8 预览的批处理 setter 已观测到递归栈溢出；保留完整配置供复现，默认不激活。
      await call('node.set',{nodeId:batchNode.nodeId!,properties:{active:false}});
      const batchAdded=await call('component.add',{nodeId:batchNode.nodeId!,type:'cc.SkinnedMeshBatchRenderer'}),batchId=(batchAdded.componentIds as string[])[0]!;
      await call('component.set',{componentId:batchId,properties:{skinningRoot:{uuid:skinRoot.nodeId!},sharedMaterials:[{uuid:Json.object(batchMaterial.asset).uuid!}],units:sources.map(source=>({mesh:Json.object(source.properties).mesh!,skeleton:Json.object(source.properties).skeleton!,material:materialRef}))}});
      const skeletal=(skinTree.rows as JsonObject[]).flatMap(node=>node.components as JsonObject[]).find(component=>component.type==='cc.SkeletalAnimation');assert.ok(skeletal);
      await call('component.set',{componentId:skeletal.componentId!,properties:{playOnLoad:true}});
      const cameraNode=await call('node.create',{name:'FixtureCamera',parentId:nodeId});
      await call('node.set',{nodeId:cameraNode.nodeId!,properties:{position:{x:.5,y:1,z:6}}});
      await call('component.add',{nodeId:cameraNode.nodeId!,type:'cc.Camera'});
      const types=(await call('component.types')).rows as JsonObject[],persisted:Array<{family:string;componentId:string;properties:JsonObject}>=[];
      for(const [family,name,properties] of [['sorting','cc.Sorting2D',{sortingOrder:7}],['probe','cc.LightProbeGroup',{probes:generated.rows}],['postprocess','cc.Bloom',{intensity:1.25}]] as const){
        const type=types.find(row=>row.name===name||row.cid===name);
        if(!type){rows.push({check:family,status:'unsupported',reason:`Native component registry lacks ${name}`});continue;}
        const node=await call('node.create',{name:`Test-${family}`}),added=await call('component.add',{nodeId:node.nodeId!,type:type.cid??name});
        let componentId:string|undefined;
        for(const candidate of added.componentIds as string[]){const queried=await call('component.query',{componentId:candidate});if(Json.object(queried.component).type===name)componentId=candidate;}
        assert.ok(componentId,`Created component must contain ${name}`);
        const params={componentId,properties:Json.object(properties)},plan=await call(`${family}.plan`,params);
        if(plan.supported===false)continue;
        const applied=await call(`${family}.apply`,{...params,planHash:plan.planHash!});assert.equal(applied.supported,true);persisted.push({family,componentId,properties:params.properties});
      }
      await call('scene.save');const current=Json.string(Json.object((await call('scene.query')).scene).sceneId,'sceneId');
      await call('scene.open',{uuid:previous});await call('scene.open',{uuid:current});
      const info=await call('node.query',{nodeId});assert.ok(info.node);
      for(const entry of persisted){const state=await call(`${entry.family}.inspect`,{componentId:entry.componentId});for(const [key,value] of Object.entries(entry.properties))assert.deepEqual(Json.object(state.properties)[key],value);rows.push({check:`${entry.family}-save-reopen-properties`,passed:true});}
      rows.push({check:'save-reopen-preserves-node',passed:true});
      assert.equal((await call('preview.status')).running,false,'Do not replace an existing preview');
      await call('preview.start',{width:640,height:480,visible:false});previewOwned=true;
      for(let attempt=0;attempt<10;attempt++){
        try{await call('shader.preview.connect',{gatewayPort});break;}catch(error){if(attempt===9)throw error;await setTimeout(500);}
      }
      const debug=await call('runtime.debug.inspect');assert.equal(debug.supported,true);
      // 原生运行时链路需独立验证，不能以编辑器 scene 进程成功替代。
      const runtime=await call('runtime.query');assert.equal(runtime.engineVersion,'3.8.8');
      const trace=await call('runtime.animation_graph.trace',{componentId:controllerId,frames:5});assert.equal(trace.supported,true);
      const position:JsonObject={};for(const axis of ['x','y','z'])position[axis]=(await call('runtime.get',{target:`node:${end.nodeId}`,path:`worldPosition.${axis}`})).value!;
      const distance=Math.hypot(Number(position.x)-1,Number(position.y)-1,Number(position.z));
      assert.ok(distance<0.02,`IK end effector error ${distance}`);rows.push({check:'native-ik-target',distance,passed:true});
      await call('runtime.animation_graph.set_parameter',{componentId:controllerId,name:'ikEnabled',value:false});
      assert.equal((await call('runtime.animation_graph.assert',{componentId:controllerId,stateId:'Rest',frames:10})).matched,true);
      for(const [axis,expected] of [['x',0],['y',2],['z',0]] as const)assert.ok(Math.abs(Number((await call('runtime.get',{target:`node:${end.nodeId}`,path:`worldPosition.${axis}`})).value)-expected)<0.02);
      await call('runtime.animation_graph.set_parameter',{componentId:controllerId,name:'ikEnabled',value:true});
      assert.equal((await call('runtime.animation_graph.assert',{componentId:controllerId,stateId:'IK',frames:10})).matched,true);
      rows.push({check:'native-animation-graph-parameter-transition-and-rest-pose',passed:true});
      const batch=await call('runtime.skinning.inspect',{componentId:batchId});assert.equal(batch.supported,true);
      assert.equal((Json.object(batch.properties).units as unknown[]).length,2);
      rows.push({check:'native-batch-fixture',supported:false,code:'UNSUPPORTED_CAPABILITY',reason:'3.8.8 native batch setter recursion observed; configured fixture remains inactive',reproductionReport:'engine-features-native-faec2a92.json'});
      const capture=await call('preview.capture');const imagePath=join(process.cwd(),'.codex-work/build',`engine-fixture-${suffix}.png`);
      await writeFile(imagePath,Buffer.from(String(capture.dataUrl).split(',')[1]!,'base64'));delete capture.dataUrl;rows.push({check:'fixture-capture',imagePath});
      await call('runtime.graphics.inspect');
    }catch(error){failed=error;rows.push({error:error instanceof Error?error.message:String(error)});}
    finally{
      if(previewOwned){try{await call('preview.logs');await call('preview.stop');}catch(error){failed??=error;rows.push({previewStopError:String(error)});}}
      if(created&&previous){try{await call('scene.save');await call('scene.open',{uuid:previous});}catch(error){failed??=error;rows.push({restoreError:String(error)});}}
      await gateway.close();
      const installed = JSON.parse(await readFile(join(project,'extensions/cocos-mcp-creator3/package.json'),'utf8')) as {buildId?:string};
      await writeFile(report,JSON.stringify({installedBuildId:installed.buildId??null,engineVersion:'3.8.8',rows,passed:!failed,limitations:['Batch fixture inactive due native recursion; no batching optimization or character-route acceptance','Only the dedicated test project engine modules were enabled']},null,2));console.log(report);
    }
    if(failed)throw failed;
  }
}
await new EngineFeatureSmoke().run(process.argv[2]!);
