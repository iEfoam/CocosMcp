import type { Capability, JsonSchema } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';

export class EngineFeatureCapabilities {
  static readonly vector = S.object({ x: { type: 'number', minimum: -100000, maximum: 100000 }, y: { type: 'number', minimum: -100000, maximum: 100000 }, z: { type: 'number', minimum: -100000, maximum: 100000 } }, ['x','y','z']);
  static readonly path = { mode: S.enum('linear','bezier','catmull_rom'), points: { type: 'array', minItems: 2, maxItems: 256, items: this.vector }, samples: { type: 'integer', minimum: 2, maximum: 1000 }, uniformSpeed: S.boolean() };
  list(): Capability[] {
    const rows: Capability[] = [];
    const add = (id: string, module: string, title: string, effect: Capability['effect'], properties: Record<string, JsonSchema>, required: string[] = []): void => {
      rows.push({ id, module, title, description: title, effect, context: id.startsWith('runtime.') ? 'runtime' : 'editor', inputSchema: S.object(properties, required), outputSchema: {}, versions: [3], supportedMajors: [3], implementation: 'implemented', verification: 'unverified', prerequisites: ['Creator 3.8.8；依赖缺失返回 supported=false'], source: 'cocos/cocos-engine@411f98df047c25902f93440d4b22925c2fb65461', rollback: '临时对象按所有权清理；持久化变更使用计划守卫；游戏事件不可回滚' });
    };
    for (const action of ['plan','sample']) add(`path.${action}`, 'F23', '引擎样条采样与近似等速规划', 'read', EngineFeatureCapabilities.path, ['points']);
    add('path.bake_clip', 'F23', '将局部路径采样保存为位置动画，不自动绑定或播放', 'asset', { ...EngineFeatureCapabilities.path, url: S.string(), rootId: S.string(), name: S.string(), targetPath: { type:'string', maxLength:512 }, duration:{ type:'number', exclusiveMinimum:0, maximum:600 } }, ['points','url','rootId','name','duration']);
    const component = { componentId: S.string() }, graph = { ...component, layer: { type:'integer', minimum:0, maximum:63 } };
    add('runtime.animation_graph.inspect','F24','查询动画图变量、层状态、过渡与剪辑权重','read',graph,['componentId']);
    add('runtime.animation_graph.set_parameter','F24','修改已有动画图标量参数并读回','runtime',{...graph,name:S.string(),value:{anyOf:[{type:'number'},{type:'boolean'}]}},['componentId','name','value']);
    for (const action of ['trace','assert']) add(`runtime.animation_graph.${action}`,'F24','按实际渲染帧观测动画图状态','read',{...graph,frames:{type:'integer',minimum:1,maximum:300},...(action==='assert'?{stateId:S.string()}: {})},['componentId',...(action==='assert'?['stateId']:[])]);
    const debug = { cameraComponentId:S.string(),ownerId:S.string(),ttlMs:{type:'integer',minimum:16,maximum:30000},depthTest:S.boolean(),color:{type:'array',minItems:4,maxItems:4,items:{type:'integer',minimum:0,maximum:255}},lines:{type:'array',minItems:1,maxItems:1024,items:S.object({start:EngineFeatureCapabilities.vector,end:EngineFeatureCapabilities.vector},['start','end'])} };
    add('runtime.debug.draw','F11','向已激活的相机调试绘制器提交有界世界坐标线段','runtime',debug,['cameraComponentId','ownerId','lines']);
    const {lines: _lines,...drawing}=debug,vector=EngineFeatureCapabilities.vector;
    add('runtime.debug.shape','F11','绘制世界坐标射线、包围盒、视锥或探针点','runtime',{...drawing,shape:{anyOf:[
      S.object({kind:{const:'ray'},origin:vector,direction:vector,length:{type:'number',exclusiveMinimum:0,maximum:10000}},['kind','origin','direction','length']),
      S.object({kind:{const:'box'},min:vector,max:vector},['kind','min','max']),
      S.object({kind:{const:'frustum'},corners:{type:'array',minItems:8,maxItems:8,items:vector}},['kind','corners']),
      S.object({kind:{const:'points'},points:{type:'array',minItems:1,maxItems:256,items:vector},radius:{type:'number',exclusiveMinimum:0,maximum:10}},['kind','points'])
    ]}},['cameraComponentId','ownerId','shape']);
    add('runtime.debug.inspect','F11','查询工具绘制组和绘制失败记录','read',{});
    add('runtime.debug.clear','F11','只清理指定 ownerId 的工具绘制组','runtime',{ownerId:S.string()},['ownerId']);
    add('runtime.path.preview','F23','将局部路径转换到世界坐标并显示','runtime',{...EngineFeatureCapabilities.path,cameraComponentId:S.string(),parentId:S.string(),ownerId:S.string(),ttlMs:{type:'integer',minimum:16,maximum:30000}},['points','cameraComponentId','parentId','ownerId']);
    for (const family of ['sorting','postprocess','probe']) {
      add(`${family}.inspect`,family==='sorting'?'F18':family==='probe'?'F30':'F31','查询原生组件能力与配置','read',component,['componentId']);
      const properties: Record<string,JsonSchema> = family==='sorting' ? { sortingLayer:{type:'integer',minimum:0},sortingOrder:{type:'integer',minimum:-32768,maximum:32767} } : family==='probe' ? { probes:{type:'array',minItems:8,maxItems:4096,items:EngineFeatureCapabilities.vector} } : { enabled:S.boolean(),threshold:{type:'number',minimum:0,maximum:100},iterations:{type:'integer',minimum:1,maximum:6},intensity:{type:'number',minimum:0,maximum:100},contribute:{type:'number',minimum:0,maximum:1} };
      for (const action of ['plan','apply']) add(`${family}.${action}`,family==='sorting'?'F18':family==='probe'?'F30':'F31','生成或执行有场景指纹守卫的组件修改',''+(action==='plan'?'read':'scene') as Capability['effect'],{...component,properties:S.object(properties),...(action==='apply'?{planHash:S.string()}: {})},['componentId','properties',...(action==='apply'?['planHash']:[])]);
    }
    add('runtime.probe.preview','F30','分页预览已有探针组，转换到世界坐标，不烘焙','runtime',{...drawing,...component,offset:{type:'integer',minimum:0,maximum:4095},limit:{type:'integer',minimum:1,maximum:256},radius:{type:'number',exclusiveMinimum:0,maximum:10}},['componentId','cameraComponentId','ownerId']);
    add('probe.generate','F30','生成均匀探针局部点阵；自适应模式明确不支持','read',{min:EngineFeatureCapabilities.vector,max:EngineFeatureCapabilities.vector,counts:S.object({x:{type:'integer',minimum:2,maximum:32},y:{type:'integer',minimum:2,maximum:32},z:{type:'integer',minimum:2,maximum:32}},['x','y','z']),method:S.enum('uniform','adaptive')},['min','max','counts']);
    add('runtime.character.inspect','F33','查询角色控制器状态和后端支持','read',component,['componentId']);
    add('runtime.character.test_route','F33','执行有界角色位移并记录碰撞事件及目标误差','runtime',{...component,movements:{type:'array',minItems:1,maxItems:120,items:EngineFeatureCapabilities.vector},expectedEnd:EngineFeatureCapabilities.vector,tolerance:{type:'number',exclusiveMinimum:0,maximum:10}},['componentId','movements']);
    add('runtime.skinning.inspect','F21','查询已有蒙皮合批组件、材质与图集配置','read',component,['componentId']);
    add('runtime.skinning.plan','F21','检查合批编译缺陷、共享骨架与单元预算，不激活组件','read',component,['componentId']);
    add('runtime.postprocess.inspect','F31','核查相机开关、实际管线及后处理 Pass；不代表像素效果通过','read',{...component,cameraComponentId:S.string()},['componentId','cameraComponentId']);
    add('runtime.ik.inspect','F24','查询动画控制器的程序化动画模块可用性','read',component,['componentId']);
    const ik = {rootId:S.string(),endEffectorPath:S.string(),target:EngineFeatureCapabilities.vector,pole:EngineFeatureCapabilities.vector,name:{type:'string',minLength:1,maxLength:128},url:S.string(),enabledParameter:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9_]{0,63}$'}};
    add('ik.inspect','F24','检查双骨骼链与原生动画图编辑 API','read',{rootId:S.string(),endEffectorPath:S.string()},['rootId','endEffectorPath']);
    for (const action of ['plan','apply']) add(`ik.${action}`,'F24','创建独立双骨骼 IK 图；不覆盖或自动绑定已有图',action==='plan'?'read':'asset',{...ik,...(action==='apply'?{planHash:S.string()}: {})},['rootId','endEffectorPath','target','name','url',...(action==='apply'?['planHash']:[])]);
    add('ik.mask_create','F24','创建经过骨骼路径校验的独立动画遮罩','asset',{rootId:S.string(),url:S.string(),name:{type:'string',minLength:1,maxLength:128},joints:{type:'array',minItems:1,maxItems:256,items:S.object({path:S.string(),enabled:S.boolean()},['path','enabled'])}},['rootId','url','name','joints']);
    return rows;
  }
}
