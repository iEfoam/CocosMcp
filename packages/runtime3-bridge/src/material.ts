import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { MaterialValues, ShaderVariants } from '../../shader-core/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import { SceneInspector, type SceneEnvironment } from './scene.js';

interface OwnedMaterial { component: RuntimeObject; slot: number; original: RuntimeObject; current: RuntimeObject }

export class MaterialController {
  private readonly inspector: SceneInspector;
  private readonly owned = new Map<string, OwnedMaterial>();
  constructor(private readonly environment: SceneEnvironment) { this.inspector = new SceneInspector(environment); }
  async load(uuid: string, type: string): Promise<RuntimeObject> {
    const asset = await new Promise<unknown>((accept, reject) => A.call(this.environment.cc.assetManager, 'loadAny', uuid,
      (error: Error | null, result: unknown) => error ? reject(error) : accept(result)));
    const expected = this.environment.cc[type];
    if (typeof expected !== 'function' || !(asset instanceof expected)) throw new CocosError('INVALID_ARGUMENT', `Expected ${type} asset`);
    return A.object(asset);
  }
  private slot(p: JsonObject): { component: RuntimeObject; slot: number; material: RuntimeObject } {
    const component = this.inspector.component(Json.string(p.componentId, 'componentId')); const slot = Number(p.slot ?? 0);
    if (!Number.isInteger(slot) || slot < 0) throw new CocosError('INVALID_ARGUMENT', 'Invalid material slot');
    if (typeof component.getRenderMaterial !== 'function' || typeof component.setMaterialInstance !== 'function') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Component does not expose material slots');
    const material = A.call(component, 'getRenderMaterial', slot);
    if (!material) throw new CocosError('NOT_FOUND', 'Material slot is empty or out of range');
    return { component, slot, material: A.object(material) };
  }
  binding(p: JsonObject): JsonObject {
    const component = this.inspector.component(Json.string(p.componentId, 'componentId'));
    const slot = Number(p.slot ?? 0); const node = A.object(component.node);
    const index = (Array.isArray(node._components) ? node._components : this.inspector.components(node)).indexOf(component);
    const ui = 'customMaterial' in component;
    if (ui && slot !== 0) throw new CocosError('INVALID_ARGUMENT', 'UI renderer only supports custom material slot 0');
    const materials = component.sharedMaterials;
    if (!ui && (!Array.isArray(materials) || slot < 0 || slot >= materials.length)) throw new CocosError('INVALID_ARGUMENT', 'Material slot out of range');
    const material = ui ? component.customMaterial : (materials as unknown[])[slot];
    const componentPath = ui ? 'customMaterial' : `sharedMaterials.${slot}`;
    return { nodeId: A.uuid(node), componentId: A.uuid(component), slot, materialUuid: material ? A.uuid(material) : '',
      componentPath, path: `__comps__.${index}.${componentPath}` };
  }
  bindings(uuid: string): JsonObject[] {
    const rows: JsonObject[] = [];
    for (const node of this.inspector.all()) for (const component of this.inspector.components(node)) {
      if ('customMaterial' in component) {
        if (component.customMaterial && A.uuid(component.customMaterial) === uuid) rows.push(this.binding({ componentId: A.uuid(component) }));
      } else if (Array.isArray(component.sharedMaterials)) component.sharedMaterials.forEach((material, slot) => {
        if (material && A.uuid(material) === uuid) rows.push(this.binding({ componentId: A.uuid(component), slot }));
      });
    }
    return rows;
  }
  private passes(material: RuntimeObject): RuntimeObject[] { return material.passes as RuntimeObject[] ?? []; }
  private stateData(value: unknown, depth = 0): JsonValue {
    if (depth > 6) throw new CocosError('INVALID_ARGUMENT', 'Pipeline state nesting exceeds inspection limit');
    if (value === null || value === undefined || typeof value !== 'object') return A.safeData(value);
    if (Array.isArray(value)) return value.map(entry => this.stateData(entry, depth + 1));
    const rows: JsonObject = {};
    // 原生 gfx 状态可能通过 getter 暴露；仅在明确的状态对象上读取，不能套用到任意工程对象。
    for (const key of A.propertyNames(value)) {
      if (key === 'native') continue;
      const entry = A.object(value)[key];
      if (typeof entry !== 'function') rows[key] = this.stateData(entry, depth + 1);
    }
    return rows;
  }
  private passStates(pass: RuntimeObject): JsonObject {
    return { blendState: this.stateData(pass.blendState), depthStencilState: this.stateData(pass.depthStencilState), rasterizerState: this.stateData(pass.rasterizerState) };
  }
  describe(material: RuntimeObject): JsonObject {
    return { materialUuid: A.uuid(material), effectUuid: material.effectAsset ? A.uuid(material.effectAsset) : null, technique: Number(material.technique ?? 0),
      rows: this.passes(material).map((pass, index) => ({ pass: index, properties: A.safeData(pass.properties), defines: A.safeData(pass.defines),
        states: this.passStates(pass),
        overrides: Object.keys(A.object(pass.properties ?? {})).map(name => ({ name, value: this.encode(A.call(material, 'getProperty', name, index)) })) })) };
  }
  private encode(value: unknown): JsonValue {
    if (value && typeof value === 'object') {
      const object = A.object(value);
      if (object.uuid) return { type: 'texture', uuid: String(object.uuid) };
      for (const [type, count] of [['mat4', 16], ['mat3', 9]] as const) {
        const keys = Array.from({ length: count }, (_, index) => `m${String(index).padStart(2, '0')}`);
        if (keys.every(key => typeof object[key] === 'number')) return { type, value: keys.map(key => Number(object[key])) };
      }
      for (const [type, keys] of [['color', ['r', 'g', 'b', 'a']], ['vec4', ['x', 'y', 'z', 'w']], ['vec3', ['x', 'y', 'z']], ['vec2', ['x', 'y']]] as const) {
        if (keys.every(key => typeof object[key] === 'number')) return { type, value: keys.map(key => Number(object[key])) };
      }
      if (Array.isArray(value)) return value.map(entry => this.encode(entry));
    }
    return A.safeData(value);
  }
  private async decode(value: JsonValue): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map(entry => this.decode(entry)));
    if (value && typeof value === 'object') {
      if (value.type === 'texture') return this.load(Json.string(value.uuid, 'texture UUID'), 'TextureBase');
      const names: Record<string, string> = { color: 'Color', vec2: 'Vec2', vec3: 'Vec3', vec4: 'Vec4', mat3: 'Mat3', mat4: 'Mat4' };
      return A.construct(this.environment.cc[names[String(value.type)]!], value.value as JsonValue[]);
    }
    return value;
  }
  private validateDefines(material: RuntimeObject, defines: JsonObject): void {
    const allowed = new Map<string, RuntimeObject>();
    for (const shader of A.object(material.effectAsset).shaders as RuntimeObject[] ?? []) for (const macro of shader.defines as RuntimeObject[] ?? []) allowed.set(String(macro.name), macro);
    for (const [name, value] of Object.entries(defines)) {
      const macro = allowed.get(name);
      if (!macro) throw new CocosError('INVALID_ARGUMENT', `Unknown shader macro: ${name}`);
      if (macro.type && typeof value !== macro.type) throw new CocosError('INVALID_ARGUMENT', `Invalid macro type: ${name}`);
      if (Array.isArray(macro.range) && (typeof value !== 'number' || value < Number(macro.range[0]) || value > Number(macro.range[1]))) throw new CocosError('INVALID_ARGUMENT', `Macro out of range: ${name}`);
      if (Array.isArray(macro.options) && !macro.options.includes(value)) throw new CocosError('INVALID_ARGUMENT', `Invalid macro option: ${name}`);
    }
  }
  async properties(material: RuntimeObject, properties: JsonObject, passIndex?: number): Promise<void> {
    if (passIndex !== undefined && (!Number.isInteger(passIndex) || !this.passes(material)[passIndex])) throw new CocosError('INVALID_ARGUMENT', 'Pass index out of range');
    const declared: JsonObject = {};
    for (const pass of this.passes(material)) Object.assign(declared, A.safeData(pass.properties));
    new MaterialValues().validate(properties, declared);
    // 先转换所有资源引用再写入，防止异步纹理加载失败留下半套参数。
    const decoded = await Promise.all(Object.entries(properties).map(async ([name, value]) => ({ name, value: await this.decode(value) })));
    for (const row of decoded) {
      const passes = this.passes(material).map((pass, index) => ({ pass, index })).filter(({ pass, index }) => (passIndex === undefined || passIndex === index) && row.name in A.object(pass.properties ?? {}));
      if (!passes.length) throw new CocosError('INVALID_ARGUMENT', `Property not declared on selected Pass: ${row.name}`);
      for (const { pass, index } of passes) {
        const handle = A.call(pass, 'getHandle', row.name);
        if (!handle) throw new CocosError('INVALID_ARGUMENT', `Property is inactive for this variant: ${row.name}`);
        const shader = A.object(pass.shaderInfo ?? {});
        const uniforms = (shader.blocks as RuntimeObject[] ?? []).flatMap(block => block.members as RuntimeObject[] ?? []);
        const declaration = uniforms.find(uniform => uniform.name === row.name);
        if (declaration) {
          const types = A.object(A.object(this.environment.cc.gfx).Type);
          const encoded = this.encode(row.value);
          const expected: Record<string, unknown[]> = { number: [types.FLOAT, types.INT, types.UINT], boolean: [types.BOOL],
            vec2: [types.FLOAT2, types.INT2, types.UINT2, types.BOOL2], vec3: [types.FLOAT3, types.INT3, types.UINT3, types.BOOL3],
            vec4: [types.FLOAT4, types.INT4, types.UINT4, types.BOOL4], color: [types.FLOAT4], mat3: [types.MAT3], mat4: [types.MAT4] };
          const values = Array.isArray(encoded) ? encoded : [encoded];
          for (const value of values) {
            const kind = value && typeof value === 'object' && !Array.isArray(value) ? String(value.type) : typeof value;
            if (!expected[kind]?.includes(declaration.type)) throw new CocosError('INVALID_ARGUMENT', `Property type does not match shader uniform: ${row.name}`);
          }
          if (Number(declaration.count ?? 1) > 1 && (!Array.isArray(encoded) || encoded.length !== Number(declaration.count))) throw new CocosError('INVALID_ARGUMENT', `Uniform array length mismatch: ${row.name}`);
        }
        A.call(material, 'setProperty', row.name, row.value, index);
        if (Json.canonical(this.encode(A.call(material, 'getProperty', row.name, index))) !== Json.canonical(this.encode(row.value))) throw new CocosError('VERIFICATION_FAILED', `Material property readback differs: ${row.name}`);
      }
    }
  }
  private states(states: JsonObject, material?: RuntimeObject): void {
    const allowed = new Set(['rasterizerState', 'depthStencilState', 'blendState', 'dynamicStates', 'priority', 'stage', 'phase']);
    for (const key of Object.keys(states)) if (!allowed.has(key)) throw new CocosError('INVALID_ARGUMENT', `Unknown pipeline state: ${key}`);
    const pass = material ? this.passes(material)[0] : undefined;
    for (const key of ['blendState', 'depthStencilState', 'rasterizerState']) if (states[key] !== undefined && pass) this.stateFields(states[key]!, pass[key], key);
  }
  private stateFields(value: JsonValue, shape: unknown, path: string): void {
    if (Array.isArray(value)) {
      if (!Array.isArray(shape) || !shape.length || value.length > 8) throw new CocosError('INVALID_ARGUMENT', `Invalid state array: ${path}`);
      value.forEach((entry, index) => this.stateFields(entry, shape[index] ?? shape[0], `${path}.${index}`)); return;
    }
    if (value && typeof value === 'object') {
      if (!shape || typeof shape !== 'object') throw new CocosError('INVALID_ARGUMENT', `Invalid state object: ${path}`);
      for (const [key, entry] of Object.entries(value)) {
        Json.safePath(key);
        if (!(key in shape)) throw new CocosError('INVALID_ARGUMENT', `Unknown pipeline state: ${path}.${key}`);
        this.stateFields(entry, A.object(shape)[key], `${path}.${key}`);
      }
      return;
    }
    if (typeof value !== typeof shape || (typeof value === 'number' && !Number.isFinite(value))) throw new CocosError('INVALID_ARGUMENT', `Invalid pipeline state value: ${path}`);
  }
  async instance(parent: RuntimeObject, p: JsonObject): Promise<RuntimeObject> {
    const passIndex = p.passIndex === undefined ? undefined : Number(p.passIndex);
    if (passIndex !== undefined && (!Number.isInteger(passIndex) || !this.passes(parent)[passIndex])) throw new CocosError('INVALID_ARGUMENT', 'Pass index out of range');
    const defines = Json.object(p.defines ?? {}); this.validateDefines(parent, defines);
    const states = Json.object(p.states ?? {}); this.states(states, parent);
    let base = parent;
    while (base.parent) base = A.object(base.parent);
    // Creator 3.8.8 将 MaterialInstance 导出在 renderer 命名空间，运行时 cc 顶层并不包含该类型。
    const instanceType = A.object(this.environment.cc.renderer ?? {}).MaterialInstance ?? this.environment.cc.MaterialInstance;
    const instance = A.construct(instanceType, [{ parent: base }]);
    try {
      // 连续调参不能把上一个临时实例作为父对象，否则释放旧实例后新 Pass 会引用失效资源。
      A.call(instance, 'copy', parent);
      for (const [index, pass] of this.passes(parent).entries()) {
        if (pass.defines) A.call(instance, 'recompileShaders', pass.defines, index);
        if (pass.blendState && pass.depthStencilState && pass.rasterizerState) A.call(instance, 'overridePipelineStates', this.passStates(pass), index);
      }
      if (Object.keys(defines).length) A.call(instance, 'recompileShaders', defines, passIndex);
      if (Object.keys(states).length) A.call(instance, 'overridePipelineStates', states, passIndex);
      await this.properties(instance, Json.object(p.properties ?? {}), passIndex); return instance;
    } catch (error) { A.call(instance, 'destroy'); throw error; }
  }
  compile(material: RuntimeObject): JsonObject {
    const rows = this.passes(material).map((pass, index) => ({ pass: index, status: A.call(pass, 'tryCompile') === true ? 'passed' : 'failed', defines: A.safeData(pass.defines) }));
    // tryCompile 返回引擎程序创建结果；驱动日志、实际绘制和设备验收仍是独立证据。
    return { rows, status: rows.length && rows.every(row => row.status === 'passed') ? 'passed' : 'failed', stage: 'engine-program', gpuDriverDiagnostics: 'unavailable', drawValidation: 'not-run' };
  }
  async serialized(p: JsonObject): Promise<JsonObject> {
    if (!this.environment.serialize) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Editor serializer unavailable');
    let previous: RuntimeObject | undefined;
    const material = A.construct(this.environment.cc.Material, []);
    try {
      if (p.serialized) {
        const deserialize = this.environment.cc.deserialize;
        const details = A.construct(A.object(deserialize).Details, []);
        previous = A.object(Reflect.apply(deserialize as (...args: unknown[]) => unknown, null, [p.serialized, details]));
        const uuids = details.uuidList as string[] ?? []; const objects = details.uuidObjList as RuntimeObject[]; const properties = details.uuidPropList as string[];
        for (let index = 0; index < uuids.length; index++) {
          const asset = await new Promise<unknown>((accept, reject) => A.call(this.environment.cc.assetManager, 'loadAny', uuids[index], (error: Error | null, value: unknown) => error ? reject(error) : accept(value)));
          objects[index]![properties[index]!] = asset;
        }
        A.call(previous, 'onLoaded');
        A.call(material, 'copy', previous);
      }
      if (p.action === 'inspect') return this.describe(material);
      const effect = p.effectUuid ? await this.load(Json.string(p.effectUuid, 'effect UUID'), 'EffectAsset') : material.effectAsset;
      if (!effect) throw new CocosError('INVALID_ARGUMENT', 'Material requires an Effect');
      const technique = Number(p.technique ?? material.technique ?? 0);
      if (!Array.isArray(A.object(effect).techniques) || !(A.object(effect).techniques as unknown[])[technique]) throw new CocosError('INVALID_ARGUMENT', 'Technique index out of range');
      const before = this.describe(material); const migration: JsonObject[] = [];
      if (p.effectUuid && previous) {
        // 切换 Effect 从新材质开始；仅迁移仍存在且能通过类型验证的显式参数。
        A.call(material, 'reset', { effectAsset: effect, technique });
        this.validateDefines(material, Json.object(p.defines ?? {})); this.states(Json.object(p.states ?? {}), material);
        A.call(material, 'reset', { effectAsset: effect, technique, defines: p.defines ?? {}, states: p.states ?? {} });
        const declared = Object.assign({}, ...this.passes(material).map(pass => pass.properties));
        for (const row of before.rows as JsonObject[]) for (const property of row.overrides as JsonObject[]) {
          if (property.value === null) continue;
          const name = String(property.name);
          if (!(name in declared)) { migration.push({ name, status: 'removed' }); continue; }
          try { await this.properties(material, { [name]: property.value! }, Number(row.pass)); migration.push({ name, pass: row.pass!, status: 'retained' }); }
          catch (error) { migration.push({ name, status: 'incompatible', reason: CocosError.from(error).message }); }
        }
      } else {
        if (!previous) A.call(material, 'initialize', { effectAsset: effect, technique });
        this.validateDefines(material, Json.object(p.defines ?? {})); this.states(Json.object(p.states ?? {}), material);
        // copy(overrides) 保留未修改的各 Pass 参数、宏和状态。
        const copy = A.construct(this.environment.cc.Material, []);
        const passIndex = p.passIndex === undefined ? undefined : Number(p.passIndex);
        if (passIndex !== undefined && (!Number.isInteger(passIndex) || !this.passes(material)[passIndex])) throw new CocosError('INVALID_ARGUMENT', 'Pass index out of range');
        const patch = (value: JsonValue): JsonValue => passIndex === undefined ? value : this.passes(material).map((_pass, index) => index === passIndex ? value : {});
        try { A.call(copy, 'copy', material, { technique, defines: patch(p.defines ?? {}), states: patch(p.states ?? {}) }); A.call(material, 'copy', copy); }
        finally { A.call(copy, 'destroy'); }
      }
      await this.properties(material, Json.object(p.properties ?? {}), p.passIndex === undefined ? undefined : Number(p.passIndex));
      const serialized = this.environment.serialize(material);
      return { serialized: Json.value(typeof serialized === 'string' ? JSON.parse(serialized) : serialized), migration, material: this.describe(material) };
    } finally { A.call(material, 'destroy'); if (previous) A.call(previous, 'destroy'); }
  }
  async execute(id: string, p: JsonObject): Promise<JsonObject> {
    if (this.environment.major !== 3) throw new CocosError('UNSUPPORTED_VERSION', 'Shader material operations require Creator 3');
    const { component, slot, material } = this.slot(p); const key = `${A.uuid(component)}:${slot}`;
    if (id === 'runtime.material.inspect') return { ...this.describe(material), componentId: A.uuid(component), slot, toolOwned: this.owned.has(key) };
    if (id === 'runtime.material.compile') return this.compile(material);
    if (id === 'runtime.shader.variants.compile') {
      const plan = new ShaderVariants().plan(Json.object(p.axes), Number(p.limit ?? 64)); const rows: JsonObject[] = [];
      for (const defines of plan.rows as JsonObject[]) {
        const instance = await this.instance(material, { defines });
        try { rows.push({ defines, compilation: this.compile(instance) }); } finally { A.call(instance, 'destroy'); }
      }
      return { rows, total: rows.length };
    }
    const owned = this.owned.get(key);
    if (owned && owned.current !== material) throw new CocosError('OPERATION_CONFLICT', 'Material binding changed outside this tool');
    if (id === 'runtime.material.reset') {
      if (!owned) throw new CocosError('NOT_FOUND', 'No tool-owned override to reset');
      this.restore(owned);
      this.owned.delete(key); return { restored: true };
    }
    const instance = await this.instance(material, p);
    try {
      const compilation = this.compile(instance);
      if (compilation.status !== 'passed') throw new CocosError('VERIFICATION_FAILED', 'Candidate material did not compile', compilation);
      A.call(component, 'setMaterialInstance', instance, slot);
      if (A.call(component, 'getRenderMaterial', slot) !== instance) throw new CocosError('VERIFICATION_FAILED', 'Material instance binding failed');
    } catch (error) {
      if (A.call(component, 'getRenderMaterial', slot) === instance) this.restore({ component, slot, original: material, current: instance });
      else A.call(instance, 'destroy');
      throw error;
    }
    this.owned.set(key, { component, slot, original: owned?.original ?? material, current: instance });
    if (owned) A.call(owned.current, 'destroy');
    return this.describe(instance);
  }
  dispose(): void {
    for (const row of this.owned.values()) {
      if (row.component.isValid !== false && A.call(row.component, 'getRenderMaterial', row.slot) === row.current) this.restore(row);
      else if (row.current.isValid !== false) A.call(row.current, 'destroy');
    }
    this.owned.clear();
  }
  private restore(row: OwnedMaterial): void {
    if (row.original.parent) { A.call(row.component, 'setMaterialInstance', row.original, row.slot); A.call(row.current, 'destroy'); }
    // setMaterialInstance(shared) 在共享引用相同时会提前返回，必须 forceUpdate 才会真正清除实例。
    else A.call(row.component, 'setSharedMaterial', row.original, row.slot, true);
    if (A.call(row.component, 'getRenderMaterial', row.slot) !== row.original) throw new CocosError('VERIFICATION_FAILED', 'Original material was not restored');
  }
}
