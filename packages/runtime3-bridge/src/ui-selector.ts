import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from './access.js';
import { SceneInspector } from './scene.js';

/** 选择器和投影只读取公开引擎 API；命中候选始终与实际事件接收者分开记录。 */
export class RuntimeUiSelector {
  constructor(private readonly scene: SceneInspector) {}
  private nodes(p: JsonObject, selector: JsonObject): RuntimeObject[] {
    const rows = this.scene.all(p.rootId ? this.scene.node(String(p.rootId)) : this.scene.current());
    if (rows.length > 5000) throw new CocosError('RESOURCE_BUSY', 'UI selector scope exceeds 5000 nodes');
    if (!['nodeId', 'name', 'path'].some(key => typeof selector[key] === 'string' && selector[key] !== '')) throw new CocosError('INVALID_ARGUMENT', 'Specify a nodeId, name or path');
    return rows.filter(node => {
      const names: string[] = []; let cursor: RuntimeObject | undefined = node;
      while (cursor?.parent) { names.unshift(String(cursor.name)); cursor = cursor.parent as RuntimeObject; }
      return (!selector.nodeId || A.uuid(node) === selector.nodeId) && (!selector.name || node.name === selector.name) && (!selector.path || names.join('/') === selector.path);
    });
  }
  private component(node: RuntimeObject, type: string): RuntimeObject | undefined { return this.scene.components(node).find(row => this.scene.type(row) === type); }
  private geometry(node: RuntimeObject): JsonObject {
    const { cc, major } = this.scene.environment, canvas = A.object(cc.game).canvas as HTMLCanvasElement | undefined;
    const rect = canvas?.getBoundingClientRect?.();
    if (!canvas || !rect || !rect.width || !rect.height) throw new CocosError('CONTEXT_UNAVAILABLE', 'Canvas geometry is unavailable');
    let camera: RuntimeObject;
    if (major === 2) camera = A.object(A.call(cc.Camera, 'findCamera', node), 'node camera');
    else {
      let ancestor: RuntimeObject | undefined = node, canvasCamera: RuntimeObject | undefined;
      while (ancestor) {
        const canvasComponent = this.component(ancestor, 'cc.Canvas');
        if (canvasComponent?.cameraComponent) { canvasCamera = A.object(canvasComponent.cameraComponent); break; }
        ancestor = ancestor.parent as RuntimeObject | undefined;
      }
      const cameras = canvasCamera ? [canvasCamera] : this.scene.all().flatMap(row => this.scene.components(row)).filter(row => this.scene.type(row) === 'cc.Camera' && row.enabledInHierarchy !== false && !row.targetTexture && (Number(row.visibility) & Number(node.layer)) !== 0);
      if (cameras.length !== 1) throw new CocosError('AMBIGUOUS_TARGET', 'A unique public UI camera is required', { cameraCount: cameras.length });
      camera = cameras[0]!;
    }
    const transform = major === 3 ? this.component(node, 'cc.UITransform') : node;
    if (!transform) throw new CocosError('UNSUPPORTED_CAPABILITY', 'UITransform is unavailable');
    const size = major === 3 ? A.object(transform.contentSize) : node, anchor = major === 3 ? A.object(transform.anchorPoint) : { x: node.anchorX, y: node.anchorY };
    const width = Number(size.width), height = Number(size.height), ax = Number(anchor.x), ay = Number(anchor.y);
    if (![width, height, ax, ay].every(Number.isFinite) || width <= 0 || height <= 0) throw new CocosError('CONTEXT_UNAVAILABLE', 'Node has no positive UI bounds');
    const points = [[-width * ax, -height * ay], [width * (1 - ax), -height * ay], [-width * ax, height * (1 - ay)], [width * (1 - ax), height * (1 - ay)]].map(([x, y]) => {
      const local = A.construct(major === 2 ? cc.Vec2 : cc.Vec3, major === 2 ? [x, y] : [x, y, 0]);
      const world = A.call(transform, major === 2 ? 'convertToWorldSpaceAR' : 'convertToWorldSpaceAR', local);
      const screen = A.object(A.call(camera, major === 2 ? 'getWorldToScreenPoint' : 'worldToScreen', world));
      if (major === 3) return { x: rect.x + Number(screen.x) * rect.width / canvas.width, y: rect.y + rect.height - Number(screen.y) * rect.height / canvas.height };
      const view = A.object(cc.view), viewport = A.object(A.call(view, 'getViewportRect'));
      return { x: rect.x + (Number(viewport.x) + Number(screen.x) * Number(A.call(view, 'getScaleX'))) * rect.width / canvas.width,
        y: rect.y + rect.height - (Number(viewport.y) + Number(screen.y) * Number(A.call(view, 'getScaleY'))) * rect.height / canvas.height };
    });
    if (!points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) throw new CocosError('CONTEXT_UNAVAILABLE', 'Camera projection returned invalid coordinates');
    const left = Math.min(...points.map(point => point.x)), right = Math.max(...points.map(point => point.x)), top = Math.min(...points.map(point => point.y)), bottom = Math.max(...points.map(point => point.y));
    const point = { x: (left + right) / 2, y: (top + bottom) / 2 }, inside = right > rect.x && left < rect.right && bottom > rect.y && top < rect.bottom;
    const masks: string[] = []; let ancestor = node.parent as RuntimeObject | undefined;
    while (ancestor) { if (this.component(ancestor, 'cc.Mask')?.enabledInHierarchy !== false && this.component(ancestor, 'cc.Mask')) masks.push(A.uuid(ancestor)); ancestor = ancestor.parent as RuntimeObject | undefined; }
    const nativeHit = major === 3 && typeof transform.hitTest === 'function' ? Boolean(A.call(transform, 'hitTest', A.construct(cc.Vec2, [(point.x - rect.x) * canvas.width / rect.width, canvas.height - (point.y - rect.y) * canvas.height / rect.height]))) : null;
    return { point, coordinateSpace: 'window-css', projectedBounds: { left, right, top, bottom }, cameraId: A.uuid(camera), canvasRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      visible: node.activeInHierarchy !== false && inside && nativeHit !== false, clipped: left < rect.x || right > rect.right || top < rect.y || bottom > rect.bottom,
      nativeHitAtCenter: nativeHit, maskAncestors: masks, maskVisibilityVerified: major === 3 || masks.length === 0 };
  }
  private state(node: RuntimeObject): JsonObject {
    const button = this.component(node, 'cc.Button'), label = this.component(node, 'cc.Label') ?? this.component(node, 'cc.RichText');
    let geometry: JsonObject;
    try { geometry = this.geometry(node); } catch (error) { geometry = { visible: null, clipped: null, geometryError: CocosError.from(error).toJSON() as unknown as JsonValue }; }
    return { nodeId: A.uuid(node), name: String(node.name), active: Boolean(node.activeInHierarchy), text: typeof label?.string === 'string' ? label.string : null,
      interactable: button ? button.enabledInHierarchy !== false && button.interactable === true : null, ...geometry };
  }
  select(p: JsonObject): JsonObject {
    const nodes = this.nodes(p, Json.object(p.selector));
    if (nodes.length !== 1) throw new CocosError(nodes.length ? 'AMBIGUOUS_TARGET' : 'NOT_FOUND', 'UI selector must resolve exactly one node', { count: nodes.length, rows: nodes.map(node => ({ nodeId: A.uuid(node), name: String(node.name) })) });
    const target = this.state(nodes[0]!), point = target.point ? Json.object(target.point) : undefined;
    const candidates = point ? this.scene.all().filter(node => this.component(node, 'cc.Button') || this.component(node, 'cc.BlockInputEvents')).flatMap(node => {
      try { const state = this.state(node), bounds = Json.object(state.projectedBounds); return state.active && state.visible && Number(point.x) >= Number(bounds.left) && Number(point.x) <= Number(bounds.right) && Number(point.y) >= Number(bounds.top) && Number(point.y) <= Number(bounds.bottom) ? [{ nodeId: A.uuid(node), name: String(node.name) }] : []; }
      catch { return []; }
    }) : [];
    return { target, hitCandidates: candidates, uniqueInputCandidate: candidates.length === 1 && candidates[0]!.nodeId === target.nodeId,
      actualReceiverVerified: false, evidence: 'public-camera-projected-bounds-and-native-hit-where-available' };
  }
  check(p: JsonObject): JsonObject {
    const rows = (p.rows as JsonObject[]).map(check => {
      const matches = this.nodes(p, Json.object(check.selector)), state = matches.length === 1 ? this.state(matches[0]!) : null;
      const results = Object.entries(check).filter(([key]) => !['selector', 'optional'].includes(key)).map(([key, expected]) => {
        const actual = key === 'exists' ? matches.length > 0 : key === 'count' ? matches.length : state?.[key] ?? null;
        const status = check.optional === true && matches.length === 0 ? 'skipped' : actual === null ? 'unknown' : Json.canonical(actual) === Json.canonical(expected) ? 'passed' : 'failed';
        return { check: key, expected, actual, status };
      });
      return { selector: check.selector!, count: matches.length, target: state, rows: results, passed: results.every(row => ['passed', 'skipped'].includes(row.status)) };
    });
    return { rows, passed: rows.every(row => row.passed), actualReceiverVerified: false };
  }
}
