import { CocosError } from '../../contracts/src/index.js';

export interface GameplayTemplate { title: string; bindings: string[]; body: string; imports: string[] }
/** 输出可由 Creator 编辑的项目组件。固定模板不接受脚本片段，配置通过原生 Inspector 属性绑定。 */
export class GameplayTemplates {
  readonly rows: Record<string, GameplayTemplate> = {
    camera: { title: '正交相机跟随、边界与震屏', imports: ['Node', 'Camera', 'Vec3'], bindings: ['target：跟随节点', 'camera：同节点正交 Camera', '边界为相机中心世界坐标；需按视口半高向内收缩'], body: `
  @property(Node) target: Node | null = null;
  @property smooth = 8;
  @property deadZone = 20;
  @property minX = -100000; @property maxX = 100000;
  @property minY = -100000; @property maxY = 100000;
  private remaining = 0; private amplitude = 0;
  private base = new Vec3();
  onEnable() { this.base.set(this.node.worldPosition); }
  shake(amplitude = 8, duration = 0.2) { this.amplitude = Math.max(0, amplitude); this.remaining = Math.max(0, duration); }
  zoom(height: number) { const camera = this.getComponent(Camera); if (!camera || !Number.isFinite(height) || height <= 0) throw new Error('Invalid orthographic height'); camera.orthoHeight = height; }
  lateUpdate(dt: number) {
    if (!this.target?.isValid || !this.node.getComponent(Camera) || this.minX > this.maxX || this.minY > this.maxY) return;
    const target = this.target.worldPosition; const k = 1 - Math.exp(-Math.max(0, this.smooth) * dt);
    for (const axis of ['x', 'y'] as const) { const delta = target[axis] - this.base[axis]; if (Math.abs(delta) > this.deadZone) this.base[axis] += (delta - Math.sign(delta) * this.deadZone) * k; }
    this.base.x = Math.min(this.maxX, Math.max(this.minX, this.base.x)); this.base.y = Math.min(this.maxY, Math.max(this.minY, this.base.y));
    this.remaining = Math.max(0, this.remaining - dt);
    const offset = this.remaining > 0 ? Math.sin(this.remaining * 137) * this.amplitude : 0;
    this.node.setWorldPosition(this.base.x + offset, this.base.y + offset * 0.6, this.base.z);
  }
  onDisable() { this.remaining = 0; this.node.setWorldPosition(this.base); }
` },
    controller: { title: '横版/俯视刚体移动与跳跃缓冲', imports: ['RigidBody2D', 'PhysicsSystem2D', 'ERaycast2DType', 'Vec2', 'input', 'Input', 'EventKeyboard', 'KeyCode'], bindings: ['同节点 Dynamic RigidBody2D 与 Collider2D', 'groundMask：仅地形碰撞组，不能包括角色自身', 'topDown：俯视时须将刚体重力配置为 0', '业务通过 attack/movement-state 节点事件绑定动画与攻击'], body: `
  @property topDown = false; @property speed = 5; @property jumpSpeed = 9;
  @property groundDistance = 36; @property groundMask = 1;
  @property coyoteTime = 0.1; @property jumpBuffer = 0.12;
  private keys = new Set<number>(); private grace = 0; private queued = 0;
  private down(event: EventKeyboard) { const fresh = !this.keys.has(event.keyCode); this.keys.add(event.keyCode); if (fresh && event.keyCode === KeyCode.SPACE) this.queued = this.jumpBuffer; if (fresh && event.keyCode === KeyCode.KEY_J) this.node.emit('attack'); }
  private up(event: EventKeyboard) { this.keys.delete(event.keyCode); }
  onEnable() { input.on(Input.EventType.KEY_DOWN, this.down, this); input.on(Input.EventType.KEY_UP, this.up, this); }
  onDisable() { input.off(Input.EventType.KEY_DOWN, this.down, this); input.off(Input.EventType.KEY_UP, this.up, this); this.keys.clear(); this.queued = 0; this.grace = 0; }
  update(dt: number) {
    const body = this.getComponent(RigidBody2D); if (!body) return;
    const x = Number(this.keys.has(KeyCode.KEY_D) || this.keys.has(KeyCode.ARROW_RIGHT)) - Number(this.keys.has(KeyCode.KEY_A) || this.keys.has(KeyCode.ARROW_LEFT));
    let y = body.linearVelocity.y;
    if (this.topDown) y = (Number(this.keys.has(KeyCode.KEY_W) || this.keys.has(KeyCode.ARROW_UP)) - Number(this.keys.has(KeyCode.KEY_S) || this.keys.has(KeyCode.ARROW_DOWN))) * this.speed;
    else {
      const p = this.node.worldPosition;
      const grounded = PhysicsSystem2D.instance.raycast(new Vec2(p.x, p.y), new Vec2(p.x, p.y - this.groundDistance), ERaycast2DType.All, this.groundMask).some(hit => hit.collider.node !== this.node && hit.normal.y > 0.5);
      this.grace = grounded ? this.coyoteTime : Math.max(0, this.grace - dt); this.queued = Math.max(0, this.queued - dt);
      if (this.grace > 0 && this.queued > 0) { y = this.jumpSpeed; this.grace = 0; this.queued = 0; }
    }
    const velocity = new Vec2(x * this.speed, y); if (this.topDown && velocity.length() > this.speed) velocity.normalize().multiplyScalar(this.speed);
    body.linearVelocity = velocity; this.node.emit('movement-state', { x, y, grounded: this.grace > 0 });
  }
` },
    pool: { title: '有容量限制的预制体对象池', imports: ['Prefab', 'Node', 'instantiate'], bindings: ['prefab：池化预制体', '业务监听 pool-acquire/pool-release 重置状态；不会复用外部节点'], body: `
  @property(Prefab) prefab: Prefab | null = null; @property capacity = 64;
  private available: Node[] = []; private owned = new Set<Node>(); private borrowed = new Set<Node>();
  acquire(): Node | null {
    // 业务可能在借出期间销毁节点；清除失效节点，避免永久占用容量。
    for (const node of this.owned) if (!node.isValid) { this.owned.delete(node); this.borrowed.delete(node); }
    let node = this.available.pop(); while (node && !node.isValid) { this.owned.delete(node); node = this.available.pop(); }
    if (!node) { if (!this.prefab || this.owned.size >= this.capacity) return null; node = instantiate(this.prefab); this.owned.add(node); }
    this.borrowed.add(node); node.setParent(this.node); node.active = true; node.emit('pool-acquire'); return node;
  }
  release(node: Node): boolean { if (!this.owned.has(node) || !this.borrowed.delete(node)) return false; if (!node.isValid) { this.owned.delete(node); return true; } node.emit('pool-release'); node.active = false; node.setParent(this.node); this.available.push(node); return true; }
  get statistics() { return { total: this.owned.size, active: this.borrowed.size, available: this.available.length }; }
  onDestroy() { for (const node of this.owned) if (node.isValid) node.destroy(); this.owned.clear(); this.available = []; this.borrowed.clear(); }
` },
    effects: { title: '飘字/拾取飞入的可复用运动与淡出', imports: ['Node', 'Vec3', 'UIOpacity', 'Label'], bindings: ['同节点 UIOpacity；飘字可附加 Label', 'target 可选；不配置时按 rise 向上移动', '监听 effect-complete 回收，不主动销毁用户节点'], body: `
  @property(Node) target: Node | null = null; @property duration = 0.5; @property rise = 80;
  private elapsed = 0; private playing = false; private origin = new Vec3();
  play(text = '') { const label = this.getComponent(Label); if (label) label.string = text; this.origin.set(this.node.worldPosition); this.elapsed = 0; this.playing = true; const opacity = this.getComponent(UIOpacity); if (opacity) opacity.opacity = 255; }
  update(dt: number) { if (!this.playing) return; this.elapsed += dt; const t = Math.min(1, this.elapsed / Math.max(0.001, this.duration)); const end = this.target?.isValid ? this.target.worldPosition : new Vec3(this.origin.x, this.origin.y + this.rise, this.origin.z); this.node.setWorldPosition(Vec3.lerp(new Vec3(), this.origin, end, t)); const opacity = this.getComponent(UIOpacity); if (opacity) opacity.opacity = 255 * (1 - t); if (t === 1) { this.playing = false; this.node.emit('effect-complete'); } }
  onDisable() { this.playing = false; }
` },
    joystick: { title: '单指虚拟摇杆与取消归零', imports: ['Node', 'UITransform', 'EventTouch', 'Vec2', 'Vec3'], bindings: ['同节点 UITransform；knob 可选', '监听 joystick-change；坐标为当前 UI 局部坐标'], body: `
  @property(Node) knob: Node | null = null; @property radius = 64;
  private finger: number | null = null;
  onEnable() { this.node.on(Node.EventType.TOUCH_START, this.onTouchStart, this); this.node.on(Node.EventType.TOUCH_MOVE, this.move, this); this.node.on(Node.EventType.TOUCH_END, this.end, this); this.node.on(Node.EventType.TOUCH_CANCEL, this.end, this); }
  private onTouchStart(event: EventTouch) { if (this.finger !== null) return; this.finger = event.getID(); this.move(event); }
  private move(event: EventTouch) { if (event.getID() !== this.finger) return; const transform = this.getComponent(UITransform); if (!transform) return; const p = event.getUILocation(); const local = transform.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0)); const axis = new Vec2(local.x, local.y).multiplyScalar(1 / Math.max(1, this.radius)); if (axis.length() > 1) axis.normalize(); this.knob?.setPosition(axis.x * this.radius, axis.y * this.radius, 0); this.node.emit('joystick-change', axis); }
  private end(event: EventTouch) { if (event.getID() === this.finger) this.reset(); }
  private reset() { this.finger = null; this.knob?.setPosition(0, 0, 0); this.node.emit('joystick-change', new Vec2()); }
  onDisable() { this.node.off(Node.EventType.TOUCH_START, this.onTouchStart, this); this.node.off(Node.EventType.TOUCH_MOVE, this.move, this); this.node.off(Node.EventType.TOUCH_END, this.end, this); this.node.off(Node.EventType.TOUCH_CANCEL, this.end, this); this.reset(); }
` },
    hitbox: { title: '定时攻击/受击传感器区域', imports: ['Collider2D', 'Contact2DType'], bindings: ['同节点 Collider2D 且 sensor=true', '按项目配置碰撞组及刚体 contact listener；通过 activate 开启攻击窗口'], body: `
  @property windowSeconds = 0.15; private remaining = 0; private hit = new Set<string>();
  private overlapping = new Map<string, Collider2D>();
  private collider: Collider2D | null = null;
  onEnable() { this.collider = this.getComponent(Collider2D); this.collider?.on(Contact2DType.BEGIN_CONTACT, this.contact, this); this.collider?.on(Contact2DType.END_CONTACT, this.leave, this); }
  // 攻击开始时也检查已有重叠；仅依赖 BEGIN_CONTACT 会漏掉进入窗口前已接触的目标。
  activate() { this.remaining = Math.max(0, this.windowSeconds); this.hit.clear(); for (const other of this.overlapping.values()) this.report(other); }
  private contact(self: Collider2D, other: Collider2D) { this.overlapping.set(other.uuid, other); this.report(other); }
  private leave(self: Collider2D, other: Collider2D) { this.overlapping.delete(other.uuid); }
  private report(other: Collider2D) { if (this.remaining <= 0 || !this.collider?.sensor || !other.isValid || this.hit.has(other.uuid)) return; this.hit.add(other.uuid); this.node.emit('hitbox-hit', other.node); }
  update(dt: number) { this.remaining = Math.max(0, this.remaining - dt); }
  onDisable() { this.collider?.off(Contact2DType.BEGIN_CONTACT, this.contact, this); this.collider?.off(Contact2DType.END_CONTACT, this.leave, this); this.remaining = 0; this.hit.clear(); this.overlapping.clear(); }
` },
    dialogue: { title: '数据驱动分支对白', imports: ['JsonAsset', 'Label'], bindings: ['data.json：{start,rows:[{id,text,choices:[{label,next}]}]}', 'label：显示文本；监听 dialogue-choices 绘制选项；条件与奖励交给业务'], body: `
  @property(JsonAsset) data: JsonAsset | null = null; @property(Label) label: Label | null = null;
  private current = ''; private rows: Array<{ id: string; text: string; choices: Array<{ label: string; next: string | null }> }> = [];
  begin() { const data = this.data?.json as { start?: string; rows?: Array<{ id: string; text: string; choices: Array<{ label: string; next: string | null }> }> } | undefined; if (!data || !Array.isArray(data.rows) || data.rows.length > 1000) throw new Error('Invalid dialogue rows'); const ids = new Set(data.rows.map(row => row.id)); if (ids.size !== data.rows.length) throw new Error('Duplicate dialogue id'); for (const row of data.rows) if (typeof row.id !== 'string' || typeof row.text !== 'string' || !Array.isArray(row.choices) || row.choices.length > 16 || row.choices.some(choice => typeof choice.label !== 'string' || choice.next !== null && !ids.has(choice.next))) throw new Error('Invalid dialogue reference'); this.rows = data.rows; this.show(String(data.start)); }
  choose(index: number) { const row = this.rows.find(row => row.id === this.current); if (!Number.isInteger(index) || !row?.choices[index]) throw new Error('Invalid dialogue choice'); const next = row.choices[index]!.next; if (next === null) { this.current = ''; this.node.emit('dialogue-complete'); } else this.show(next); }
  private show(id: string) { const row = this.rows.find(row => row.id === id); if (!row) throw new Error('Dialogue node missing'); this.current = id; if (this.label) this.label.string = row.text; this.node.emit('dialogue-choices', row.choices.map(choice => ({ ...choice }))); }
` },
    patrol: { title: '世界坐标路线巡逻', imports: ['Node', 'Vec3'], bindings: ['waypoints：世界坐标巡逻点', '适用于无刚体或 kinematic 项目适配；不会自动绕开碰撞体'], body: `
  @property([Node]) waypoints: Node[] = []; @property speed = 100; @property loop = true;
  private index = 0; private complete = false;
  restart() { this.index = 0; this.complete = false; }
  update(dt: number) { if (this.complete || !this.waypoints.length) return; const target = this.waypoints[this.index]; if (!target?.isValid) return; const p = this.node.worldPosition; const delta = Vec3.subtract(new Vec3(), target.worldPosition, p); const distance = delta.length(); const step = Math.max(0, this.speed) * dt; if (distance <= step) { this.node.setWorldPosition(target.worldPosition); this.index++; if (this.index >= this.waypoints.length) { if (this.loop) this.index = 0; else { this.complete = true; this.node.emit('patrol-complete'); } } } else this.node.setWorldPosition(Vec3.scaleAndAdd(new Vec3(), p, delta, step / distance)); }
` },
    parallax: { title: '相机驱动视差背景', imports: ['Node', 'Vec3'], bindings: ['camera：相机节点；factor=0 固定，factor=1 同步移动'], body: `
  @property(Node) camera: Node | null = null; @property factor = 0.5;
  private origin = new Vec3(); private cameraOrigin = new Vec3();
  onEnable() { this.origin.set(this.node.worldPosition); if (this.camera) this.cameraOrigin.set(this.camera.worldPosition); }
  lateUpdate() { if (!this.camera?.isValid) return; const p = this.camera.worldPosition; this.node.setWorldPosition(this.origin.x + (p.x - this.cameraOrigin.x) * this.factor, this.origin.y + (p.y - this.cameraOrigin.y) * this.factor, this.origin.z); }
` },
    ui: { title: 'UI 菜单/背包选择与数据接口', imports: ['Node', 'Button', 'Label'], bindings: ['子树 Button 以节点名发送 ui-action；不自动执行购买/奖励/全局暂停', 'setText(path,value)、show/hide 为公开业务接口'], body: `
  private bindings: Array<{ node: Node; callback: () => void }> = [];
  onEnable() { const pending = [...this.node.children]; while (pending.length) { const node = pending.pop()!; pending.push(...node.children); if (node.getComponent(Button)) { const callback = () => this.node.emit('ui-action', node.name); node.on(Button.EventType.CLICK, callback, this); this.bindings.push({ node, callback }); } } }
  onDisable() { for (const binding of this.bindings) if (binding.node.isValid) binding.node.off(Button.EventType.CLICK, binding.callback, this); this.bindings = []; }
  show() { this.node.active = true; } hide() { this.node.active = false; }
  setText(path: string, value: string) { const node = this.node.getChildByPath(path); const label = node?.getComponent(Label); if (!label) throw new Error('UI text target missing'); label.string = value; }
` },
    virtual_list: { title: '固定行高的滚动列表节点复用', imports: ['ScrollView', 'Prefab', 'Node', 'UITransform', 'JsonAsset', 'instantiate'], bindings: ['scroll.content：顶部锚点且未挂 Layout 的专用列表容器', 'rowPrefab：行预制体；data.json.rows：真实数据', '监听每个行节点 virtual-row 绑定业务显示；最多创建 200 行节点'], body: `
  @property(ScrollView) scroll: ScrollView | null = null; @property(Prefab) rowPrefab: Prefab | null = null;
  @property(JsonAsset) data: JsonAsset | null = null; @property rowHeight = 64;
  private cells: Node[] = []; private bound: ScrollView | null = null;
  onEnable() { this.bound = this.scroll; this.bound?.node.on(ScrollView.EventType.SCROLLING, this.refresh, this); this.refresh(); }
  refresh() {
    const scroll = this.scroll, content = scroll?.content, prefab = this.rowPrefab; const rows = (this.data?.json as { rows?: unknown[] } | undefined)?.rows;
    if (!scroll || !content || !prefab || !Array.isArray(rows)) return;
    const transform = content.getComponent(UITransform), viewport = content.parent?.getComponent(UITransform);
    if (!transform || !viewport || transform.anchorY !== 1 || !Number.isFinite(this.rowHeight) || this.rowHeight <= 0 || rows.length > 100000) throw new Error('Invalid virtual list geometry/data');
    const capacity = Math.min(rows.length, Math.ceil(viewport.height / this.rowHeight) + 2); if (capacity > 200) throw new Error('Virtual list exceeds cell budget');
    transform.setContentSize(transform.width, Math.max(viewport.height, rows.length * this.rowHeight));
    while (this.cells.length < capacity) { const node = instantiate(prefab); node.setParent(content); this.cells.push(node); }
    const first = Math.min(Math.max(0, rows.length - capacity), Math.max(0, Math.floor(scroll.getScrollOffset().y / this.rowHeight)));
    for (let i = 0; i < this.cells.length; i++) { const node = this.cells[i]!; const index = first + i; node.active = i < capacity && index < rows.length; if (node.active) { node.setPosition(0, -(index + 0.5) * this.rowHeight, 0); node.emit('virtual-row', { index, data: rows[index] }); } }
  }
  onDisable() { this.bound?.node.off(ScrollView.EventType.SCROLLING, this.refresh, this); this.bound = null; }
  onDestroy() { for (const node of this.cells) if (node.isValid) node.destroy(); this.cells = []; }
` },
    spine_socket: { title: 'Spine 骨骼挂点同步', imports: ['sp', 'Node', 'Vec3'], bindings: ['skeleton：Spine 组件；boneName：骨骼名称；target：挂点节点', '仅实时模式；位置与角度同步，不自动改武器资源或父子关系'], body: `
  @property(sp.Skeleton) skeleton: sp.Skeleton | null = null; @property(Node) target: Node | null = null;
  @property boneName = ''; @property offsetX = 0; @property offsetY = 0;
  lateUpdate() {
    const skeleton = this.skeleton, target = this.target;
    if (!skeleton?.isValid || !target?.isValid || skeleton.isAnimationCached()) return;
    const bone = skeleton.findBone(this.boneName); if (!bone) return;
    const local = new Vec3(bone.worldX + this.offsetX * bone.a + this.offsetY * bone.b, bone.worldY + this.offsetX * bone.c + this.offsetY * bone.d, 0);
    const matrix = skeleton.node.worldMatrix;
    const origin = Vec3.transformMat4(new Vec3(), local, matrix);
    // 用世界空间骨轴求角度，保留祖先节点旋转和缩放对挂点方向的影响。
    const axis = Vec3.transformMat4(new Vec3(), new Vec3(local.x + bone.a, local.y + bone.c, 0), matrix);
    target.setWorldPosition(origin);
    target.setWorldRotationFromEuler(0, 0, Math.atan2(axis.y - origin.y, axis.x - origin.x) * 180 / Math.PI);
  }
` },
    burst: { title: '2D 粒子与音效组合播放', imports: ['ParticleSystem2D', 'AudioSource'], bindings: ['particles：已有 ParticleSystem2D，autoRemoveOnFinish 必须关闭', 'audio 可选；不自动销毁或回收节点'], body: `
  @property(ParticleSystem2D) particles: ParticleSystem2D | null = null; @property(AudioSource) audio: AudioSource | null = null;
  play() { if (this.particles?.autoRemoveOnFinish) throw new Error('Particle auto-removal must be disabled'); this.particles?.resetSystem(); this.audio?.play(); }
  stop() { this.particles?.stopSystem(); this.audio?.stop(); }
` },
  };
  source(template: string, className: string): { source: string; template: GameplayTemplate } {
    const spec = Object.hasOwn(this.rows, template) ? this.rows[template] : undefined;
    if (!spec || !/^[A-Z][A-Za-z0-9]{2,63}$/.test(className)) throw new CocosError('INVALID_ARGUMENT', 'Unknown template or invalid class name');
    return { template: spec, source: `// Generated by Cocos MCP. 项目组件；必须绑定下述依赖后进行预览验收。\n// ${spec.bindings.join('\n// ')}\nimport { _decorator, Component, ${spec.imports.join(', ')} } from 'cc';\nconst { ccclass, property } = _decorator;\n@ccclass('${className}')\nexport class ${className} extends Component {${spec.body}\n}\n` };
  }
}
