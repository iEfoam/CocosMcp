import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import { FeatureSupport as F } from './feature-support.js';
import type { SceneInspector } from './scene.js';

/** 通过版本固定的动画编辑器 API 创建独立资产，不覆盖用户已有图或重写其外部资源引用。 */
export class IkAuthoring {
  constructor(private readonly inspector: SceneInspector, private readonly editor: RuntimeObject) {}
  private get cc(): RuntimeObject { return this.inspector.environment.cc; }
  private serializeAsset(asset: RuntimeObject): JsonValue {
    if (!this.inspector.environment.serialize) throw new CocosError('UNSUPPORTED_CAPABILITY', '缺少编辑器原生序列化');
    // Creator 返回 JSON 文本；必须先解析，否则 AssetDB 会导入被二次编码的字符串。
    const value = this.inspector.environment.serialize(asset);
    return Json.value(typeof value === 'string' ? JSON.parse(value) : value);
  }
  private target(rootId: string, path: string): RuntimeObject {
    let node = this.inspector.node(rootId);
    if (!path || path.split('/').some(part => !part || part === '.' || part === '..')) throw new CocosError('INVALID_ARGUMENT', '骨骼路径必须为明确的相对节点路径');
    for (const part of path.split('/')) {
      const matches = (node.children as RuntimeObject[]).filter(child => child.name === part);
      if (matches.length !== 1) throw new CocosError('INVALID_ARGUMENT', `骨骼节点不存在或重名：${path}`);
      node = matches[0]!;
    }
    return node;
  }
  inspect(p: JsonObject): JsonObject {
    F.require(this.editor.AnimationGraph, 'AnimationGraph editor API');
    const type = A.call(F.require(this.cc.js, 'class registry'), 'getClassByName', 'cc.animation.PoseNodeTwoBoneIKSolver');
    F.require(type, 'PoseNodeTwoBoneIKSolver');
    const rootId = Json.string(p.rootId, 'rootId'), end = this.target(rootId, Json.string(p.endEffectorPath, 'endEffectorPath'));
    const middle = A.object(end.parent), root = A.object(middle.parent), scope = this.inspector.node(rootId);
    if (![middle, root].every(node => this.inspector.all(scope).includes(node))) throw new CocosError('INVALID_ARGUMENT', '双骨骼链必须完全位于目标根节点中');
    // 3.8.8 IK 绑定按骨骼名称递归查找，不接受路径；校验整个控制器子树以避免悄悄绑定同名骨骼。
    for (const bone of [root,middle,end]) if(this.inspector.all(scope).filter(node=>node.name===bone.name).length!==1) throw new CocosError('INVALID_ARGUMENT','IK 骨骼名称在控制器子树中必须唯一');
    const length = (node: RuntimeObject): number => { const v = A.object(node.position); return Math.hypot(Number(v.x), Number(v.y), Number(v.z)); };
    if (length(end) < 1e-6 || length(middle) < 1e-6) throw new CocosError('INVALID_ARGUMENT', '不能对零长度骨骼链创建 IK');
    return { supported: true, rootId, chain: [root, middle, end].map(node => ({ nodeId: A.uuid(node), name: String(node.name) })), coordinateSpace: 'controller-local', graphCreationSupported: true };
  }
  serialize(p: JsonObject): JsonValue {
    this.inspect(p);
    const graph = A.construct(this.editor.AnimationGraph, []);
    try {
      graph.name = Json.string(p.name, 'name');
      const layer = A.object(A.call(graph, 'addLayer')); layer.name = 'IK';
      const machine = A.object(layer.stateMachine), state = A.object(A.call(machine, 'addProceduralPoseState')); state.name = 'IK';
      const pose = A.object(state.graph), type = A.call(this.cc.js, 'getClassByName', 'cc.animation.PoseNodeTwoBoneIKSolver'), solver = A.construct(type, []);
      solver.endEffectorBoneName = String(this.target(Json.string(p.rootId,'rootId'),Json.string(p.endEffectorPath,'endEffectorPath')).name);
      const assign = (target: unknown, value: JsonValue | undefined): void => {
        const spec = A.object(target), position = Json.object(value);
        if (['x','y','z'].some(key => typeof position[key] !== 'number' || !Number.isFinite(position[key]) || Math.abs(Number(position[key])) > 100000)) throw new CocosError('INVALID_ARGUMENT', 'IK 目标坐标无效');
        spec.type = 1; spec.targetPositionSpace = 1;
        spec.targetPosition = A.construct(this.cc.Vec3, [position.x, position.y, position.z]);
      };
      assign(solver.endEffectorTarget, p.target);
      if (p.pole) assign(solver.poleTarget, p.pole);
      A.call(pose, 'addNode', solver);
      const op = F.require(this.editor.poseGraphOp, 'poseGraphOp'); F.methods(op, ['connectOutputNode', 'getInputBinding', 'getInputKeys']);
      A.call(op, 'connectOutputNode', pose, solver);
      const keys = A.call(op, 'getInputKeys', pose.outputNode) as unknown[];
      const binding = A.call(op, 'getInputBinding', pose, pose.outputNode, keys[0]);
      if (!binding || A.object(binding).producer !== solver) throw new CocosError('UNSUPPORTED_CAPABILITY', '原生姿势图连线未生效');
      A.call(machine, 'connect', machine.entryState, state);
      if(p.enabledParameter!==undefined){
        const name=Json.string(p.enabledParameter,'enabledParameter');
        if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name))throw new CocosError('INVALID_ARGUMENT','IK 开关参数需为 1..64 位字母、数字或下划线，并以字母开头');
        const booleanType=F.type(this.cc,'animation.VariableType.BOOLEAN');
        if(typeof booleanType!=='number')throw new CocosError('UNSUPPORTED_CAPABILITY','缺少布尔动画变量类型');
        const conditionType=A.call(this.cc.js,'getClassByName','cc.animation.UnaryCondition');F.require(conditionType,'UnaryCondition');
        F.methods(graph,['addVariable']);F.methods(machine,['addMotion']);
        A.call(graph,'addVariable',name,booleanType,true);
        const rest=A.object(A.call(machine,'addMotion'));rest.name='Rest';
        // 空 MotionState 使用骨骼初始姿态。关闭退出时间，避免无时长动作永远不能回到 IK。
        for(const [from,to,operator] of [[state,rest,1],[rest,state,0]] as const){
          const condition=A.construct(conditionType,[]);condition.operator=operator;A.object(condition.operand).variable=name;
          const transition=A.object(A.call(machine,'connect',from,to,[condition]));transition.duration=0;
          if('exitConditionEnabled' in transition)transition.exitConditionEnabled=false;
        }
      }
      return this.serializeAsset(graph);
    } finally { A.destroyOwned(this.cc, graph); }
  }
  mask(p: JsonObject): JsonValue {
    const type = F.require(this.editor.AnimationMask, 'AnimationMask'), rootId = Json.string(p.rootId, 'rootId');
    if (!Array.isArray(p.joints) || !p.joints.length || p.joints.length > 256) throw new CocosError('INVALID_ARGUMENT', '遮罩需 1..256 项');
    const seen = new Set<string>(), joints = p.joints.map(value => {
      const row = Json.object(value), path = Json.string(row.path, 'path');
      if (seen.has(path) || typeof row.enabled !== 'boolean') throw new CocosError('INVALID_ARGUMENT', '遮罩路径重复或 enabled 无效');
      seen.add(path); this.target(rootId, path); return { path, enabled: row.enabled };
    });
    const asset = A.construct(type, []);
    try {
      asset.name = Json.string(p.name, 'name');
      for (const joint of joints) A.call(asset, 'addJoint', joint.path, joint.enabled);
      return this.serializeAsset(asset);
    } finally { A.destroyOwned(this.cc, asset); }
  }
}
