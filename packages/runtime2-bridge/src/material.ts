import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';

interface Binding { component: RuntimeObject; slot: number; original: RuntimeObject; current: RuntimeObject }
export class Creator2Material {
  private readonly owned = new Map<string, Binding>();
  constructor(private readonly inspector: SceneInspector) {}
  async load(uuid: string): Promise<RuntimeObject> {
    return A.object(await new Promise((accept, reject) => A.call(this.inspector.environment.cc.assetManager, 'loadAny', uuid, (error: unknown, asset: unknown) => error ? reject(error) : accept(asset))));
  }
  describe(material: RuntimeObject): JsonObject {
    const effect = A.object(material.effect), passes = effect.passes as RuntimeObject[];
    return { materialUuid: A.uuid(material), effectUuid: A.uuid(material.effectAsset), technique: Number(material.techniqueIndex), rows: passes.map((pass, index) => ({ passIndex: index, properties: A.safeData(pass._properties), defines: A.safeData(pass._defines), states: { cullMode: A.safeData(pass._cullMode), depthTest: A.safeData(pass._depthTest), depthWrite: A.safeData(pass._depthWrite), blend: A.safeData(pass._blend) } })) };
  }
  private async value(value: JsonValue): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map(value => this.value(value)));
    if (value && typeof value === 'object') {
      if (value.type === 'texture') return this.load(Json.string(value.uuid, 'texture uuid'));
      const types: Record<string, string> = { color: 'Color', vec2: 'Vec2', vec3: 'Vec3', vec4: 'Vec4' };
      if (!types[String(value.type)] || !Array.isArray(value.value)) throw new CocosError('INVALID_ARGUMENT', 'Use an explicit color/vec2/vec3/vec4/texture material value');
      return A.construct(this.inspector.environment.cc[types[String(value.type)]!], value.value);
    }
    return value;
  }
  async patch(material: RuntimeObject, p: JsonObject): Promise<void> {
    if (p.states && Object.keys(Json.object(p.states)).length) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Creator 2 pipeline state authoring requires version-specific state schema');
    const index = Number(p.passIndex ?? 0), passes = A.object(material.effect).passes as RuntimeObject[];
    if (!Number.isInteger(index) || !passes[index]) throw new CocosError('INVALID_ARGUMENT', 'Invalid pass index');
    const pass = passes[index]!;
    for (const [name, value] of Object.entries(Json.object(p.properties ?? {}))) {
      if (!(name in A.object(pass._properties))) throw new CocosError('INVALID_ARGUMENT', `Unknown material property ${name}`);
      A.call(material, 'setProperty', name, await this.value(value), index);
    }
    for (const [name, value] of Object.entries(Json.object(p.defines ?? {}))) {
      if (!(name in A.object(pass._defines))) throw new CocosError('INVALID_ARGUMENT', `Unknown material define ${name}`);
      if (typeof value !== typeof A.object(pass._defines)[name]) throw new CocosError('INVALID_ARGUMENT', `Invalid define type ${name}`);
      A.call(material, 'define', name, value, index);
    }
  }
  async serialized(p: JsonObject, serialize: (value: unknown) => unknown): Promise<JsonValue> {
    const source = p.sourceUuid ? await this.load(Json.string(p.sourceUuid, 'sourceUuid')) : undefined;
    if (source && this.inspector.type(source) !== 'cc.Material') throw new CocosError('INVALID_ARGUMENT', 'Expected source Material');
    const effect = p.effectUuid ? await this.load(Json.string(p.effectUuid, 'effectUuid')) : source ? A.object(source.effectAsset) : null;
    if (!effect || this.inspector.type(effect) !== 'cc.EffectAsset') throw new CocosError('INVALID_ARGUMENT', 'Expected EffectAsset');
    const material = A.object(A.call(this.inspector.environment.cc.Material, 'create', effect, Number(p.technique ?? source?.techniqueIndex ?? 0)));
    try {
      if (source) {
        const passes = A.object(source.effect).passes as RuntimeObject[], targets = A.object(material.effect).passes as RuntimeObject[];
        for (const [index,pass] of passes.entries()) {
          if (!targets[index]) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Effect migration would discard a pass');
          for (const [name,uniform] of Object.entries(A.object(pass._properties))) {
            if (!(name in A.object(targets[index]!._properties))) throw new CocosError('UNSUPPORTED_CAPABILITY', `Effect migration would discard property ${name}`);
            A.object(targets[index]!._properties)[name] = { ...A.object(uniform) };
          }
          for (const [name,value] of Object.entries(A.object(pass._defines))) {
            if (!(name in A.object(targets[index]!._defines))) throw new CocosError('UNSUPPORTED_CAPABILITY', `Effect migration would discard define ${name}`);
            A.call(material,'define',name,value,index);
          }
        }
      }
      await this.patch(material, p); const data = serialize(material); return typeof data === 'string' ? JSON.parse(data) as JsonValue : Json.value(data);
    } finally { A.call(material, 'destroy'); }
  }
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    if (A.engineVersion(this.inspector.environment.cc) !== '2.4.15') throw new CocosError('UNSUPPORTED_VERSION', 'Material adapter requires Creator 2.4.15');
    const component = this.inspector.component(Json.string(p.componentId, 'componentId')), slot = Number(p.slot ?? 0);
    if (!Number.isInteger(slot) || slot < 0 || !Array.isArray(component.materials) || slot >= component.materials.length) throw new CocosError('INVALID_ARGUMENT', 'Invalid renderer material slot');
    const material = A.object((component.materials as unknown[])[slot]), key = `${A.uuid(component)}:${slot}`;
    if (id === 'runtime.material.inspect') return this.describe(material);
    const owned = this.owned.get(key);
    if (owned && owned.current !== material) throw new CocosError('STALE_REVISION', 'Material binding changed outside this tool');
    if (id === 'runtime.material.reset') {
      if (!owned) return { restored: false };
      A.call(component, 'setMaterial', slot, owned.original); this.owned.delete(key); A.call(owned.current, 'destroy'); return { restored: true };
    }
    const before = this.describe(material);
    const copy = A.construct(this.inspector.environment.cc.MaterialVariant, [owned?.original ?? material]);
    try {
      const passes = A.object(material.effect).passes as RuntimeObject[];
      for (const [index, pass] of passes.entries()) {
        // getProperty 的纹理值是 gfx.Texture，不能再次传入要求 cc.Texture2D 的 setProperty。
        // 仅复制已存在的原生 uniform 记录，修改仍经过下面 patch 的类型和名称检查。
        const targetPass = (A.object(copy.effect).passes as RuntimeObject[])[index]!;
        for (const [name, uniform] of Object.entries(A.object(pass._properties))) {
          const record = A.object(uniform), value = record.value;
          A.object(targetPass._properties)[name] = { ...record, value: ArrayBuffer.isView(value) && 'slice' in value ? (value as Float32Array).slice() : Array.isArray(value) ? value.slice() : value };
        }
        for (const name of Object.keys(A.object(pass._defines))) A.call(copy, 'define', name, A.call(material, 'getDefine', name, index), index);
      }
      await this.patch(copy, p); A.call(component, 'setMaterial', slot, copy);
      // setMaterial may install a renderer-owned variant. Read the actual instance before tracking cleanup.
      const current = A.object((component.materials as unknown[])[slot]);
      if (current !== copy) throw new CocosError('VERIFICATION_FAILED', 'Renderer replaced the owned variant');
      this.owned.set(key, { component, slot, original: owned?.original ?? material, current: copy });
      if (owned) A.call(owned.current, 'destroy');
      return { before, after: this.describe(copy), gpuValidated: false };
    } catch (error) { if ((component.materials as unknown[])[slot] === copy) A.call(component, 'setMaterial', slot, material); A.call(copy, 'destroy'); throw error; }
  }
  dispose(): void {
    for (const [key, row] of this.owned) {
      if (row.component.isValid !== false && (row.component.materials as unknown[])[row.slot] === row.current) A.call(row.component, 'setMaterial', row.slot, row.original);
      A.call(row.current, 'destroy'); this.owned.delete(key);
    }
  }
}
