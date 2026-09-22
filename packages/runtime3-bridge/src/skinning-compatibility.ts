import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import { FeatureSupport as F } from './feature-support.js';
import type { SceneInspector } from './scene.js';

export class SkinningCompatibility {
  constructor(private readonly inspector:SceneInspector){}
  plan(p:JsonObject):JsonObject{
    const cc=this.inspector.environment.cc;
    const type=A.call(F.require(cc.js,'class registry'),'getClassByName','cc.SkinnedMeshBatchRenderer');
    F.require(type,'SkinnedMeshBatchRenderer');
    if(typeof type!=='function')throw new CocosError('UNSUPPORTED_CAPABILITY','合批类型不可构造');
    // 已核实 3.8.8 预览编译器会把 super 属性赋值转成自身赋值；不能用执行 setter 的方式探测。
    for(const key of ['mesh','skeleton']){
      const setter=Object.getOwnPropertyDescriptor(type.prototype,key)?.set;
      if(!setter)throw new CocosError('UNSUPPORTED_CAPABILITY',`缺少可验证的合批 ${key} setter`);
      const source=Function.prototype.toString.call(setter);
      if(new RegExp(`\\bthis\\.${key}\\s*=`).test(source)||new RegExp(`\\bthis\\[['"]${key}['"]\\]\\s*=`).test(source))throw new CocosError('UNSUPPORTED_CAPABILITY',`当前引擎合批 ${key} setter 存在递归编译缺陷；需要修复引擎编译产物后再规划`);
    }
    const component=this.inspector.component(Json.string(p.componentId,'componentId'));
    if(!(component instanceof type))throw new CocosError('INVALID_ARGUMENT','目标不是 SkinnedMeshBatchRenderer');
    const units=component.units as RuntimeObject[];
    if(!Array.isArray(units)||units.length<2||units.length>6)throw new CocosError('UNSUPPORTED_CAPABILITY','当前已验证的合批材质模板要求 2..6 个单元');
    const root=F.require(component.skinningRoot,'skinningRoot');
    const skeleton=F.require(units[0]!.skeleton,'shared skeleton');
    const rows=units.map((unit,index)=>{
      F.require(unit.mesh,`mesh ${index}`);F.require(unit.material,`material ${index}`);
      if(unit.skeleton!==skeleton)throw new CocosError('UNSUPPORTED_CAPABILITY','合批单元必须共享同一骨架');
      const mesh=A.object(unit.mesh),structure=F.require(mesh.struct,'mesh struct');
      const primitives=structure.primitives as unknown[];
      if(!Array.isArray(primitives)||primitives.length!==1)throw new CocosError('UNSUPPORTED_CAPABILITY','当前规划仅支持单子网格单元');
      return {index,meshUuid:A.uuid(mesh),materialUuid:A.uuid(unit.material)};
    });
    const material=F.require(A.call(component,'getSharedMaterial',0),'batch material');
    return {supported:true,componentId:A.uuid(component),skinningRootId:A.uuid(root),skeletonUuid:A.uuid(skeleton),materialUuid:A.uuid(material),rows,executionPerformed:false,visualVerified:false,performanceVerified:false};
  }
}
