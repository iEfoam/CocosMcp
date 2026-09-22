import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';

class FollowupAcceptance {
  async run(project:string,sceneUrl:string):Promise<void>{
    // 此验收脚本仅在独立样例中调用下方列出的原生公开方法；不修改常驻服务的调用权限配置。
    const registry=new ProjectRegistry(),{projectId}=await registry.add(project),gateway=new RuntimeGateway(registry),gatewayPort=await gateway.start(),app=new CocosApplication(registry,undefined,undefined,true,gateway);
    const rows:JsonObject[]=[];let previous:string|undefined,graphId:string|undefined,previewOwned=false,failed:unknown;
    const call=async(id:string,params:JsonObject={}):Promise<JsonObject>=>{
      const result=Json.object((await app.execute({projectId,capabilityId:id,params})).result);rows.push({id,result});return result;
    };
    const capture=async(name:string):Promise<void>=>{
      if(graphId)await call('runtime.animation_graph.trace',{componentId:graphId,frames:3});
      const result=await call('preview.capture'),path=join(process.cwd(),'.codex-work/build',`engine-followup-${name}.png`);
      await writeFile(path,Buffer.from(String(result.dataUrl).split(',')[1]!,'base64'));delete result.dataUrl;rows.push({capture:name,path});
    };
    try{
      const initial=await call('scene.query');assert.equal(initial.dirty,false);previous=Json.string(Json.object(initial.scene).sceneId,'sceneId');
      const resolved=await call('asset.resolve',{reference:sceneUrl});
      await call('scene.open',{uuid:resolved.uuid!});
      const hierarchy=await call('scene.hierarchy',{includeComponents:true,limit:100});
      const components=(hierarchy.rows as JsonObject[]).flatMap(node=>node.components as JsonObject[]);
      const camera=components.find(c=>c.type==='cc.Camera'),batch=components.find(c=>c.type==='cc.SkinnedMeshBatchRenderer'),animation=components.find(c=>c.type==='cc.SkeletalAnimation');assert.ok(camera&&batch&&animation);
      assert.equal((await call('preview.status')).running,false);
      await call('preview.start',{width:800,height:600,visible:true});previewOwned=true;
      for(let attempt=0;attempt<6;attempt++)try{await call('shader.preview.connect',{gatewayPort});break;}catch(error){if(attempt===5)throw error;await setTimeout(500);}
      const plan=await call('runtime.skinning.plan',{componentId:batch.componentId!});assert.equal(plan.code,'UNSUPPORTED_CAPABILITY');assert.match(String(plan.reason),/递归编译缺陷/);
      const graph=components.find(c=>c.type==='cc.animation.AnimationController');assert.ok(graph);
      graphId=String(graph.componentId);await call('runtime.animation_graph.trace',{componentId:graphId,frames:10});
      await call('runtime.invoke',{target:`component:${animation.componentId}`,method:'pause'});
      const nativeCamera=Json.object((await call('runtime.get',{target:`component:${camera.componentId}`,path:'camera'})).value);
      await call('runtime.invoke',{target:nativeCamera.handle!,method:'initGeometryRenderer'});
      await capture('baseline');
      const drawn=await call('runtime.debug.shape',{cameraComponentId:camera.componentId!,ownerId:'native-shapes',ttlMs:30000,depthTest:false,color:[0,255,0,255],shape:{kind:'box',min:{x:-.6,y:-.2,z:.1},max:{x:1.6,y:2.2,z:.3}}});assert.equal(drawn.supported,true);
      await capture('box');
      const inspected=await call('runtime.debug.inspect');assert.deepEqual(inspected.errors,[]);assert.equal((inspected.rows as unknown[]).length,1);
      await call('runtime.debug.clear',{ownerId:'native-shapes'});await capture('cleared');
      const cleared=await call('runtime.debug.inspect');assert.equal((cleared.rows as unknown[]).length,0);
      rows.push({check:'debug-ownership-and-native-frame',passed:true,visualComparison:'separate screenshot review required'});
      const probes=components.find(c=>c.type==='cc.LightProbeGroup');assert.ok(probes);
      const previewed=await call('runtime.probe.preview',{componentId:probes.componentId!,cameraComponentId:camera.componentId!,ownerId:'native-probes',ttlMs:30000,radius:.08,depthTest:false});
      assert.equal(previewed.supported,true);assert.equal((previewed.rows as unknown[]).length,8);
      await capture('probes');
      await call('runtime.debug.clear',{ownerId:'native-probes'});await capture('probes-cleared');
      rows.push({check:'native-probe-world-preview',passed:true,visualComparison:'separate screenshot review required'});
      const bloom=components.find(c=>c.type==='cc.Bloom'),post=components.find(c=>c.type==='cc.PostProcess');assert.ok(bloom&&post);
      assert.equal((await call('runtime.postprocess.inspect',{componentId:bloom.componentId!,cameraComponentId:camera.componentId!})).supported,false);
      await call('runtime.get',{target:'cc',path:'director.root.usesCustomPipeline'});
      await call('runtime.get',{target:nativeCamera.handle!,path:'pipeline'});
      const writes=[{target:`component:${camera.componentId}`,path:'usePostProcess',value:true},{target:`component:${camera.componentId}`,path:'postProcess',value:{$component:post.componentId!}},
        {target:`component:${bloom.componentId}`,path:'threshold',value:0},{target:`component:${bloom.componentId}`,path:'intensity',value:3}];
      const previousValues:JsonObject[]=[];
      try{
        for(const write of writes){const current=(await call('runtime.get',{target:write.target,path:write.path})).value!;
          previousValues.push({target:write.target,path:write.path,value:current&&typeof current==='object'&&!Array.isArray(current)&&current.handle?{$handle:current.handle}:current});
          await call('runtime.set',write);
        }
        await call('runtime.get',{target:nativeCamera.handle!,path:'usePostProcess'});
        await call('runtime.get',{target:`component:${bloom.componentId}`,path:'enabledInHierarchy'});
        await call('runtime.postprocess.inspect',{componentId:bloom.componentId!,cameraComponentId:camera.componentId!});
        await capture('bloom');
      }finally{for(const previousValue of previousValues.reverse())await call('runtime.set',previousValue);}
      await capture('bloom-restored');rows.push({check:'postprocess-runtime-restore',passed:true,visualComparison:'separate screenshot review required'});
      const sortingRoot=Json.object((await call('runtime.create',{type:'cc.Node',args:['SortingPixelAcceptance']})).object);
      try{
        await call('runtime.set',{target:sortingRoot.handle!,path:'active',value:false});
        await call('runtime.set',{target:sortingRoot.handle!,path:'layer',value:33554432});
        await call('runtime.set',{target:sortingRoot.handle!,path:'parent',value:{$node:(hierarchy.rows as JsonObject[])[0]!.nodeId!}});
        const canvas=Json.object((await call('runtime.invoke',{target:sortingRoot.handle!,method:'addComponent',args:['cc.Canvas']})).value);
        await call('runtime.set',{target:canvas.handle!,path:'alignCanvasWithScreen',value:false});
        const cameraNode=Json.object((await call('runtime.create',{type:'cc.Node',args:['SortingCamera']})).object);
        await call('runtime.set',{target:cameraNode.handle!,path:'parent',value:{$handle:sortingRoot.handle!}});
        await call('runtime.invoke',{target:cameraNode.handle!,method:'setPosition',args:[0,0,1000]});
        const sortingCamera=Json.object((await call('runtime.invoke',{target:cameraNode.handle!,method:'addComponent',args:['cc.Camera']})).value);
        for(const [path,value] of Object.entries({projection:0,orthoHeight:300,visibility:33554432,priority:100,clearFlags:6,near:1,far:2000}))await call('runtime.set',{target:sortingCamera.handle!,path,value});
        await call('runtime.set',{target:canvas.handle!,path:'cameraComponent',value:{$handle:sortingCamera.handle!}});
        const sorts:JsonObject[]=[];
        for(const [index,color] of [[0,[255,40,40,255]],[1,[40,80,255,255]]] as const){
          const node=Json.object((await call('runtime.create',{type:'cc.Node',args:[`SortRectangle${index}`]})).object);
          await call('runtime.set',{target:node.handle!,path:'layer',value:33554432});
          await call('runtime.set',{target:node.handle!,path:'parent',value:{$handle:sortingRoot.handle!}});
          const graphics=Json.object((await call('runtime.invoke',{target:node.handle!,method:'addComponent',args:['cc.Graphics']})).value);
          await call('runtime.set',{target:graphics.handle!,path:'fillColor',value:{$type:'cc.Color',args:[...color]}});
          await call('runtime.invoke',{target:graphics.handle!,method:'rect',args:[-150+index*70,-100+index*40,230,180]});
          await call('runtime.invoke',{target:graphics.handle!,method:'fill'});
          const sort=Json.object((await call('runtime.invoke',{target:node.handle!,method:'addComponent',args:['cc.Sorting2D']})).value);sorts.push(sort);
          await call('runtime.set',{target:sort.handle!,path:'sortingOrder',value:index});
        }
        await call('runtime.set',{target:sortingRoot.handle!,path:'active',value:true});
        await capture('sorting-blue-front');
        await call('runtime.set',{target:sorts[0]!.handle!,path:'sortingOrder',value:2});
        await capture('sorting-red-front');
        rows.push({check:'native-sorting-order-screenshots',visualComparison:'separate screenshot review required'});
      }finally{await call('runtime.release',{target:sortingRoot.handle!,destroy:true});}
      const temporary=Json.object((await call('runtime.create',{type:'cc.Node',args:['InactiveCharacterCompatibilityTest']})).object);
      try{
        await call('runtime.set',{target:temporary.handle!,path:'active',value:false});
        await call('runtime.set',{target:temporary.handle!,path:'parent',value:{$node:(hierarchy.rows as JsonObject[])[0]!.nodeId!}});
        const cct=Json.object((await call('runtime.invoke',{target:temporary.handle!,method:'addComponent',args:['cc.CapsuleCharacterController']})).value);
        const componentId=(await call('runtime.get',{target:cct.handle!,path:'uuid'})).value!;
        const unavailable=await call('runtime.character.test_route',{componentId,movements:[{x:1,y:0,z:0}]});assert.equal(unavailable.code,'UNSUPPORTED_CAPABILITY');
        rows.push({check:'uninitialized-native-character-unsupported',passed:true,routePhysicsVerified:false});
        const obstacles:JsonObject[]=[];
        try{
          // 将物理样例隔离到可视样例之外，不与已有网格或控制器互相影响。
          for(const spec of [{name:'RouteFloor',position:[100,-.5,0],size:[20,1,20]},{name:'RouteWall',position:[102,1,0],size:[1,2,8]}]){
            const node=Json.object((await call('runtime.create',{type:'cc.Node',args:[spec.name]})).object);obstacles.push(node);
            await call('runtime.set',{target:node.handle!,path:'active',value:false});
            await call('runtime.invoke',{target:node.handle!,method:'setPosition',args:spec.position});
            await call('runtime.set',{target:node.handle!,path:'parent',value:{$node:(hierarchy.rows as JsonObject[])[0]!.nodeId!}});
            const collider=Json.object((await call('runtime.invoke',{target:node.handle!,method:'addComponent',args:['cc.BoxCollider']})).value);
            await call('runtime.set',{target:collider.handle!,path:'size',value:{$type:'cc.Vec3',args:spec.size}});
            await call('runtime.set',{target:node.handle!,path:'active',value:true});
          }
          await call('runtime.invoke',{target:temporary.handle!,method:'setPosition',args:[100,1.1,0]});
          await call('runtime.set',{target:temporary.handle!,path:'active',value:true});
          await call('runtime.animation_graph.trace',{componentId:graphId,frames:3});
          const initialized=await call('runtime.character.inspect',{componentId});
          if(initialized.supported===false){rows.push({check:'active-character-backend',supported:false,reason:initialized.reason!});}
          else{
            const route=await call('runtime.character.test_route',{componentId,movements:Array.from({length:30},()=>({x:.1,y:-.1,z:0})),expectedEnd:{x:103,y:1,z:0},tolerance:.1});
            assert.equal(route.supported,true);assert.equal(route.reached,false,'Wall must prevent reaching the requested endpoint');
            const samples=route.rows as JsonObject[],last=Json.object(samples.at(-1)!.position);
            assert.ok(Number(last.x)>100.5&&Number(last.x)<101.1,'Capsule must move then stop at wall');
            assert.equal(samples.at(-1)!.grounded,true);
            assert.ok((route.events as JsonObject[]).some(event=>event.type==='onControllerColliderHit'));
            rows.push({check:'native-character-ground-wall-and-collision-events',passed:true,finalPosition:last});
            const reset=async():Promise<void>=>{await call('runtime.set',{target:cct.handle!,path:'centerWorldPosition',value:{$type:'cc.Vec3',args:[100,1.1,0]}});await call('runtime.animation_graph.trace',{componentId:graphId!,frames:3});};
            const travel=async(count:number):Promise<JsonObject>=>await call('runtime.character.test_route',{componentId,movements:Array.from({length:count},()=>({x:.1,y:-.1,z:0}))});
            const finish=(result:JsonObject):JsonObject=>Json.object((result.rows as JsonObject[]).at(-1)!.position);
            const wall=obstacles[1]!;
            await call('runtime.invoke',{target:wall.handle!,method:'setScale',args:[1,.15,1]});
            await call('runtime.invoke',{target:wall.handle!,method:'setPosition',args:[102,.15,0]});
            await reset();const step=await travel(20),stepEnd=finish(step);
            assert.ok(Number(stepEnd.x)>101.9&&Number(stepEnd.y)>1.2&&Number(stepEnd.y)<1.4,'0.3m step must be traversable with stepOffset 0.5');
            rows.push({check:'native-character-step',passed:true,finalPosition:stepEnd});
            await call('runtime.invoke',{target:wall.handle!,method:'setScale',args:[4,.1,.5]});
            await call('runtime.invoke',{target:wall.handle!,method:'setRotationFromEuler',args:[0,0,20]});
            await call('runtime.invoke',{target:wall.handle!,method:'setPosition',args:[102,.8,0]});
            await reset();const slope=await travel(30),slopeEnd=finish(slope);
            assert.ok(Number(slopeEnd.x)>102.8&&Number(slopeEnd.y)>1.5,'20 degree slope must be traversable with slopeLimit 45');
            rows.push({check:'native-character-slope',passed:true,finalPosition:slopeEnd});
            await call('runtime.set',{target:wall.handle!,path:'active',value:false});
            const sides:JsonObject[]=[];
            for(const z of [-.8,.8]){
              const node=Json.object((await call('runtime.create',{type:'cc.Node',args:['CorridorSide']})).object);obstacles.push(node);sides.push(node);
              await call('runtime.set',{target:node.handle!,path:'active',value:false});
              await call('runtime.set',{target:node.handle!,path:'parent',value:{$node:(hierarchy.rows as JsonObject[])[0]!.nodeId!}});
              await call('runtime.invoke',{target:node.handle!,method:'setPosition',args:[103,1,z]});
              const box=Json.object((await call('runtime.invoke',{target:node.handle!,method:'addComponent',args:['cc.BoxCollider']})).value);
              await call('runtime.set',{target:box.handle!,path:'size',value:{$type:'cc.Vec3',args:[4,2,.4]}});
              await call('runtime.set',{target:node.handle!,path:'active',value:true});
            }
            await reset();const wide=await travel(30),wideEnd=finish(wide);
            assert.ok(Math.abs(Number(wideEnd.x)-103)<.05,'1.2m corridor must admit the 1m capsule');
            for(const [index,side] of sides.entries())await call('runtime.invoke',{target:side.handle!,method:'setPosition',args:[103,1,index===0?-.5:.5]});
            await reset();const narrow=await travel(30),narrowEnd=finish(narrow);
            assert.ok(Number(narrowEnd.x)<101,'0.6m corridor must reject the 1m capsule');
            rows.push({check:'native-character-corridor-width',passed:true,wideEnd,narrowEnd});

          }
        }finally{for(const obstacle of obstacles.reverse())await call('runtime.release',{target:obstacle.handle!,destroy:true});}
      }finally{await call('runtime.release',{target:temporary.handle!,destroy:true});}
    }catch(error){failed=error;rows.push({error:String(error)});}
    finally{
      if(previewOwned)try{await call('preview.logs');await call('preview.stop');}catch(error){failed??=error;}
      if(previous)try{await call('scene.open',{uuid:previous});}catch(error){failed??=error;}
      await gateway.close();
      await writeFile(join(process.cwd(),'.codex-work/logs/engine-feature-followup-native.json'),JSON.stringify({passed:!failed,rows},null,2));
    }
    if(failed)throw failed;
  }
}
await new FollowupAcceptance().run(process.argv[2]!,process.argv[3]!);
