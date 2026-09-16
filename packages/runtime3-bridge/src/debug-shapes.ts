import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';

/** 只生成有界线段，生命周期及共享绘制器所有权统一交给 DebugOverlayController。 */
export class DebugShapes {
  private point(value: JsonValue | undefined): JsonObject {
    const point=Json.object(value);
    if(['x','y','z'].some(axis=>typeof point[axis]!=='number'||!Number.isFinite(point[axis])||Math.abs(Number(point[axis]))>100000))throw new CocosError('INVALID_ARGUMENT','调试坐标无效');
    return {x:point.x!,y:point.y!,z:point.z!};
  }
  lines(p: JsonObject): JsonObject[] {
    const shape=Json.object(p.shape),kind=Json.string(shape.kind,'shape.kind');
    if(kind==='ray'){
      const start=this.point(shape.origin),direction=this.point(shape.direction),length=Number(shape.length);
      const norm=Math.hypot(Number(direction.x),Number(direction.y),Number(direction.z));
      if(!Number.isFinite(length)||length<=0||length>10000||norm<1e-8)throw new CocosError('INVALID_ARGUMENT','射线长度或方向无效');
      const end=this.point(Object.fromEntries(['x','y','z'].map(axis=>[axis,Number(start[axis])+Number(direction[axis])*length/norm])));
      return [{start,end}];
    }
    if(kind==='points'){
      if(!Array.isArray(shape.points)||!shape.points.length||shape.points.length>256)throw new CocosError('INVALID_ARGUMENT','点预览需 1..256 个点');
      const radius=Number(shape.radius??0.05);
      if(!Number.isFinite(radius)||radius<=0||radius>10)throw new CocosError('INVALID_ARGUMENT','点预览半径无效');
      return shape.points.flatMap(value=>{const point=this.point(value);return ['x','y','z'].map(axis=>({start:this.point({...point,[axis]:Number(point[axis])-radius}),end:this.point({...point,[axis]:Number(point[axis])+radius})}));});
    }
    let corners:JsonObject[];
    if(kind==='box'){
      const min=this.point(shape.min),max=this.point(shape.max);
      if(['x','y','z'].some(axis=>Number(min[axis])>=Number(max[axis])))throw new CocosError('INVALID_ARGUMENT','包围盒 min 必须小于 max');
      corners=Array.from({length:8},(_,index)=>({x:(index&1)?max.x!:min.x!,y:(index&2)?max.y!:min.y!,z:(index&4)?max.z!:min.z!}));
    }else if(kind==='frustum'){
      if(!Array.isArray(shape.corners)||shape.corners.length!==8)throw new CocosError('INVALID_ARGUMENT','视锥需近面和远面各四个同向排列的角点');
      corners=shape.corners.map(value=>this.point(value));
      return [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]].map(([a,b])=>({start:corners[a!]!,end:corners[b!]!}));
    }else throw new CocosError('INVALID_ARGUMENT',`未知调试形状：${kind}`);
    return corners.flatMap((start,index)=>[1,2,4].filter(bit=>!(index&bit)).map(bit=>({start,end:corners[index|bit]!})));
  }
}
