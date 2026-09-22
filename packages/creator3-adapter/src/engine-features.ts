import { createHash } from 'node:crypto';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { FeatureSupport as F } from '../../runtime3-bridge/src/feature-support.js';
import { PropertyDump } from './dump.js';
import type { EditorPort } from './port.js';

export class EngineFeatureService {
  constructor(private readonly port:EditorPort,private readonly run:(id:string,p:JsonObject)=>Promise<JsonValue>){}
  private async requireModule(id: string): Promise<void> {
    const feature = id.startsWith('ik.') ? (id==='ik.mask_create'?'marionette':'procedural-animation') : id.startsWith('sorting.') ? 'sorting-2d' : id.startsWith('postprocess.') ? 'custom-pipeline-post-process' : undefined;
    if (!feature) return;
    // 编辑器注册了全部类，不代表项目预览包含该模块；写入前检查裁剪配置，避免保存出无法加载的组件或图。
    const settings = Json.object(Json.object(await this.run('project.settings.get',{name:'engine'})).settings);
    const modules = settings.modules ? Json.object(settings.modules) : undefined;
    const configs = modules?.configs ? Json.object(modules.configs) : undefined;
    const config = configs?.[String(modules?.globalConfigKey)];
    const included = config && Json.object(config).includeModules;
    if (!Array.isArray(included) || !included.includes(feature)) throw new CocosError('UNSUPPORTED_CAPABILITY',`项目未启用或无法确认引擎模块：${feature}`);
  }
  async execute(id:string,p:JsonObject):Promise<JsonValue>{
    return F.run(id,this.port.version,async()=>{
      await this.requireModule(id);
      if(id.startsWith('ik.')) {
        if(id==='ik.inspect') return Json.value(await this.port.scene(id,p));
        const mask=id==='ik.mask_create',url=Json.string(p.url,'url');
        if(!url.endsWith(mask?'.animask':'.animgraph')) throw new CocosError('INVALID_ARGUMENT','动画图或遮罩资源扩展名不正确');
        const params={...p};delete params.planHash;
        const snapshot=Json.value(await this.port.scene('fingerprint'));
        const planHash=createHash('sha256').update(Json.canonical({params,snapshot,version:this.port.version})).digest('hex');
        if(id==='ik.apply'&&p.planHash!==planHash) throw new CocosError('OPERATION_CONFLICT','IK 场景或计划已变化，请重新规划');
        const content=Json.value(await this.port.scene(mask?'ik.mask_serialize':'ik.serialize',params));
        if(content&&!Array.isArray(content)&&typeof content==='object'&&content.supported===false)return content;
        if(id==='ik.plan') return {supported:true,planHash,rootId:p.rootId!,url,coordinateSpace:'controller-local',createsNewAsset:true,bindsExistingController:false};
        if(Json.canonical(Json.value(await this.port.scene('fingerprint')))!==Json.canonical(snapshot))throw new CocosError('OPERATION_CONFLICT','序列化期间场景已变化');
        const created=Json.object(await this.run('asset.create',{url,content:JSON.stringify(content)}));
        return {supported:true,...created,bound:false,poseVerified:false};
      }
      if(id==='path.bake_clip'){
        const document=Json.object(await this.port.scene('path.clip_document',p));
        if(document.supported===false) return document;
        return this.run('animation.clip.create',{url:p.url!,rootId:p.rootId!,document});
      }
      if(id.startsWith('path.')||id==='probe.generate') return Json.value(await this.port.scene(id,p));
      const family=id.split('.')[0]!;
      const inspected=Json.object(await this.port.scene('engine.feature.inspect',{family,componentId:p.componentId!}));
      if(inspected.supported===false||id.endsWith('.inspect')) return inspected;
      const properties=Json.object(p.properties), current=Json.object(inspected.properties);
      if(!Object.keys(properties).length) throw new CocosError('INVALID_ARGUMENT','修改属性不能为空');
      for(const key of Object.keys(properties)) if(!Object.hasOwn(current,key)) throw new CocosError('UNSUPPORTED_CAPABILITY',`当前组件不支持属性 ${key}`);
      const dump=Json.object(Json.object(await this.run('component.query',{componentId:p.componentId!})).component);
      for(const [key,value] of Object.entries(properties)) PropertyDump.assign(PropertyDump.locate(dump,key),value);
      const snapshot=Json.value(await this.port.scene('fingerprint'));
      const planHash=createHash('sha256').update(Json.canonical({family,componentId:p.componentId!,properties,snapshot,version:this.port.version})).digest('hex');
      const rows=Object.entries(properties).filter(([key,value])=>Json.canonical(value)!==Json.canonical(current[key]!)).map(([property,after])=>({property,before:current[property]!,after}));
      if(id.endsWith('.plan')) return {supported:true,planHash,rows,sceneSaveRequired:rows.length>0};
      if(p.planHash!==planHash) throw new CocosError('OPERATION_CONFLICT','场景或计划已变化，请重新规划');
      if(rows.length===0) return {supported:true,rows,sceneSaveRequired:false};
      const completed:JsonObject[]=[];
      try{
        for(const row of rows){await this.run('component.set',{componentId:p.componentId!,properties:{[row.property]:row.after}});completed.push(row);}
        const after=Json.object(await this.port.scene('engine.feature.inspect',{family,componentId:p.componentId!}));
        if(after.supported===false) throw new CocosError('OUTCOME_UNKNOWN','修改后模块不可查询');
        const values=Json.object(after.properties);
        for(const row of rows) if(Json.canonical(values[row.property]??null)!==Json.canonical(row.after)) throw new CocosError('OUTCOME_UNKNOWN',`属性读回不一致：${row.property}`);
        return {supported:true,rows,after,sceneSaveRequired:true,visualVerified:false};
      }catch(error){throw new CocosError('OUTCOME_UNKNOWN','修改可能部分完成，保留现场并重新查询；不执行全局撤销',{completed,cause:CocosError.from(error).message});}
    });
  }
}
