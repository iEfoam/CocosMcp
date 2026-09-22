import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { ProjectPaths } from '../../application/src/paths.js';
import { PropertyDump } from './dump.js';
import type { EditorPort } from './port.js';

type Run = (id: string, params: JsonObject) => Promise<JsonValue>;
type Vector = [number, number, number];

/** 参数化网格使用 GLTF 文本资源持久化；不依赖运行时临时 Mesh 或硬编码内置 UUID。 */
export class PrimitiveGeometry {
  private positions: number[] = [];
  private normals: number[] = [];
  private uvs: number[] = [];
  private indices: number[] = [];

  private number(p: JsonObject, key: string, fallback: number, min: number, max: number): number {
    const value = p[key] === undefined ? fallback : Number(p[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw new CocosError('INVALID_ARGUMENT', `Invalid geometry parameter: ${key}`);
    return value;
  }

  private vertex(position: Vector, normal: Vector, uv: [number, number] = [0, 0]): void {
    const length = Math.hypot(...normal);
    if (!length) throw new CocosError('INVALID_ARGUMENT', 'Geometry generated a zero normal');
    this.positions.push(...position); this.normals.push(...normal.map(n => n / length)); this.uvs.push(...uv);
  }

  private grid(columns: number, rows: number, base = 0, reversed = false): void {
    for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
      const a = base + j * (columns + 1) + i, b = a + columns + 1;
      this.indices.push(...(reversed ? [a, b, a + 1, a + 1, b, b + 1] : [a, a + 1, b, a + 1, b + 1, b]));
    }
  }

  build(shape: string, p: JsonObject): { content: string; vertices: number; triangles: number } {
    this.positions = []; this.normals = []; this.indices = []; this.uvs = [];
    const fields: Record<string, string[]> = { cube: ['size', 'bevel'], sphere: ['radius', 'segments'], cylinder: ['radius', 'height', 'segments'], torus: ['radius', 'tubeRadius', 'tubeHeight', 'segments'] };
    if (!fields[shape] || Object.keys(p).some(key => !fields[shape]!.includes(key))) throw new CocosError('INVALID_ARGUMENT', 'Unsupported primitive shape or shape-specific parameter');
    const segments = this.number(p, 'segments', 48, 8, 128);
    if (!Number.isInteger(segments)) throw new CocosError('INVALID_ARGUMENT', 'Segments must be an integer');
    if (shape === 'cube') {
      const size = Json.object(p.size ?? { x: 1, y: 1, z: 1 });
      const half: Vector = ['x', 'y', 'z'].map(key => this.number(size, key, 1, 0.001, 10000) / 2) as Vector;
      const bevel = this.number(p, 'bevel', 0, 0, Math.min(...half) * 0.99);
      // 按实际尺寸烘焙圆角，避免非均匀 node.scale 把三轴倒角拉成不同宽度。
      for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
        const a = (axis + 1) % 3, b = (axis + 2) % 3;
        const points = (h: number): number[] => bevel ? [-h, -h + bevel * 0.15, -h + bevel * 0.5, -h + bevel, h - bevel, h - bevel * 0.5, h - bevel * 0.15, h] : [-h, h];
        const us = points(half[a]!), vs = points(half[b]!), base = this.positions.length / 3;
        for (const v of vs) for (const u of us) {
          const source: Vector = [0, 0, 0]; source[axis] = sign * half[axis]!; source[a] = u; source[b] = v;
          const inner = source.map((v, i) => Math.max(-half[i]! + bevel, Math.min(half[i]! - bevel, v))) as Vector;
          const normal = source.map((v, i) => v - inner[i]!) as Vector;
          const uv: [number, number] = [u / (half[a]! * 2) + 0.5, v / (half[b]! * 2) + 0.5];
          if (bevel) { const length = Math.hypot(...normal); this.vertex(inner.map((v, i) => v + normal[i]! / length * bevel) as Vector, normal, uv); }
          else { normal[axis] = sign; this.vertex(source, normal, uv); }
        }
        this.grid(us.length - 1, vs.length - 1, base, sign < 0);
      }
    } else if (shape === 'torus') {
      const radius = this.number(p, 'radius', 1, 0.001, 10000), tube = this.number(p, 'tubeRadius', 0.05, 0.0001, radius * 0.99);
      const thickness = this.number(p, 'tubeHeight', tube, 0.0001, radius), minor = 16;
      for (let j = 0; j <= segments; j++) for (let i = 0; i <= minor; i++) {
        const u = j / segments * Math.PI * 2, w = i / minor * Math.PI * 2, r = radius + tube * Math.cos(w);
        this.vertex([r * Math.cos(u), thickness * Math.sin(w), r * Math.sin(u)], [Math.cos(w) * Math.cos(u) / tube, Math.sin(w) / thickness, Math.cos(w) * Math.sin(u) / tube], [j / segments, i / minor]);
      }
      this.grid(minor, segments);
    } else if (shape === 'sphere') {
      const radius = this.number(p, 'radius', 0.5, 0.001, 10000), latitudes = Math.ceil(segments / 2);
      for (let j = 0; j <= latitudes; j++) for (let i = 0; i <= segments; i++) {
        const u = i / segments * Math.PI * 2, w = j / latitudes * Math.PI;
        const normal: Vector = [Math.sin(w) * Math.cos(u), Math.cos(w), Math.sin(w) * Math.sin(u)];
        this.vertex(normal.map(n => n * radius) as Vector, normal, [i / segments, j / latitudes]);
      }
      this.grid(segments, latitudes);
    } else if (shape === 'cylinder') {
      const radius = this.number(p, 'radius', 0.5, 0.001, 10000), height = this.number(p, 'height', 1, 0.001, 10000);
      for (let j = 0; j <= 1; j++) for (let i = 0; i <= segments; i++) {
        const u = i / segments * Math.PI * 2;
        this.vertex([radius * Math.cos(u), (0.5 - j) * height, radius * Math.sin(u)], [Math.cos(u), 0, Math.sin(u)], [i / segments, j]);
      }
      this.grid(segments, 1);
      for (const sign of [-1, 1]) {
        const center = this.positions.length / 3; this.vertex([0, sign * height / 2, 0], [0, sign, 0], [0.5, 0.5]);
        for (let i = 0; i <= segments; i++) { const u = i / segments * Math.PI * 2; this.vertex([radius * Math.cos(u), sign * height / 2, radius * Math.sin(u)], [0, sign, 0], [Math.cos(u) / 2 + 0.5, Math.sin(u) / 2 + 0.5]); }
        for (let i = 0; i < segments; i++) this.indices.push(...(sign > 0 ? [center, center + i + 2, center + i + 1] : [center, center + i + 1, center + i + 2]));
      }
    } else throw new CocosError('INVALID_ARGUMENT', `Unknown primitive shape: ${shape}`);
    return { content: this.gltf(shape), vertices: this.positions.length / 3, triangles: this.indices.length / 3 };
  }

  private gltf(name: string): string {
    const positions = Buffer.from(new Float32Array(this.positions).buffer), normals = Buffer.from(new Float32Array(this.normals).buffer), indices = Buffer.from(new Uint16Array(this.indices).buffer);
    const uvs = Buffer.from(new Float32Array(this.uvs).buffer);
    const buffer = Buffer.concat([positions, normals, uvs, indices]);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    this.positions.forEach((value, i) => { min[i % 3] = Math.min(min[i % 3]!, value); max[i % 3] = Math.max(max[i % 3]!, value); });
    return JSON.stringify({ asset: { version: '2.0', generator: 'CocosMCP PrimitiveGeometry' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0 }],
      meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, mode: 4 }] }],
      buffers: [{ byteLength: buffer.length, uri: `data:application/octet-stream;base64,${buffer.toString('base64')}` }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }, { buffer: 0, byteOffset: positions.length, byteLength: normals.length }, { buffer: 0, byteOffset: positions.length + normals.length, byteLength: uvs.length }, { buffer: 0, byteOffset: positions.length + normals.length + uvs.length, byteLength: indices.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: this.positions.length / 3, type: 'VEC3', min, max },
        { bufferView: 1, componentType: 5126, count: this.normals.length / 3, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: this.uvs.length / 2, type: 'VEC2' }, { bufferView: 3, componentType: 5123, count: this.indices.length, type: 'SCALAR' }] });
  }
}

export class GeometryService {
  constructor(private readonly port: EditorPort, private readonly run: Run) {}

  async create(p: JsonObject): Promise<JsonValue> {
    const url = Json.string(p.url, 'url');
    await (await ProjectPaths.open(this.port.projectPath)).asset(url);
    if (!url.endsWith('.gltf')) throw new CocosError('INVALID_ARGUMENT', 'Geometry resource must end in .gltf');
    if (await this.port.request('asset-db', 'query-asset-info', url)) throw new CocosError('RESOURCE_BUSY', 'Geometry resource already exists');
    if (p.parentId && !await this.port.scene('nodeExists', p.parentId)) throw new CocosError('NOT_FOUND', 'Geometry parent is not in the scene');
    const material = await this.port.request('asset-db', 'query-asset-info', Json.string(p.materialUuid, 'materialUuid'));
    if (!material || Json.object(Json.value(material)).type !== 'cc.Material') throw new CocosError('INVALID_ARGUMENT', 'materialUuid must resolve to a material');
    const geometry = new PrimitiveGeometry().build(Json.string(p.shape, 'shape'), Json.object(p.options ?? {}));
    const result = Json.object(Json.value(await this.port.request('asset-db', 'create-asset', url, geometry.content)));
    let nodeId: string | null = null;
    try {
      if (result.invalid === true || !result.uuid) throw new CocosError('VERIFICATION_FAILED', 'Geometry import failed');
      const mesh = Object.values(Json.object(result.subAssets ?? {})).map(row => Json.object(row)).find(row => row.type === 'cc.Mesh' && row.invalid !== true);
      if (!mesh) throw new CocosError('VERIFICATION_FAILED', 'Geometry import did not produce a mesh');
      const created = Json.object(await this.run('node.create', { name: p.name!, ...(p.parentId ? { parentId: p.parentId } : {}) })); nodeId = Json.string(created.nodeId, 'nodeId');
      const component = Json.object(await this.run('component.add', { nodeId, type: 'cc.MeshRenderer' }));
      const componentId = (component.componentIds as string[])[0]!;
      await this.run('component.set', { componentId, properties: { mesh: { uuid: mesh.uuid! }, sharedMaterials: [{ uuid: p.materialUuid! }], shadowCastingMode: 1 } });
      const properties: JsonObject = {}; if (p.position) properties.position = p.position; if (p.rotation) properties.rotation = p.rotation;
      if (Object.keys(properties).length) await this.run('node.set', { nodeId, properties });
      return { nodeId, componentId, assetUuid: result.uuid!, meshUuid: mesh.uuid!, url, vertices: geometry.vertices, triangles: geometry.triangles, savedMesh: true, sceneSaveRequired: true };
    } catch (error) {
      // 导入资源可能已被用户引用；保留精确目标供恢复，不以全局撤销或删资源掩盖部分失败。
      throw new CocosError('EDITOR_ERROR', 'Geometry creation incomplete', { cause: CocosError.from(error).toJSON() as unknown as JsonValue, assetUrl: url, nodeId, recovery: 'Inspect these exact resources before retrying; no unrelated content was removed' });
    }
  }

  async array(p: JsonObject): Promise<JsonValue> {
    const nodeId = Json.string(p.nodeId, 'nodeId'), count = Number(p.count);
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new CocosError('INVALID_ARGUMENT', 'Array count must be 1..100 additional copies');
    const source = Json.object(await this.run('node.query', { nodeId })); const node = Json.object(PropertyDump.unwrap(source.node!));
    const base = Json.object(node.position), delta = Json.object(p.offset), rotation = Json.object(node.rotation), rotationStep = Json.object(p.rotationStep ?? { x: 0, y: 0, z: 0 });
    const patches = Array.from({ length: count }, (_, i) => {
      const position: JsonObject = {}, angles: JsonObject = {};
      for (const axis of ['x', 'y', 'z']) { position[axis] = Number(base[axis]) + Number(delta[axis]) * (i + 1); angles[axis] = Number(rotation[axis]) + Number(rotationStep[axis]) * (i + 1); }
      if (![...Object.values(position), ...Object.values(angles)].every(value => typeof value === 'number' && Number.isFinite(value))) throw new CocosError('INVALID_ARGUMENT', 'Array transforms must be finite 3D vectors');
      return { name: `${String(p.namePrefix ?? node.name)}_${i + 1}`, position, rotation: angles };
    });
    const rows: JsonObject[] = [];
    for (const properties of patches) {
      let duplicateId: string | null = null;
      try {
        const duplicate = Json.object(await this.run('node.duplicate', { nodeId }));
        if (!Array.isArray(duplicate.nodeIds) || duplicate.nodeIds.length !== 1) throw new CocosError('VERIFICATION_FAILED', 'Expected exactly one duplicated root');
        duplicateId = Json.string(duplicate.nodeIds[0], 'duplicate node ID');
        await this.run('node.set', { nodeId: duplicateId, properties }); rows.push({ nodeId: duplicateId, name: properties.name });
      } catch (error) { throw new CocosError('EDITOR_ERROR', 'Array creation incomplete', { rows, incompleteNodeId: duplicateId, cause: CocosError.from(error).message }); }
    }
    return { sourceNodeId: nodeId, rows, sceneSaveRequired: true };
  }
}
