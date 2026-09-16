import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import { FeatureSupport as F } from './feature-support.js';
import type { SceneInspector } from './scene.js';
import { FrameSession } from './frame-session.js';

export class EngineFeatureInspector {
  constructor(private readonly inspector: SceneInspector, private readonly frames?: FrameSession) {}
  private get cc(): RuntimeObject { return this.inspector.environment.cc; }
  postprocess(p:JsonObject):JsonObject {
    const state=this.inspect('postprocess',p),root=F.require(A.object(this.cc.director).root,'render root');
    if(root.usesCustomPipeline!==true)throw new CocosError('UNSUPPORTED_CAPABILITY','当前运行时未使用自定义后处理管线');
    const camera=this.inspector.component(Json.string(p.cameraComponentId,'cameraComponentId'));
    const cameraType=this.cc.Camera;
    if(typeof cameraType!=='function'||!(camera instanceof cameraType))throw new CocosError('INVALID_ARGUMENT','目标不是 Camera');
    const native=F.require(camera.camera,'active camera');
    if(native.usePostProcess!==true)throw new CocosError('UNSUPPORTED_CAPABILITY','目标相机未开启后处理');
    const setting=this.inspector.component(Json.string(p.componentId,'componentId'));
    if(!setting.enabledInHierarchy)throw new CocosError('UNSUPPORTED_CAPABILITY','目标后处理组件未激活');
    let selected=native.postProcess;
    if(!selected){
      const postType=A.call(this.cc.js,'getClassByName','cc.PostProcess');
      const all=postType ? A.object(postType).all : undefined;
      if(Array.isArray(all))for(const post of all)if(A.object(post).global)selected=post;
    }
    const post=F.require(selected,'camera post-process settings');F.methods(post,['getSetting']);
    if(A.call(post,'getSetting',setting.constructor)!==setting)throw new CocosError('UNSUPPORTED_CAPABILITY','相机当前没有使用目标后处理组件');
    const rendering=F.require(this.cc.rendering,'rendering');F.methods(rendering,['getCustomPipeline']);
    const name=F.require(this.cc.macro,'macro').CUSTOM_PIPELINE_NAME;
    const builder=F.require(A.call(rendering,'getCustomPipeline',name),'active pipeline builder');
    F.methods(builder,['getCameraPasses']);
    const passes=A.call(builder,'getCameraPasses',native) as RuntimeObject[];
    if(!Array.isArray(passes)||passes.length>64)throw new CocosError('UNSUPPORTED_CAPABILITY','管线 Pass 列表不可验证');
    const expected:Record<string,string>={'cc.Bloom':'BloomPass','cc.FXAA':'FxaaPass','cc.ColorGrading':'ColorGradingPass'};
    const pass=expected[String(state.type)];
    if(!passes.some(entry=>entry.name===pass))throw new CocosError('UNSUPPORTED_CAPABILITY',`目标相机的管线未包含 ${pass}`);
    return {...state,cameraComponentId:A.uuid(camera),pipelineName:String(name),rows:passes.map(entry=>({name:String(entry.name)})),pipelineVerified:true,visualVerified:false};
  }
  inspect(family: string, p: JsonObject): JsonObject {
    const names: Record<string,string[]> = { sorting:['cc.Sorting2D'],postprocess:['cc.Bloom','cc.FXAA','cc.ColorGrading'],probe:['cc.LightProbeGroup'],character:['cc.CapsuleCharacterController','cc.BoxCharacterController'],skinning:['cc.SkinnedMeshBatchRenderer'],ik:['cc.animation.AnimationController','cc.AnimationController'] };
    const expected = names[family]; if (!expected) throw new CocosError('UNSUPPORTED_CAPABILITY','未知引擎功能');
    const js = F.require(this.cc.js,'class registry'); F.methods(js,['getClassByName']);
    const types = expected.map(name=>A.call(js,'getClassByName',name)).filter(type=>typeof type==='function');
    if (!types.length) throw new CocosError('UNSUPPORTED_CAPABILITY',`当前工程未启用 ${expected.join('/')}`);
    const component = this.inspector.component(Json.string(p.componentId,'componentId'));
    if (!types.some(type => component instanceof (type as new (...args: never[]) => object))) throw new CocosError('INVALID_ARGUMENT','目标组件类型不匹配');
    // 必须在读取 isGrounded/velocity 等 getter 前验证后端；这些 getter 会直接解引用 _cct。
    if (family === 'character') {
      F.methods(component, ['move', 'getMask', 'getGroup']);
      const physics = F.require(this.cc.PhysicsSystem, 'PhysicsSystem'), instance = F.require(physics.instance, 'active PhysicsSystem');
      if (instance.enable === false || !component._cct || component._isInitialized !== true) throw new CocosError('UNSUPPORTED_CAPABILITY', '当前物理后端未初始化角色控制器');
    }
    const fields: Record<string,string[]> = { sorting:['sortingLayer','sortingOrder'],postprocess:['enabled','threshold','iterations','intensity','contribute'],probe:['probes','minPos','maxPos','nProbesX','nProbesY','nProbesZ'],character:['enabledInHierarchy','stepOffset','slopeLimit','skinWidth','isGrounded','velocity','centerWorldPosition'],skinning:['atlasSize','batchableTextureNames','units'],ik:['enabledInHierarchy'] };
    const properties: JsonObject = {};
    for (const key of fields[family]!) if (key in component) {
      if (key === 'units') {
        const units = component.units;
        if (!Array.isArray(units) || units.length > 128) throw new CocosError('RESOURCE_BUSY', '合批单元超过检查预算');
        properties.units = units.map(value => { const unit = A.object(value); return { meshUuid: unit.mesh ? A.uuid(unit.mesh) : null, skeletonUuid: unit.skeleton ? A.uuid(unit.skeleton) : null, materialUuid: unit.material ? A.uuid(unit.material) : null, offset: A.safeData(unit.offset), size: A.safeData(unit.size) }; });
      } else {
        if (Array.isArray(component[key]) && (component[key] as unknown[]).length > 4096) throw new CocosError('RESOURCE_BUSY', '组件数组超过检查预算');
        properties[key] = A.safeData(component[key]);
      }
    }
    return { supported:true,componentId:A.uuid(component),type:this.inspector.type(component),properties,visualVerified:false,
      ...(family==='postprocess'?{pipelineVerified:false,scope:'existing-setting-configuration'}:{}),
      ...(family==='ik'?{scope:'controller-module-only',graphAuthoringSupported:false}:{}),
      ...(family==='skinning'?{scope:'existing-batch-component',optimizationVerified:false}:{}) };
  }
  probePoints(p: JsonObject): JsonObject {
    this.inspect('probe', p);
    const component=this.inspector.component(Json.string(p.componentId,'componentId'));
    const probes=component.probes;
    if(!Array.isArray(probes)||!probes.length)throw new CocosError('UNSUPPORTED_CAPABILITY','探针组没有可预览的点');
    const offset=Number(p.offset??0),limit=Number(p.limit??256);
    if(!Number.isInteger(offset)||offset<0||offset>=probes.length||!Number.isInteger(limit)||limit<1||limit>256)throw new CocosError('INVALID_ARGUMENT','探针预览分页范围无效');
    const vector=F.require(this.cc.Vec3,'Vec3');F.methods(vector,['transformMat4']);
    const node=F.require(component.node,'probe node'),matrix=F.require(node.worldMatrix,'probe world matrix');
    // 探针保存在组节点局部空间；只转换所选页，不修改资源或自动触发烘焙。
    const rows=probes.slice(offset,offset+limit).map(value=>{
      const point=A.object(value);
      if(['x','y','z'].some(axis=>typeof point[axis]!=='number'||!Number.isFinite(point[axis])))throw new CocosError('INVALID_ARGUMENT','探针坐标无效');
      const v=A.construct(vector,[point.x,point.y,point.z]);
      return A.safeData(A.call(vector,'transformMat4',v,v,matrix));
    });
    return {rows,total:probes.length,offset,nextOffset:offset+rows.length<probes.length?offset+rows.length:null,coordinateSpace:'world',bakeVerified:false};
  }
  generate(p: JsonObject): JsonObject {
    if (p.method==='adaptive') throw new CocosError('UNSUPPORTED_CAPABILITY','3.8.8 自适应布点仍为均匀算法占位实现');
    const min=Json.object(p.min),max=Json.object(p.max),counts=Json.object(p.counts),axes=['x','y','z'];
    for(const axis of axes) if(typeof min[axis]!=='number'||typeof max[axis]!=='number'||!Number.isFinite(min[axis])||!Number.isFinite(max[axis])||Number(min[axis])>=Number(max[axis])||!Number.isInteger(counts[axis])||Number(counts[axis])<2||Number(counts[axis])>32) throw new CocosError('INVALID_ARGUMENT','探针范围和数量无效');
    const total=Number(counts.x)*Number(counts.y)*Number(counts.z); if(total>4096) throw new CocosError('INVALID_ARGUMENT','探针数量超过 4096');
    const rows:JsonObject[]=[];
    for(let x=0;x<Number(counts.x);x++) for(let y=0;y<Number(counts.y);y++) for(let z=0;z<Number(counts.z);z++) rows.push(Object.fromEntries(axes.map((axis,i)=>[axis,Number(min[axis])+(Number(max[axis])-Number(min[axis]))*[x,y,z][i]!/(Number(counts[axis])-1)])));
    return {supported:true,rows,method:'uniform',coordinateSpace:'probe-group-local',bakeVerified:false};
  }
  async route(p: JsonObject): Promise<JsonValue> {
    const before=this.inspect('character',p),component=this.inspector.component(Json.string(p.componentId,'componentId'));
    if (!component.enabledInHierarchy) throw new CocosError('CONTEXT_UNAVAILABLE','角色控制器未激活');
    if(!this.frames) throw new CocosError('UNSUPPORTED_CAPABILITY','通行测试需要运行时帧会话');
    F.require(this.cc.Vec3,'Vec3');
    if(!Array.isArray(p.movements)||!p.movements.length||p.movements.length>120) throw new CocosError('INVALID_ARGUMENT','位移序列必须为 1..120 项');
    const movements=p.movements.map(value=>{const v=Json.object(value); if(['x','y','z'].some(key=>typeof v[key]!=='number'||!Number.isFinite(v[key])||Math.abs(Number(v[key]))>10)) throw new CocosError('INVALID_ARGUMENT','单帧各轴位移不得超过 10');return A.construct(this.cc.Vec3,[v.x,v.y,v.z]);});
    const token=this.frames.token(),rows:JsonObject[]=[],started=performance.now();
    F.methods(component,['on','off']);
    const events:JsonObject[]=[],listeners:Array<{name:string;callback:(value:unknown)=>void}>=[];
    let active=true,droppedEvents=0,frame=-1;
    const cleanupErrors:string[]=[];
    const expected=p.expectedEnd ? Json.object(p.expectedEnd) : undefined,tolerance=Number(p.tolerance??0.05);
    if(!Number.isFinite(tolerance)||tolerance<=0||tolerance>10||expected&&['x','y','z'].some(axis=>typeof expected[axis]!=='number'||!Number.isFinite(expected[axis])))throw new CocosError('INVALID_ARGUMENT','目标位置或容差无效');
    // 先等待一帧确认会话有效，再执行位移；不在失败后重放已经发生的碰撞事件。
    await this.frames.wait(token);
    try {
      for(const name of ['onControllerColliderHit','onControllerTriggerEnter','onControllerTriggerStay','onControllerTriggerExit']){
        const callback=(value:unknown):void=>{
          if(!active)return;
          if(events.length>=512){droppedEvents++;return;}
          const event=value&&typeof value==='object'?value as RuntimeObject:{};
          // 引擎复用事件对象；当场复制有限字段，不能保存活对象或递归序列化整个碰撞世界。
          events.push({type:name,frame,colliderId:event.collider?A.uuid(event.collider):event.otherCollider?A.uuid(event.otherCollider):null,
            position:A.safeData(event.worldPosition),normal:A.safeData(event.worldNormal),motionLength:A.safeData(event.motionLength)});
        };
        listeners.push({name,callback});A.call(component,'on',name,callback);
      }
      for(const movement of movements){
        frame++;
        this.frames.check(token); if(performance.now()-started>15000) throw new CocosError('CONTEXT_UNAVAILABLE','通行测试超过 15 秒');
        if(component.isValid===false||!component.enabledInHierarchy) throw new CocosError('STALE_HANDLE','角色已失效');
        A.call(component,'move',movement); await this.frames.wait(token);
        rows.push({requested:A.safeData(movement),position:A.safeData(component.centerWorldPosition),velocity:A.safeData(component.velocity),grounded:Boolean(component.isGrounded)});
      }
    } catch(error){throw new CocosError('OUTCOME_UNKNOWN','通行测试部分完成，不可自动重试',{rows,events,droppedEvents,cause:CocosError.from(error).message});}
    finally{
      active=false;
      for(const {name,callback} of listeners)try{A.call(component,'off',name,callback);}catch(error){cleanupErrors.push(CocosError.from(error).message);}
    }
    if(cleanupErrors.length)throw new CocosError('OUTCOME_UNKNOWN','位移已完成，但事件监听清理失败；回调已失效',{rows,events,cleanupErrors});
    const final=Json.object(rows[rows.length-1]!.position),distance=expected?Math.hypot(...['x','y','z'].map(axis=>Number(final[axis])-Number(expected[axis]))):undefined;
    return {supported:true,before,rows,events,droppedEvents,eventsReversible:false,scope:'observed-displacement-not-navigation-success',...(distance!==undefined?{distanceToTarget:distance,reached:distance<=tolerance,tolerance}:{})};
  }
}
