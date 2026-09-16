import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';
import { FeatureSupport } from '../packages/runtime3-bridge/src/feature-support.js';
import { PathSampler } from '../packages/runtime3-bridge/src/path.js';
import { FrameSession } from '../packages/runtime3-bridge/src/frame-session.js';
import { EngineFeatureInspector } from '../packages/runtime3-bridge/src/engine-inspector.js';
import { RuntimeController } from '../packages/runtime3-bridge/src/index.js';
import { CapabilityCatalog } from '../packages/capability-catalog/src/index.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import { EngineFeatureService } from '../packages/creator3-adapter/src/engine-features.js';
import type { EditorPort } from '../packages/creator3-adapter/src/port.js';
import { AnimationGraphObserver } from '../packages/runtime3-bridge/src/animation-graph.js';
import { DebugOverlayController } from '../packages/runtime3-bridge/src/debug-overlay.js';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { CatalogGenerator } from '../packages/catalog-generator/src/index.js';
import { IkAuthoring } from '../packages/runtime3-bridge/src/ik-authoring.js';
import { MinimalSkinnedFixture } from '../scripts/minimal-skinned-fixture.js';
import { PropertyDump } from '../packages/creator3-adapter/src/dump.js';
import { DebugShapes } from '../packages/runtime3-bridge/src/debug-shapes.js';
import { SkinningCompatibility } from '../packages/runtime3-bridge/src/skinning-compatibility.js';

class Vector { constructor(public x=0,public y=0,public z=0){} }
test('debug shapes normalize rays, emit unique box edges and bound probe previews',()=>{
  const shapes=new DebugShapes(),origin={x:0,y:0,z:0};
  assert.deepEqual(shapes.lines({shape:{kind:'ray',origin,direction:{x:2,y:0,z:0},length:3}}),[{start:origin,end:{x:3,y:0,z:0}}]);
  const box=shapes.lines({shape:{kind:'box',min:origin,max:{x:1,y:2,z:3}}});assert.equal(box.length,12);assert.equal(new Set(box.map(row=>JSON.stringify(row))).size,12);
  assert.equal(shapes.lines({shape:{kind:'points',points:[origin],radius:1}}).length,3);
  assert.throws(()=>shapes.lines({shape:{kind:'ray',origin,direction:origin,length:1}}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>shapes.lines({shape:{kind:'points',points:Array.from({length:257},()=>origin)}}),{code:'INVALID_ARGUMENT'});
});
test('batch compatibility detects recursive compiled setters without executing them',()=>{
  let invoked=0;
  class BrokenBatch {set mesh(value:unknown){invoked++;this.mesh=value;}set skeleton(value:unknown){invoked++;this.skeleton=value;}}
  const inspector=new SceneInspector({major:3,cc:{js:{getClassByName:()=>BrokenBatch}}});
  assert.throws(()=>new SkinningCompatibility(inspector).plan({componentId:'not-looked-up'}),{code:'UNSUPPORTED_CAPABILITY'});assert.equal(invoked,0);
});
test('postprocess diagnostics require camera activation, matching settings and an actual pass',()=>{
  class Bloom {uuid='bloom';enabledInHierarchy=true;intensity=1;}
  const bloom=new Bloom();
  class TestCamera {uuid='camera';camera={usePostProcess:false,postProcess:{getSetting:()=>bloom}};}
  const camera=new TestCamera(),passes=[{name:'BloomPass'}];
  const cc={Camera:TestCamera,director:{root:{usesCustomPipeline:true},getScene:()=>({children:[],getComponents:()=>[bloom,camera]})},js:{getClassName:()=> 'cc.Bloom',getClassByName:(name:string)=>name==='cc.Bloom'?Bloom:undefined},macro:{CUSTOM_PIPELINE_NAME:'Forward'},rendering:{getCustomPipeline:()=>({getCameraPasses:()=>passes})}};
  const inspector=new EngineFeatureInspector(new SceneInspector({major:3,cc})),p={componentId:'bloom',cameraComponentId:'camera'};
  assert.throws(()=>inspector.postprocess(p),{code:'UNSUPPORTED_CAPABILITY'});camera.camera.usePostProcess=true;
  assert.equal(inspector.postprocess(p).pipelineVerified,true);passes.length=0;
  assert.throws(()=>inspector.postprocess(p),{code:'UNSUPPORTED_CAPABILITY'});
});
test('native array readback tolerates default fields but verifies order, count and requested references',()=>{
  const expected=[{mesh:{uuid:'a'}},{mesh:{uuid:'b'}}],actual=[{mesh:{uuid:'a'},offset:{x:0,y:0}},{mesh:{uuid:'b'},offset:{x:0,y:0}}];
  assert.equal(PropertyDump.matches(actual,expected),true);
  assert.equal(PropertyDump.matches([...actual].reverse(),expected),false);
  assert.equal(PropertyDump.matches(actual.slice(1),expected),false);
  assert.equal(PropertyDump.matches(actual,[{mesh:{uuid:'c'}},expected[1]!]),false);
});
test('IK masks normalize native JSON text and reject missing or duplicate bones',()=>{
  let destroyed=0;
  class Mask { name=''; joints:unknown[]=[]; destroy():void{destroyed++;} addJoint(path:string,enabled:boolean):void{this.joints.push({path,enabled});} }
  const bone={uuid:'bone',name:'Root',children:[]},root={uuid:'rig',children:[bone]};
  const inspector=new SceneInspector({major:3,cc:{director:{getScene:()=>root}},serialize:value=>JSON.stringify(value)});
  const tool=new IkAuthoring(inspector,{AnimationMask:Mask});
  const p={rootId:'rig',name:'Mask',joints:[{path:'Root',enabled:true}]};
  const result=Json.object(tool.mask(p));assert.equal(result.name,'Mask');assert.deepEqual(result.joints,p.joints);assert.equal(destroyed,1);
  assert.throws(()=>tool.mask({...p,joints:[...p.joints,...p.joints]}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>tool.mask({...p,joints:[{path:'Missing',enabled:true}]}),{code:'INVALID_ARGUMENT'});
});
test('IK native binding converts a validated path to a unique bone name',()=>{
  const end={uuid:'end',name:'End',position:new Vector(0,1,0),children:[],parent:{}},middle={uuid:'middle',name:'Middle',position:new Vector(0,1,0),children:[end],parent:{}},bone={uuid:'bone',name:'Root',position:new Vector(),children:[middle],parent:{}},root={uuid:'rig',name:'Rig',children:[bone]};
  end.parent=middle;middle.parent=bone;bone.parent=root;
  let serializedName='',solver:unknown;
  const transitions:Record<string,unknown>[]=[],variables:unknown[][]=[];
  class Condition {operator=0;operand={variable:''};}
  class Solver {endEffectorBoneName='';endEffectorTarget={};poleTarget={};}
  class Graph {
    name='';destroy():void{}
    addVariable(...args:unknown[]):void{variables.push(args);}
    addLayer():unknown{return {stateMachine:{entryState:{},addMotion:()=>({}),addProceduralPoseState:()=>({graph:{outputNode:{},addNode:(value:unknown)=>{solver=value;}}}),connect:(_from:unknown,_to:unknown,conditions?:unknown[])=>{const transition={conditions,duration:0.3,exitConditionEnabled:true};transitions.push(transition);return transition;}}};}
  }
  const inspector=new SceneInspector({major:3,cc:{director:{getScene:()=>root},Vec3:Vector,animation:{VariableType:{BOOLEAN:1}},js:{getClassByName:(name:string)=>name.endsWith('UnaryCondition')?Condition:Solver}},serialize:()=>{serializedName=(solver as Solver).endEffectorBoneName;return '[]';}});
  const tool=new IkAuthoring(inspector,{AnimationGraph:Graph,poseGraphOp:{connectOutputNode:()=>{},getInputKeys:()=>['pose'],getInputBinding:()=>({producer:solver})}});
  const p={rootId:'rig',endEffectorPath:'Root/Middle/End',name:'IK',target:{x:1,y:1,z:0}};
  assert.deepEqual(tool.serialize(p),[]);assert.equal(serializedName,'End');
  assert.deepEqual(tool.serialize({...p,enabledParameter:'ikEnabled'}),[]);
  assert.deepEqual(variables,[['ikEnabled',1,true]]);
  const switches=transitions.filter(row=>row.conditions);
  assert.deepEqual(JSON.parse(JSON.stringify(switches.map(row=>row.conditions))),[[{operator:1,operand:{variable:'ikEnabled'}}],[{operator:0,operand:{variable:'ikEnabled'}}]]);
  assert.ok(switches.every(row=>row.duration===0&&row.exitConditionEnabled===false));
  assert.throws(()=>tool.serialize({...p,enabledParameter:'bad name'}),{code:'INVALID_ARGUMENT'});
  root.children.push({...bone,uuid:'duplicate'});
  assert.throws(()=>tool.inspect(p),{code:'INVALID_ARGUMENT'});
});
test('minimal skin fixture has bounded self-contained buffers and shared skin/material with animation',()=>{
  const doc=JSON.parse(new MinimalSkinnedFixture().document());
  const bytes=Buffer.from(doc.buffers[0].uri.split(',')[1],'base64');assert.equal(bytes.length,doc.buffers[0].byteLength);
  for(const view of doc.bufferViews){assert.equal(view.byteOffset%4,0);assert.ok(view.byteOffset+view.byteLength<=bytes.length);}
  assert.equal(doc.nodes[4].skin,doc.nodes[5].skin);assert.equal(doc.meshes[0].primitives[0].material,doc.meshes[1].primitives[0].material);
  assert.equal(doc.skins[0].joints.length,3);assert.equal(doc.animations[0].channels[0].target.path,'rotation');
});
test('source mining does not expose public members of engineInternal classes as stable APIs',()=>{
  const rows=new CatalogGenerator().parse('cocos/render-scene/scene/lod-group.ts','/** @engineInternal */ export class LODGroup { public getVisibleLODLevel(): number { return 0; } }');
  assert.ok(rows.length>=2);assert.ok(rows.every(row=>row.internal===true&&row.public===false));
});
class Spline {
  constructor(private readonly knots:Vector[]){}
  static create(_mode:number,knots:Vector[]):Spline{return new Spline(knots);}
  getPoint(t:number):Vector {const a=this.knots[0]!,b=this.knots.at(-1)!;return new Vector(a.x+(b.x-a.x)*t*t,a.y+(b.y-a.y)*t*t,a.z+(b.z-a.z)*t*t);}
}
class Harness {
  scene={uuid:'scene',children:[],getComponents:()=>[]};
  director=Object.assign(new EventEmitter(),{getScene:()=>this.scene});
  cc={VERSION:'3.8.8',geometry:{Spline},Vec3:Vector,Director:{EVENT_AFTER_DRAW:'after',EVENT_BEFORE_DRAW:'before'},director:this.director,js:{getClassByName:()=>undefined}};
  inspector=new SceneInspector({cc:this.cc,major:3});
  path={points:[{x:0,y:0,z:0},{x:10,y:0,z:0}],samples:5};
}
test('probe preview transforms local points without mutation and bounds pagination',()=>{
  class TransformVector extends Vector {static transformMat4(out:Vector,v:Vector,m:{x:number;y:number;z:number}):Vector{out.x=v.x+m.x;out.y=v.y+m.y;out.z=v.z+m.z;return out;}}
  class Probe {uuid='probe';node={worldMatrix:{x:10,y:20,z:30}};probes=Array.from({length:300},(_,x)=>new Vector(x,0,0));}
  const h=new Harness(),probe=new Probe(),cc={...h.cc,Vec3:TransformVector,js:{getClassByName:()=>Probe}};
  cc.director.getScene=()=>({uuid:'s',children:[],getComponents:()=>[probe]}) as unknown as typeof h.scene;
  const tool=new EngineFeatureInspector(new SceneInspector({major:3,cc}));
  const page=tool.probePoints({componentId:'probe',offset:254,limit:2});
  assert.deepEqual(page.rows,[{x:264,y:20,z:30},{x:265,y:20,z:30}]);assert.equal(page.nextOffset,256);assert.equal(probe.probes[254]!.x,254);
  assert.equal(tool.probePoints({componentId:'probe',offset:299}).nextOffset,null);
  assert.throws(()=>tool.probePoints({componentId:'probe',offset:300}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>tool.probePoints({componentId:'probe',limit:257}),{code:'INVALID_ARGUMENT'});
  probe.probes=[];assert.throws(()=>tool.probePoints({componentId:'probe'}),{code:'UNSUPPORTED_CAPABILITY'});
});
class RouteCharacter extends EventEmitter {
  uuid='character';enabledInHierarchy=true;isValid=true;_cct={};_isInitialized=true;
  centerWorldPosition={x:0,y:0,z:0};velocity={x:0,y:0,z:0};isGrounded=true;
  contact={collider:{uuid:'wall'},worldPosition:{x:1,y:0,z:0},worldNormal:{x:-1,y:0,z:0},motionLength:1};
  getMask():number{return 1;}getGroup():number{return 1;}
  move(v:Vector):void{this.centerWorldPosition.x+=v.x;this.emit('onControllerColliderHit',this.contact);this.contact.worldPosition.x=99;}
}
test('character route snapshots pooled events, verifies destination and removes listeners on cancellation',async()=>{
  const h=new Harness(),component=new RouteCharacter(),cc={...h.cc,PhysicsSystem:{instance:{enable:true}},js:{getClassByName:()=>RouteCharacter}};
  const scene={uuid:'s',children:[],getComponents:()=>[component]};cc.director.getScene=()=>scene as unknown as typeof h.scene;
  const frames=new FrameSession(cc),tool=new EngineFeatureInspector(new SceneInspector({major:3,cc}),frames);
  const run=tool.route({componentId:'character',movements:[{x:1,y:0,z:0}],expectedEnd:{x:1,y:0,z:0}});
  cc.director.emit('after');await Promise.resolve();cc.director.emit('after');
  const result=Json.object(await run);assert.equal(result.reached,true);
  assert.equal(Json.object((result.events as JsonObject[])[0]!.position).x,1);assert.equal(component.eventNames().length,0);
  const cancelled=tool.route({componentId:'character',movements:[{x:1,y:0,z:0}]});cc.director.emit('after');await Promise.resolve();frames.dispose();
  await assert.rejects(cancelled,{code:'OUTCOME_UNKNOWN'});assert.equal(component.eventNames().length,0);
});
test('engine extensions return structured unsupported for missing modules and versions without swallowing genuine failures',async()=>{
  const h=new Harness(),runtime=new RuntimeController({cc:h.cc,major:3});
  for(const id of ['runtime.animation_graph.inspect','runtime.character.inspect','runtime.skinning.inspect','runtime.ik.inspect','runtime.probe.preview']){
    const result=Json.object(await runtime.execute(id,{componentId:'missing'}));assert.equal(result.supported,false);assert.equal(result.status,'unsupported');
  }
  h.cc.VERSION='2.4.15';assert.equal(Json.object(await runtime.execute('runtime.debug.inspect',{})).supported,false);
  await assert.rejects(FeatureSupport.run('path.sample','3.8.8',()=>{throw new CocosError('INVALID_ARGUMENT','bad');}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(FeatureSupport.run('path.sample','3.8.8',()=>{throw new Error('native failure');}),/native failure/);
  runtime.dispose();
});
test('application returns normal unsupported execution results for Creator 2 and disabled runtime gateway',async()=>{
  const registry={paths:()=>({}),instance:async()=>({creatorMajor:2})} as unknown as ProjectRegistry;
  const app=new CocosApplication(registry);
  const editor=await app.execute({projectId:'p',capabilityId:'path.sample',params:{points:[{x:0,y:0,z:0},{x:1,y:1,z:1}]}});
  assert.equal(Json.object(editor.result).status,'unsupported');
  const runtime=await app.execute({projectId:'p',capabilityId:'runtime.character.inspect',params:{componentId:'x'}});
  assert.equal(Json.object(runtime.result).status,'unsupported');
});
test('path distance resampling produces near-uniform travel and preserves endpoints',()=>{
  const h=new Harness(),sampler=new PathSampler(h.cc),result=sampler.sample({...h.path,uniformSpeed:true}),rows=result.rows as JsonObject[];
  assert.equal(result.approximateLength,10);
  rows.forEach((row,index)=>assert.ok(Math.abs(Number(Json.object(row.position).x)-index*2.5)<0.00002));
  const clip=sampler.clip({...h.path,name:'Move',duration:2});
  const keys=Json.object((clip.tracks as JsonObject[])[0]).keys as JsonObject[];
  assert.equal(keys[0]!.time,0);assert.equal(keys.at(-1)!.time,2);assert.deepEqual(keys.at(-1)!.value,{x:10,y:0,z:0});
  for(const p of [{...h.path,samples:1},{...h.path,mode:'bezier',points:[{x:0,y:0,z:0},{x:1,y:1,z:1}]},{...h.path,points:[{x:NaN,y:0,z:0},{x:1,y:1,z:1}]}]) assert.throws(()=>sampler.sample(p),{code:'INVALID_ARGUMENT'});
});
test('frame wait cancels on disconnect and refuses scene replacement without leaking listeners',async()=>{
  const h=new Harness(),frames=new FrameSession(h.cc),wait=frames.wait(frames.token());
  assert.equal(h.director.listenerCount('after'),1);frames.dispose();await assert.rejects(wait,{code:'STALE_HANDLE'});assert.equal(h.director.listenerCount('after'),0);
  const next=frames.wait(frames.token());h.scene={...h.scene,uuid:'other'};h.director.emit('after');await assert.rejects(next,{code:'STALE_HANDLE'});assert.equal(h.director.listenerCount('after'),0);
  const valid=frames.wait(frames.token());h.director.emit('after');await valid;assert.equal(h.director.listenerCount('after'),0);
});
test('probe grid bounds and budgets are validated and adaptive placeholder is unsupported',()=>{
  const h=new Harness(),tool=new EngineFeatureInspector(h.inspector),p={min:{x:0,y:0,z:0},max:{x:1,y:2,z:3},counts:{x:2,y:2,z:2}};
  const result=tool.generate(p);assert.equal((result.rows as unknown[]).length,8);assert.deepEqual((result.rows as JsonObject[]).at(-1),{x:1,y:2,z:3});
  assert.throws(()=>tool.generate({...p,method:'adaptive'}),{code:'UNSUPPORTED_CAPABILITY'});
  assert.throws(()=>tool.generate({...p,counts:{x:32,y:32,z:32}}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>tool.generate({...p,max:{x:0,y:2,z:3}}),{code:'INVALID_ARGUMENT'});
});
class MissingController {
  uuid='controller';move():void{}getMask():number{return 0;}getGroup():number{return 0;}
  get isGrounded():boolean{throw new Error('unsafe native getter must not run');}
}
test('missing physics backend is checked before native character getters can throw',async()=>{
  const h=new Harness(),component=new MissingController(),cc={...h.cc,PhysicsSystem:{instance:{enable:true}},js:{getClassByName:()=>MissingController}};
  cc.director.getScene=()=>({uuid:'s',children:[],getComponents:()=>[component]}) as unknown as typeof h.scene;
  const runtime=new RuntimeController({cc,major:3});
  const result=Json.object(await runtime.execute('runtime.character.inspect',{componentId:'controller'}));assert.equal(result.status,'unsupported');runtime.dispose();
});
class EditorHarness {
  value=1;extra=0;writes=0;modules=['sorting-2d'];
  port={version:'3.8.8',scene:async(method:string)=>method==='fingerprint'?{value:this.value,extra:this.extra}:{supported:true,properties:{sortingOrder:this.value}}} as EditorPort;
  service=new EngineFeatureService(this.port,async(id,p)=>{
    if(id==='project.settings.get')return {settings:{modules:{globalConfigKey:'default',configs:{default:{includeModules:this.modules}}}}};
    if(id==='component.query')return {component:{sortingOrder:{type:'Number',value:this.value}}};
    if(id==='component.set'){this.writes++;this.value=Number(Json.object(p.properties).sortingOrder);return {};}
    throw new Error(id);
  });
  p={componentId:'sort',properties:{sortingOrder:3}};
}
test('editor feature plans are read-only, reject stale scene fingerprints and verify applied values',async()=>{
  const h=new EditorHarness(),plan=Json.object(await h.service.execute('sorting.plan',h.p));assert.equal(h.writes,0);
  h.extra++;await assert.rejects(h.service.execute('sorting.apply',{...h.p,planHash:plan.planHash!}),{code:'OPERATION_CONFLICT'});assert.equal(h.writes,0);
  const fresh=Json.object(await h.service.execute('sorting.plan',h.p));const result=Json.object(await h.service.execute('sorting.apply',{...h.p,planHash:fresh.planHash!}));assert.equal(result.supported,true);assert.equal(h.value,3);assert.equal(h.writes,1);
  h.port.version='3.8.7';assert.equal(Json.object(await h.service.execute('sorting.plan',h.p)).supported,false);assert.equal(h.writes,1);
});
test('disabled project modules return unsupported before editor writes even when editor classes exist',async()=>{
  const h=new EditorHarness();h.modules=[];
  const result=Json.object(await h.service.execute('sorting.apply',{...h.p,planHash:'old'}));
  assert.equal(result.code,'UNSUPPORTED_CAPABILITY');assert.equal(h.writes,0);
});
test('extension schemas reject unknown fields and bounded runtime writes',()=>{
  const catalog=new CapabilityCatalog(),h=new Harness();catalog.validate('path.sample',h.path);
  assert.throws(()=>catalog.validate('path.sample',{...h.path,eval:'code'}));
  assert.throws(()=>catalog.validate('runtime.debug.draw',{cameraComponentId:'c',ownerId:'o',lines:[],ttlMs:Infinity}));
  assert.throws(()=>catalog.validate('sorting.plan',{componentId:'x',properties:{constructor:4}}));
  assert.throws(()=>catalog.validate('runtime.character.test_route',{componentId:'x',movements:[]}));
});

class GraphController {
  uuid='graph';enabledInHierarchy=true;isValid=true;graph={layers:[{}]};speed=0;state='Idle';
  getVariables():Array<[string,{type:number}]>{return [['speed',{type:0}]];}
  getValue():number{return this.speed;}
  setValue(_name:string,value:number):void{this.speed=value;}
  getCurrentStateStatus():JsonObject{return {__DEBUG_ID__:this.state,progress:0.5};}
  getNextStateStatus():null{return null;}
  getCurrentTransition():null{return null;}
  getCurrentClipStatuses():unknown[]{return [];}
  getLayerWeight():number{return 1;}
}
test('graph observation preserves explicit debug state ids, typed writes and actual-frame assertions',async()=>{
  const h=new Harness(),component=new GraphController(),cc={...h.cc,animation:{AnimationController:GraphController}},scene={uuid:'s',children:[],getComponents:()=>[component]};
  cc.director.getScene=()=>scene as unknown as typeof h.scene;
  const frames=new FrameSession(cc),tool=new AnimationGraphObserver(new SceneInspector({major:3,cc}),frames);
  const initial=Json.object(await tool.execute('runtime.animation_graph.inspect',{componentId:'graph'}));assert.equal(Json.object(initial.current).stateId,'Idle');
  await assert.rejects(tool.execute('runtime.animation_graph.set_parameter',{componentId:'graph',name:'speed',value:true}),{code:'INVALID_ARGUMENT'});assert.equal(component.speed,0);
  await tool.execute('runtime.animation_graph.set_parameter',{componentId:'graph',name:'speed',value:3});assert.equal(component.speed,3);
  const observed=tool.execute('runtime.animation_graph.assert',{componentId:'graph',frames:2,stateId:'Run'});component.state='Run';cc.director.emit('after');
  assert.equal(Json.object(await observed).matched,true);assert.equal(cc.director.listenerCount('after'),0);
  Object.assign(component,{_graphEval:null,getVariables:()=>{throw new Error('native assertion must not run');}});
  await assert.rejects(tool.execute('runtime.animation_graph.inspect',{componentId:'graph'}),{code:'UNSUPPORTED_CAPABILITY'});
  frames.dispose();
});
class Camera {
  uuid='camera';isValid=true;lines=0;
  camera={geometryRenderer:{addLine:()=>{this.lines++;}}};
}
test('debug overlay expires owned groups and never resets the shared renderer',()=>{
  const h=new Harness(),camera=new Camera(),cc={...h.cc,Camera,Color:Vector},scene={uuid:'s',children:[],getComponents:()=>[camera]};
  cc.director.getScene=()=>scene as unknown as typeof h.scene;
  const debug=new DebugOverlayController(new SceneInspector({major:3,cc}));
  const p={cameraComponentId:'camera',ownerId:'one',lines:[{start:{x:0,y:0,z:0},end:{x:1,y:1,z:1}}]};
  debug.execute('runtime.debug.draw',p);debug.execute('runtime.debug.draw',{...p,ownerId:'two'});cc.director.emit('before');assert.equal(camera.lines,2);
  debug.execute('runtime.debug.clear',{ownerId:'one'});cc.director.emit('before');assert.equal(camera.lines,3);
  assert.equal((Json.object(debug.execute('runtime.debug.inspect',{})).rows as unknown[]).length,1);
  debug.dispose();assert.equal(cc.director.listenerCount('before'),0);cc.director.emit('before');assert.equal(camera.lines,3);
});
