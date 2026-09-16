/** 自包含 glTF 测试资源：两个网格共享三关节骨架、材质和一条循环摆动动画。 */
export class MinimalSkinnedFixture {
  document(): string {
    const chunks: Buffer[] = [], views: object[] = [], accessors: object[] = [];
    let length = 0;
    const add = (data: Float32Array | Uint16Array, type: string, count: number, bounds: object = {}): number => {
      const padding = (4 - length % 4) % 4;
      if (padding) { chunks.push(Buffer.alloc(padding)); length += padding; }
      const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const bufferView = views.length;
      views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
      chunks.push(bytes); length += bytes.length;
      accessors.push({ bufferView, componentType: data instanceof Float32Array ? 5126 : 5123, count, type, ...bounds });
      return accessors.length - 1;
    };
    const positions = add(new Float32Array([-.3,0,0,.3,0,0,-.3,2,0,.3,2,0]), 'VEC3', 4, {min:[-.3,0,0],max:[.3,2,0]});
    const positionsB = add(new Float32Array([.7,0,0,1.3,0,0,.7,2,0,1.3,2,0]), 'VEC3', 4, {min:[.7,0,0],max:[1.3,2,0]});
    const normals = add(new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]), 'VEC3', 4);
    const uv = add(new Float32Array([0,0,1,0,0,1,1,1]), 'VEC2', 4);
    const joints = add(new Uint16Array([0,0,0,0,0,0,0,0,2,0,0,0,2,0,0,0]), 'VEC4', 4);
    const weights = add(new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0]), 'VEC4', 4);
    const indices = add(new Uint16Array([0,1,2,2,1,3]), 'SCALAR', 6);
    const matrices: number[] = [];
    for(let bone=0;bone<3;bone++)matrices.push(1,0,0,0,0,1,0,0,0,0,1,0,0,-bone,0,1);
    const inverseBindMatrices = add(new Float32Array(matrices),'MAT4',3);
    const input = add(new Float32Array([0,.5,1]),'SCALAR',3,{min:[0],max:[1]});
    const output = add(new Float32Array([0,0,0,1,0,0,Math.sin(.3),Math.cos(.3),0,0,0,1]),'VEC4',3);
    return JSON.stringify({asset:{version:'2.0',generator:'CocosMcp minimal native acceptance fixture'},scene:0,scenes:[{nodes:[0]}],
      nodes:[{name:'BatchFixture',children:[1,4,5]},{name:'Root',children:[2]},{name:'Middle',translation:[0,1,0],children:[3]},
        {name:'End',translation:[0,1,0]},{name:'SkinA',mesh:0,skin:0},{name:'SkinB',mesh:1,skin:0}],
      meshes:[positions,positionsB].map((position,index)=>({name:`Skin${index}`,primitives:[{attributes:{POSITION:position,NORMAL:normals,TEXCOORD_0:uv,JOINTS_0:joints,WEIGHTS_0:weights},indices,material:0}]})),
      skins:[{name:'SharedSkeleton',inverseBindMatrices,skeleton:1,joints:[1,2,3]}],
      materials:[{name:'SharedMaterial',pbrMetallicRoughness:{baseColorFactor:[.2,.7,1,1],metallicFactor:0,roughnessFactor:1},doubleSided:true}],
      animations:[{name:'JointSwing',samplers:[{input,output,interpolation:'LINEAR'}],channels:[{sampler:0,target:{node:2,path:'rotation'}}]}],
      accessors,bufferViews:views,buffers:[{byteLength:length,uri:`data:application/octet-stream;base64,${Buffer.concat(chunks).toString('base64')}`}]});
  }
}
