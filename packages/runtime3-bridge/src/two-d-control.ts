import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import { FeatureSupport as F } from './feature-support.js';
import type { SceneInspector } from './scene.js';
import type { FrameSession } from './frame-session.js';

export class TwoDControl {
  constructor(private readonly scene: SceneInspector, private readonly frames: FrameSession) {}
  private get cc(): RuntimeObject { return this.scene.environment.cc; }
  private component(id: string, type: string): RuntimeObject {
    const component = this.scene.component(id);
    const constructor = F.type(this.cc, type) ?? A.call(this.cc.js, 'getClassByName', type === 'sp.Skeleton' ? type : `cc.${type}`);
    F.require(constructor, type);
    if (typeof constructor !== 'function' || !(component instanceof constructor)) throw new CocosError('INVALID_ARGUMENT', `Target is not ${type}`);
    return component;
  }
  private spineState(c: RuntimeObject): JsonObject {
    const data = F.require(c.skeletonData, 'Spine skeletonData');
    const native = F.require(A.call(data, 'getRuntimeData'), 'Spine runtime data');
    const rows = Array.from({ length: 8 }, (_, trackIndex) => {
      const value = A.call(c, 'getCurrent', trackIndex);
      const track = value ? A.object(value) : undefined;
      return { trackIndex, animation: track?.animation ? String(A.object(track.animation).name) : null, trackTime: Number(track?.trackTime ?? 0), loop: Boolean(track?.loop) };
    });
    return { componentId: A.uuid(c), cached: Boolean(A.call(c, 'isAnimationCached')), animationNames: (native.animations as RuntimeObject[] ?? []).map(row => String(row.name)),
      skinNames: (native.skins as RuntimeObject[] ?? []).map(row => String(row.name)), rows, eventDeliveryVerified: false };
  }
  async spine(id: string, p: JsonObject): Promise<JsonValue> {
    const c = this.component(Json.string(p.componentId, 'componentId'), 'sp.Skeleton'), before = this.spineState(c);
    if (id.endsWith('.inspect')) return before;
    if (id.endsWith('.trace')) {
      const count = this.count(p.frames), token = this.frames.token(), rows: JsonObject[] = [];
      for (let index = 0; index < count; index++) { await this.frames.wait(token); rows.push({ frame: index + 1, state: this.spineState(c) }); }
      return { rows, listenerInstalled: false, limitations: ['只采集轨道，不覆盖已有 Spine 单槽事件监听；缓存模式可能不提供 TrackEntry'] };
    }
    if (!c.enabledInHierarchy) throw new CocosError('OPERATION_CONFLICT', 'Spine must be active');
    const name = Json.string(p.name, 'name');
    if (id.endsWith('.play')) {
      if (!(before.animationNames as string[]).includes(name)) throw new CocosError('NOT_FOUND', 'Spine animation not found');
      if (before.cached && (Number(p.trackIndex ?? 0) !== 0 || p.queue)) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Cached Spine multi-track/queue is not adapted');
    } else if (id.endsWith('.set_skin')) {
      if (!(before.skinNames as string[]).includes(name)) throw new CocosError('NOT_FOUND', 'Spine skin not found');
    } else if (id.endsWith('.set_attachment')) {
      if (before.cached) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Attachment edits require realtime Spine');
      if (!A.call(c, 'getAttachment', Json.string(p.slot, 'slot'), name)) throw new CocosError('NOT_FOUND', 'Spine attachment not found');
    } else throw new CocosError('UNSUPPORTED_CAPABILITY', 'Unknown Spine action');
    try {
      if (id.endsWith('.play')) A.call(c, p.queue ? 'addAnimation' : 'setAnimation', Number(p.trackIndex ?? 0), name, Boolean(p.loop), Number(p.delay ?? 0));
      else if (id.endsWith('.set_skin')) A.call(c, 'setSkin', name);
      else A.call(c, 'setAttachment', p.slot, name);
      return { before, after: this.spineState(c), frameVerified: false, restorePolicy: '播放事件和缓存变更不可自动回滚；失败先查询' };
    } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Spine action may have executed', { before, cause: CocosError.from(error).message }); }
  }
  private count(value: JsonValue | undefined): number {
    const count = Number(value);
    if (!Number.isInteger(count) || count < 1 || count > 300) throw new CocosError('INVALID_ARGUMENT', 'Frames must be 1..300');
    return count;
  }
  async contacts(p: JsonObject): Promise<JsonValue> {
    if (!Array.isArray(p.componentIds) || !p.componentIds.length || p.componentIds.length > 32) throw new CocosError('INVALID_ARGUMENT', 'Expected 1..32 colliders');
    const colliders = p.componentIds.map(id => this.component(String(id), 'Collider2D'));
    const count = this.count(p.frames), token = this.frames.token(), rows: JsonObject[] = [];
    const events = F.require(this.cc.Contact2DType, 'Contact2DType'), bindings: Array<{ c: RuntimeObject; event: string; callback: (...args: unknown[]) => void }> = [];
    let frame = 0, dropped = 0;
    try {
      for (const c of colliders) for (const key of ['BEGIN_CONTACT', 'END_CONTACT', 'PRE_SOLVE', 'POST_SOLVE']) {
        const event = events[key]; if (typeof event !== 'string') continue;
        const callback = (self: unknown, other: unknown, contact: unknown): void => {
          if (rows.length >= 512) { dropped++; return; }
          // 原生 Contact 生命周期仅限回调，立即复制允许字段，不保存对象句柄。
          const manifold = contact && typeof A.object(contact).getWorldManifold === 'function' ? A.call(contact, 'getWorldManifold') : null;
          rows.push({ frame, event, selfId: A.uuid(self), otherId: A.uuid(other), manifold: manifold ? A.safeData(manifold) : null });
        };
        bindings.push({ c, event, callback }); A.call(c, 'on', event, callback);
      }
      for (frame = 1; frame <= count; frame++) await this.frames.wait(token);
      return { rows, dropped, sampledFrames: count, stepsSimulation: false, limitations: ['事件依赖实际物理后端和 contact listener 配置；空结果不证明没有碰撞'] };
    } finally {
      const cleanupErrors: string[] = [];
      for (const binding of bindings) try { A.call(binding.c, 'off', binding.event, binding.callback); } catch (error) { cleanupErrors.push(CocosError.from(error).message); }
      if (cleanupErrors.length) throw new CocosError('OUTCOME_UNKNOWN', 'Contact listener cleanup incomplete', { cleanupErrors });
    }
  }
  tilemap(id: string, p: JsonObject): JsonValue {
    const map = id.endsWith('.inspect'), c = this.component(Json.string(p.componentId, 'componentId'), map ? 'TiledMap' : 'TiledLayer');
    if (map) return { componentId: A.uuid(c), mapSize: A.safeData(A.call(c, 'getMapSize')), tileSize: A.safeData(A.call(c, 'getTileSize')), orientation: A.safeData(A.call(c, 'getMapOrientation')), rows: (A.call(c, 'getLayers') as RuntimeObject[]).map(layer => ({ componentId: A.uuid(layer), name: String(A.call(layer, 'getLayerName')), size: A.safeData(A.call(layer, 'getLayerSize')) })),
      objectGroups: (A.call(c, 'getObjectGroups') as RuntimeObject[]).map(group => { const objects = A.call(group, 'getObjects') as RuntimeObject[]; return { componentId: A.uuid(group), name: String(A.call(group, 'getGroupName')), properties: A.safeData(A.call(group, 'getProperties')), rows: objects.slice(0, 500).map(row => A.safeData(row)), total: objects.length, truncated: objects.length > 500 }; }) };
    const size = A.object(A.call(c, 'getLayerSize'));
    // 2.4.15 在转换重载参数前检查 !pos，数字 x=0 会误报；始终使用 Vec2 重载。
    const coordinates = (x: number, y: number): unknown[] => this.scene.environment.major === 2 ? [A.construct(this.cc.Vec2, [x, y])] : [x, y];
    const cell = (x: number, y: number): JsonObject => {
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= Number(size.width) || y >= Number(size.height)) throw new CocosError('INVALID_ARGUMENT', 'Tile coordinates outside layer');
      return { x, y, gid: Json.value(A.call(c, 'getTileGIDAt', ...coordinates(x, y))), flags: Json.value(A.call(c, 'getTileFlagsAt', ...coordinates(x, y))), position: A.safeData(A.call(c, 'getPositionAt', ...coordinates(x, y))) };
    };
    if (id.endsWith('.query_region')) {
      const width = Number(p.width), height = Number(p.height), rows: JsonObject[] = [];
      if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 64) || width * height > 4096) throw new CocosError('INVALID_ARGUMENT', 'Invalid region budget');
      for (let y = Number(p.y); y < Number(p.y) + height; y++) for (let x = Number(p.x); x < Number(p.x) + width; x++) rows.push(cell(x, y));
      return { rows, coordinateSpace: 'tile-layer-local', sourcePersisted: false };
    }
    if (!Array.isArray(p.rows) || !p.rows.length || p.rows.length > 512) throw new CocosError('INVALID_ARGUMENT', 'Expected 1..512 tile edits');
    const seen = new Set<string>(), rows = p.rows.map(value => {
      const row = Json.object(value), x = Number(row.x), y = Number(row.y), gid = Number(row.gid), flags = Number(row.flags ?? 0), key = `${x}:${y}`;
      if (seen.has(key) || !Number.isInteger(gid) || gid < 0 || gid > 0x1fffffff || !Number.isInteger(flags) || flags < 0 || flags > 0xffffffff || (flags & 0x1fffffff) !== 0) throw new CocosError('INVALID_ARGUMENT', 'Duplicate cell or invalid GID/flags');
      seen.add(key); return { before: cell(x, y), after: { x, y, gid, flags } };
    });
    // 完整规范化快照作不透明守卫值，避免浏览器端短哈希碰撞；会话代数防止跨场景复用。
    const planHash = Json.canonical({ generation: this.frames.token(), componentId: A.uuid(c), size: A.safeData(size), rows });
    if (id.endsWith('.plan')) return { planHash, rows, sourcePersisted: false };
    if (!id.endsWith('.apply')) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Unknown tile operation');
    if (p.planHash !== planHash) throw new CocosError('STALE_REVISION', 'Tile region changed; plan again');
    const completed: JsonObject[] = []; let pending: JsonObject | null = null;
    try {
      for (const row of rows) {
        pending = row;
        A.call(c, 'setTileGIDAt', row.after.gid, ...coordinates(row.after.x, row.after.y), row.after.flags);
        const actual = cell(row.after.x, row.after.y);
        if (actual.gid !== row.after.gid || actual.flags !== row.after.flags) throw new CocosError('VERIFICATION_FAILED', 'Tile GID not available in tileset or readback mismatch');
        completed.push({ ...row, actual }); pending = null;
      }
      return { rows: completed, sourcePersisted: false, visualVerified: false };
    } catch (error) { throw new CocosError('OUTCOME_UNKNOWN', 'Partial runtime tile edit; inspect before re-planning', { completed, pending, cause: CocosError.from(error).message }); }
  }
}
