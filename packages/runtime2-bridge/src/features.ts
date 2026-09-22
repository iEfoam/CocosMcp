import { Creator2DragonBonesFade } from './dragonbones-fade.js';
import { Creator2SpineMix } from './spine-mix.js';
import { Creator2DragonBones } from './dragonbones.js';
import { Creator2ResourceSnapshot } from './resource-snapshot.js';
import { Creator2Camera } from './camera.js';
import { Creator2Spine } from './spine.js';
import { Creator2Collision } from './collision.js';
import { Creator2Joint } from './joint.js';
import { Creator2RigidBody } from './rigid-body.js';
import { Creator2Controls } from './controls.js';
import { FrameSession } from '../../runtime3-bridge/src/frame-session.js';
import { Creator2Support } from '../../capability-catalog/src/creator2-support.js';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';

/** 2.4.15 专用原生接口；不把同名的 3.x 管理器或属性当成兼容实现。 */
export class Creator2Features {
  static readonly ids = Creator2Support.features;
  constructor(private readonly inspector: SceneInspector) {}
  private component(p: JsonObject, types: string[]): RuntimeObject {
    const component = this.inspector.component(Json.string(p.componentId, 'componentId'));
    if (!types.includes(this.inspector.type(component))) throw new CocosError('INVALID_ARGUMENT', `Expected ${types.join(' or ')}`);
    return component;
  }
  private fields(object: RuntimeObject, keys: string[]): JsonObject { return Object.fromEntries(keys.map(key => [key, typeof object[key] === 'function' ? null : A.safeData(object[key])])) as JsonObject; }
  private animation(p: JsonObject, action: string): JsonValue {
    const component = this.component(p, ['cc.Animation']);
    const clips = A.call(component, 'getClips') as RuntimeObject[];
    const state = (name: string): JsonObject => {
      const value = A.call(component, 'getAnimationState', name);
      return value ? { name, ...this.fields(A.object(value), ['time', 'duration', 'speed', 'wrapMode', 'repeatCount', 'isPlaying', 'isPaused', 'weight']) } : { name, missing: true };
    };
    const rows = clips.filter(Boolean).map(clip => state(String(clip.name)));
    if (action === 'state') return { rows };
    const name = Json.string(p.name, 'name');
    if (clips.filter(clip => clip?.name === name).length > 1) throw new CocosError('INVALID_ARGUMENT', 'Animation name is ambiguous');
    if (!clips.some(clip => clip?.name === name)) throw new CocosError('NOT_FOUND', `Animation not found: ${name}`);
    const before = state(name);
    // Creator 2 不支持 3.x crossFade(duration) 语义，明确拒绝，避免静默改为立即切换。
    if (action === 'blend') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Creator 2 Animation has no equivalent crossFade duration API');
    if (action === 'seek' && (!Number.isFinite(Number(p.time)) || Number(p.time) < 0 || Number(p.time) > Number(before.duration))) throw new CocosError('INVALID_ARGUMENT', 'Seek time is outside animation duration');
    if (action === 'seek') { A.call(component, 'setCurrentTime', Number(p.time), name); A.call(component, 'sample', name); }
    else A.call(component, action, name);
    return { before, after: state(name), frameVerified: false };
  }
  private media(p: JsonObject, type: string, action: string): JsonValue {
    const component = this.component(p, [type === 'audio' ? 'cc.AudioSource' : 'cc.VideoPlayer']);
    const state = (): JsonObject => ({ ...this.fields(component, ['enabled', 'isPlaying', 'volume', 'loop', 'mute', 'currentTime']),
      duration: A.safeData(A.call(component, 'getDuration')), ...(type === 'audio' ? { currentTime: A.safeData(A.call(component, 'getCurrentTime')) } : { isPlaying: Boolean(A.call(component, 'isPlaying')) }) });
    const before = state();
    if (action === 'state') return before;
    if (action === 'seek') { if (type === 'audio') A.call(component, 'setCurrentTime', Number(p.time)); else component.currentTime = Number(p.time); }
    else A.call(component, action);
    return { before, after: state(), playbackVerified: false };
  }
  private physics(p: JsonObject, action: string): JsonValue {
    const cc = this.inspector.environment.cc, physics = A.object(A.call(cc.director, 'getPhysicsManager'));
    if (action === 'inspect') return { enabled: Boolean(physics.enabled), gravity: A.safeData(physics.gravity), debugDrawFlags: A.safeData(physics.debugDrawFlags), backend: 'Box2D', dimension: 2 };
    if (!physics.enabled) throw new CocosError('CONTEXT_UNAVAILABLE', '2D physics is disabled');
    const vector = (value: JsonValue | undefined): unknown => { const p = Json.object(value); return A.construct(cc.Vec2, [Number(p.x), Number(p.y)]); };
    if (action === 'test_point' || action === 'test_aabb') { const hit = action === 'test_point' ? A.call(physics, 'testPoint', vector(p.point)) : A.call(physics, 'testAABB', A.construct(cc.Rect, [p.x, p.y, p.width, p.height])); const colliders = Array.isArray(hit) ? hit : hit ? [hit] : []; return { rows: colliders.map(c => ({ colliderId: A.uuid(c), nodeId: A.uuid(A.object(c).node) })), stepped: false, bodyTypes: ['dynamic'], limitations: ['Creator 2 原生 testPoint/testAABB 只查询动态刚体；静态与运动学刚体使用 raycast'] }; }
    const hits = A.call(physics, 'rayCast', vector(p.start), vector(p.end), A.object(cc.RayCastType).All) as RuntimeObject[];
    // 2.x groupIndex 是碰撞组序号；查询 mask 在返回后过滤，不修改工程碰撞矩阵。
    const mask = Number(p.mask ?? 0xffffffff) >>> 0;
    const rows = hits.filter(hit => (mask & (1 << Number(A.object(A.object(hit.collider).node).groupIndex ?? 0))) !== 0)
      .sort((a, b) => Number(a.fraction) - Number(b.fraction)).map(hit => ({ colliderId: A.uuid(hit.collider), nodeId: A.uuid(A.object(hit.collider).node), point: A.safeData(hit.point), normal: A.safeData(hit.normal), fraction: Number(hit.fraction) }));
    return { rows: rows.slice(0, Number(p.limit ?? 100)), total: rows.length, coordinateSpace: 'world-pixels', stepped: false };
  }
  private particle(p: JsonObject, action: string): JsonValue {
    const component = this.component(p, ['cc.ParticleSystem']);
    const state = (): JsonObject => this.fields(component, ['active', 'particleCount', 'totalParticles', 'emissionRate', 'duration', 'life', 'autoRemoveOnFinish']);
    const before = state();
    if (action === 'restart') A.call(component, 'resetSystem');
    else if (action === 'stop_emitting') A.call(component, 'stopSystem');
    return { before, after: state(), rendered: false };
  }
  private skeleton(p: JsonObject, family: string, action: string): JsonValue {
    const component = this.component(p, [family === 'spine' ? 'sp.Skeleton' : 'dragonBones.ArmatureDisplay']);
    const state = (): JsonObject => {
      if (family === 'dragonbones') return { ...this.fields(component, ['armatureName', 'animationName', 'playTimes', 'timeScale']), animations: A.safeData(A.call(component, 'getAnimationNames', component.armatureName)) };
      const data = component.skeletonData ? A.call(component.skeletonData, 'getRuntimeData') : null;
      return { ...this.fields(component, ['animation', 'loop', 'paused', 'timeScale', 'defaultSkin']),
        animations: data ? (A.object(data).animations as RuntimeObject[] ?? []).map(row => String(row.name)) : [],
        skins: data ? (A.object(data).skins as RuntimeObject[] ?? []).map(row => String(row.name)) : [] };
    };
    const before = state();
    if (action === 'inspect') return before;
    const name = Json.string(p.name, 'name');
    if (action === 'play') {
      if (!(before.animations as string[]).includes(name)) throw new CocosError('NOT_FOUND', 'Skeleton animation not found');
      if (family === 'dragonbones') A.call(component, 'playAnimation', name, Number(p.playTimes ?? 1));
      else A.call(component, p.queue ? 'addAnimation' : 'setAnimation', Number(p.trackIndex ?? 0), name, p.loop === true, ...(p.queue ? [Number(p.delay ?? 0)] : []));
    } else if (action === 'set_skin') {
      if (!(before.skins as string[]).includes(name)) throw new CocosError('NOT_FOUND', 'Skeleton skin not found');
      A.call(component, 'setSkin', name);
    } else A.call(component, 'setAttachment', Json.string(p.slot, 'slot'), name);
    return { before, after: state(), rendered: false };
  }
  ui(p: JsonObject, action: string): JsonValue {
    const root = this.inspector.node(Json.string(p.rootId, 'rootId')), nodes = this.inspector.all(root);
    if (action === 'assert') {
      const rows = (p.rows as JsonObject[]).map(expected => {
        const node = nodes.find(node => A.uuid(node) === expected.nodeId);
        if (!node) return { nodeId: expected.nodeId!, passed: false, reason: 'outside-subtree-or-missing' };
        const components = this.inspector.components(node), label = components.find(c => ['cc.Label', 'cc.RichText', 'cc.EditBox'].includes(this.inspector.type(c))), button = components.find(c => ['cc.Button', 'cc.Toggle'].includes(this.inspector.type(c)));
        const actual: JsonObject = { nodeId: A.uuid(node), active: Boolean(node.activeInHierarchy), text: label ? String(label.string) : null, interactable: button ? Boolean(button.interactable) : null };
        return { ...actual, passed: Object.entries(expected).every(([key, value]) => actual[key] === value), expected };
      });
      return { rows, passed: rows.every(row => row.passed), callbacksInvoked: false };
    }
    const rows = nodes.map(node => {
      const width = Number(node.width), height = Number(node.height), left = -Number(node.anchorX) * width, bottom = -Number(node.anchorY) * height;
      const corners = [[left,bottom],[left+width,bottom],[left+width,bottom+height],[left,bottom+height]].map(([x,y]) => A.object(A.call(node, 'convertToWorldSpaceAR', A.construct(this.inspector.environment.cc.Vec2,[x,y]))));
      const xs = corners.map(p=>Number(p.x)), ys = corners.map(p=>Number(p.y));
      const bounds = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs)-Math.min(...xs), height: Math.max(...ys)-Math.min(...ys) };
      return { nodeId: A.uuid(node), name: String(node.name), active: Boolean(node.activeInHierarchy), width: Number(node.width), height: Number(node.height), anchorX: Number(node.anchorX), anchorY: Number(node.anchorY), opacity: Number(node.opacity), bounds: A.safeData(bounds), corners: corners.map(corner => ({ x: Number(corner.x), y: Number(corner.y) })),
        components: this.inspector.components(node).map(c => ({ componentId: A.uuid(c), type: this.inspector.type(c), enabled: Boolean(c.enabled), properties: this.inspector.properties(c) })) };
    });
    if (action === 'hit_test') {
      const point = A.construct(this.inspector.environment.cc.Vec2, [p.x, p.y]);
      return { rows: nodes.filter(node => node.activeInHierarchy && A.call(node, '_hitTest', point)).map(node => ({ nodeId: A.uuid(node) })), finalReceiverVerified: false, coordinateSpace: 'screen-pixels', limitations: ['原生命中候选不代表事件冒泡后的最终接收者'] };
    }
    return { rows, coordinateSpace: 'world-pixels', issues: rows.filter(row => row.width === 0 || row.height === 0).map(row => ({ nodeId: row.nodeId, code: 'ZERO_SIZE' })) };
  }
  async profile(p: JsonObject, frames: FrameSession): Promise<JsonValue> {
    if (A.engineVersion(this.inspector.environment.cc) !== '2.4.15') throw new CocosError('UNSUPPORTED_VERSION', 'Native feature adapter requires Creator 2.4.15');
    const count = Number(p.frames ?? 60), warmup = Number(p.warmupFrames ?? 10), token = frames.token(), rows: JsonObject[] = [], started = performance.now();
    if (!Number.isInteger(count) || count < 2 || count > 300 || !Number.isInteger(warmup) || warmup < 1 || warmup > 120) throw new CocosError('INVALID_ARGUMENT', 'Invalid frame sampling bounds');
    let previous = performance.now();
    for (let index = 0; index < count + warmup; index++) {
      if (performance.now() - started > 15000) throw new CocosError('TIMEOUT', 'Frame sampling exceeded 15 seconds');
      await frames.wait(token); const now = performance.now();
      if (index >= warmup) rows.push({ frameMs: now - previous, drawCalls: A.safeData(A.object(this.inspector.environment.cc.renderer).drawCalls) });
      previous = now;
    }
    const sorted = rows.map(row => Number(row.frameMs)).sort((a,b)=>a-b), meanMs = sorted.reduce((sum,n)=>sum+n,0)/count, p95Ms = sorted[Math.ceil(count*0.95)-1]!;
    return { rows, frames: count, meanMs, p95Ms, maxMs: sorted[sorted.length-1]!, scope: 'whole-frame-wall-time', gpuMs: null, budget: p.maxFrameMs === undefined ? null : { passed: p95Ms <= Number(p.maxFrameMs), maxFrameMs: p.maxFrameMs }, limitations: ['DrawCall 来自原生 renderer；不代表单独 Shader 的 GPU 耗时'] };
  }
  execute(id: string, p: JsonObject): JsonValue {
    if (A.engineVersion(this.inspector.environment.cc) !== '2.4.15') throw new CocosError('UNSUPPORTED_VERSION', 'Native feature adapter requires Creator 2.4.15');
    if (id === 'runtime.graphics.inspect') { const cc = this.inspector.environment.cc; return { renderType: A.safeData(A.object(cc.game).renderType), drawCalls: A.safeData(A.object(cc.renderer).drawCalls), gpuMemory: null, api: 'Creator2-renderer', limitations: ['不枚举 Creator 3 gfx 格式；不测量驱动总显存'] }; }
    if (id === 'runtime.resources.snapshot') return new Creator2ResourceSnapshot(this.inspector).snapshot();
    if (id === 'runtime.resources.diff') return new Creator2ResourceSnapshot(this.inspector).diff(p);
    if (id === 'runtime.resources.trend') return new Creator2ResourceSnapshot(this.inspector).trend(p);
    if (id === 'runtime.camera.inspect') return new Creator2Camera(this.inspector).inspect(p);
    if (id === 'runtime.camera.convert') return new Creator2Camera(this.inspector).convert(p);
    if (id === 'runtime.camera.culling') return new Creator2Camera(this.inspector).culling(p);
    if (id === 'runtime.camera.sample_pixels') return new Creator2Camera(this.inspector).samplePixels(p);
    if (id === 'runtime.dragonbones.fade') return new Creator2DragonBonesFade(this.inspector).fade(p);
    if (id === 'runtime.dragonbones.details') return new Creator2DragonBones(this.inspector).details(p);
    if (id === 'runtime.spine.mix.inspect' || id === 'runtime.spine.mix.update') return new Creator2SpineMix(this.inspector).execute(p, id.endsWith('.update'));
    if (id === 'runtime.spine.details') return new Creator2Spine(this.inspector).details(p);
    if (id === 'runtime.collision2d.inspect') return new Creator2Collision(this.inspector).inspect(p);
    if (id === 'runtime.joint2d.inspect') return new Creator2Joint(this.inspector).inspect(p);
    if (id.startsWith('runtime.rigidbody2d.')) return new Creator2RigidBody(this.inspector).execute(id, p);
    if (id.startsWith('runtime.control.')) return new Creator2Controls(this.inspector).execute(id, p);
    const [, family, action] = id.split('.');
    if (family === 'animation') return this.animation(p, action!);
    if (family === 'audio' || family === 'video') return this.media(p, family, action!);
    if (family === 'webview') { const component = this.component(p, ['cc.WebView']); return { componentId: A.uuid(component), enabled: Boolean(component.enabled), configured: Boolean(component.url), navigationExecuted: false }; }
    if (family === 'physics3d') { const manager = A.call(this.inspector.environment.cc.director, 'getPhysics3DManager'); if (!manager) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Physics 3D module is excluded'); return { ...this.fields(A.object(manager), ['enabled', 'gravity', 'allowSleep']), raycastAvailable: typeof A.object(manager).raycast === 'function', limitations: ['Creator 2 raycast uses collision group semantics; Creator 3 mask query is not mapped'] }; }
    if (family === 'physics2d') return this.physics(p, action!);
    if (family === 'particle2d') return this.particle(p, action!);
    if (family === 'spine' || family === 'dragonbones') return this.skeleton(p, family, action!);
    if (family === 'ui') return this.ui(p, action!);
    if (family === 'atlas') return this.fields(A.object(this.inspector.environment.cc.dynamicAtlasManager), ['enabled', 'maxAtlasCount', 'textureSize', 'maxFrameSize', 'minFrameSize', 'textureBleeding']);
    if (family === 'label' || family === 'render2d') {
      const nodes = this.inspector.all(this.inspector.node(Json.string(p.rootId, 'rootId')));
      const rows = nodes.flatMap(node => this.inspector.components(node).filter(c => family === 'label' ? this.inspector.type(c) === 'cc.Label' : ['cc.Sprite', 'cc.Label', 'cc.RichText', 'cc.Mask', 'cc.Graphics'].includes(this.inspector.type(c))).map(c => ({ nodeId: A.uuid(node), componentId: A.uuid(c), type: this.inspector.type(c), ...this.fields(c, ['cacheMode', 'fontSize', 'useSystemFont', 'string', 'enabled']), groupIndex: Number(node.groupIndex), opacity: Number(node.opacity) })));
      return { rows, actualDrawCallsVerified: false, limitations: ['仅组件和合批条件诊断；实际 DrawCall 请结合 profiler 与截图'] };
    }
    throw new CocosError('UNSUPPORTED_CAPABILITY', id);
  }
}
