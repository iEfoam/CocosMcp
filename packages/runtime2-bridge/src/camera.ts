import { CocosError, Json, type JsonObject } from '../../contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../runtime3-bridge/src/scene.js';

export class Creator2Camera {
  constructor(private readonly inspector: SceneInspector) {}
  private camera(p: JsonObject): RuntimeObject {
    const camera = this.inspector.component(Json.string(p.componentId, 'componentId'));
    if (this.inspector.type(camera) !== 'cc.Camera') throw new CocosError('INVALID_ARGUMENT', 'Expected cc.Camera');
    return camera;
  }
  inspect(p: JsonObject): JsonObject {
    const camera = this.camera(p), node = A.object(camera.node), cc = this.inspector.environment.cc;
    const target = camera.targetTexture ? A.object(camera.targetTexture) : null;
    return { componentId: A.uuid(camera), nodeId: A.uuid(node), enabled: Boolean(camera.enabled), active: Boolean(node.activeInHierarchy),
      is3D: Boolean(node.is3DNode), alignWithScreen: A.safeData(camera.alignWithScreen), depth: A.safeData(camera.depth), zoomRatio: A.safeData(camera.zoomRatio), ortho: A.safeData(camera.ortho),
      nearClip: A.safeData(camera.nearClip), farClip: A.safeData(camera.farClip), cullingMask: Number(camera.cullingMask) >>> 0,
      rect: A.safeData(camera.rect), clearFlags: A.safeData(camera.clearFlags), backgroundColor: A.safeData(camera.backgroundColor),
      visibleRect: { width: A.safeData(A.object(cc.visibleRect).width), height: A.safeData(A.object(cc.visibleRect).height), center: A.safeData(A.object(cc.visibleRect).center) },
      targetTexture: target ? { uuid: A.uuid(target), width: A.safeData(target.width), height: A.safeData(target.height), valid: target.isValid !== false } : null,
      limitations: ['屏幕坐标沿用原生 visibleRect 坐标系，不等于浏览器 CSS 像素或截图像素', '状态查询不证明最终可见性、遮挡或像素输出'] };
  }
  convert(p: JsonObject): JsonObject {
    const camera = this.camera(p), cc = this.inspector.environment.cc;
    const is3D = Boolean(A.object(camera.node).is3DNode);
    if (!is3D && camera.alignWithScreen !== true) throw new CocosError('UNSUPPORTED_CAPABILITY', '2D conversion requires alignWithScreen');
    if (is3D && camera.alignWithScreen !== false) throw new CocosError('UNSUPPORTED_CAPABILITY', '3D conversion requires an explicit non-screen-aligned projection');
    if (typeof camera.zoomRatio !== 'number' || !Number.isFinite(camera.zoomRatio) || camera.zoomRatio <= 0) throw new CocosError('CONTEXT_UNAVAILABLE', 'Camera zoom must be positive and finite');
    const point = Json.object(p.point);
    if (!['world-to-screen', 'screen-to-world'].includes(String(p.direction)) || ![point.x, point.y].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000000)) throw new CocosError('INVALID_ARGUMENT', 'Expected a finite 2D point and explicit conversion direction');
    let depth = point.z;
    if (is3D) {
      if (typeof depth !== 'number' || !Number.isFinite(depth) || Math.abs(depth) > 10000000) throw new CocosError('INVALID_ARGUMENT', '3D conversion requires finite z');
      const near = Number(camera.nearClip), far = Number(camera.farClip), rect = A.object(camera.rect);
      if (!(near > 0 && far > near && Number.isFinite(far) && Number(rect.width) > 0 && Number(rect.height) > 0)) throw new CocosError('CONTEXT_UNAVAILABLE', 'Invalid camera clipping planes or viewport');
      if (p.direction === 'screen-to-world') {
        if (depth < 0 || depth > 1) throw new CocosError('INVALID_ARGUMENT', 'Screen projection depth must be in 0..1');
        if (!camera.ortho) {
          // 原生透视反投影先反变换 NDC z=0.9999，再做线性插值；转换输入以匹配 worldToScreen 的投影深度。
          const distance = near * far / (far - depth * (far - near));
          const referenceDistance = 2 * near * far / (far + near - 0.9999 * (far - near));
          depth = (distance / referenceDistance - near / far) / (1 - near / far);
        }
      }
    }
    const nativePoint = A.construct(is3D ? cc.Vec3 : cc.Vec2, is3D ? [point.x, point.y, depth] : [point.x, point.y]);
    const value = A.object(A.call(camera, p.direction === 'world-to-screen' ? 'getWorldToScreenPoint' : 'getScreenToWorldPoint', nativePoint));
    if (!(is3D ? [value.x, value.y, value.z] : [value.x, value.y]).every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))) throw new CocosError('VERIFICATION_FAILED', 'Camera returned non-finite coordinates');
    return { componentId: A.uuid(camera), direction: p.direction!, point: { x: Number(value.x), y: Number(value.y), ...(is3D ? { z: Number(value.z) } : {}) }, dimension: is3D ? 3 : 2, coordinateSpace: 'native-visibleRect', pixelVerified: false,
      ...(is3D ? { screenDepthEncoding: 'projection-depth-0-to-1', projection: camera.ortho ? 'orthographic' : 'perspective' } : {}) };
  }
  culling(p: JsonObject): JsonObject {
    const camera = this.camera(p), node = this.inspector.node(Json.string(p.nodeId, 'nodeId'));
    const groupIndex = Number(node.groupIndex);
    if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > 31) throw new CocosError('VERIFICATION_FAILED', 'Invalid native node group index');
    const cullingMask = Number(camera.cullingMask) >>> 0;
    // 2.4.15 containsNode 使用 >0 判断有符号位运算；第 31 组需独立报告位掩码匹配。
    const maskMatches = (cullingMask & (1 << groupIndex)) !== 0;
    return { componentId: A.uuid(camera), nodeId: A.uuid(node), groupIndex, cullingMask, maskMatches,
      nativeContainsNode: Boolean(A.call(camera, 'containsNode', node)), visible: null,
      limitations: ['仅检查节点分组与相机掩码；不代表在视锥内、不被 Mask 遮挡或实际产生像素'] };
  }
  samplePixels(p: JsonObject): JsonObject {
    const camera = this.camera(p), cc = this.inspector.environment.cc, node = A.object(camera.node);
    const width = Number(p.width), height = Number(p.height), points = p.points;
    if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 512) || !Array.isArray(points) || points.length < 1 || points.length > 64) throw new CocosError('INVALID_ARGUMENT', 'Expected 1..512 texture dimensions and 1..64 pixel coordinates');
    const coordinates = points.map(raw => { const point = Json.object(raw); if (!Number.isInteger(point.x) || !Number.isInteger(point.y) || Number(point.x) < 0 || Number(point.x) >= width || Number(point.y) < 0 || Number(point.y) >= height) throw new CocosError('INVALID_ARGUMENT', 'Pixel coordinate is outside render texture'); return { x: Number(point.x), y: Number(point.y) }; });
    if (node.is3DNode || camera.alignWithScreen !== true) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Pixel sampling currently requires a screen-aligned 2D camera');
    const gl = A.object(A.object(cc.game)._renderContext);
    if (!['readPixels', 'isTexture', 'isFramebuffer', 'isRenderbuffer', 'isContextLost'].every(method => typeof gl[method] === 'function') || typeof gl.DEPTH_STENCIL !== 'number') throw new CocosError('UNSUPPORTED_CAPABILITY', 'Pixel sampling requires WebGL depth/stencil and object validation support');
    if (A.call(gl, 'isContextLost')) throw new CocosError('CONTEXT_UNAVAILABLE', 'WebGL context is lost');
    const root = p.rootId === undefined ? this.inspector.current() : this.inspector.node(Json.string(p.rootId, 'rootId'));
    const originalTarget = camera.targetTexture, position = { x: node.x, y: node.y, z: node.z }, angle = node.angle;
    const texture = A.object(A.construct(cc.RenderTexture, []));
    const rows: JsonObject[] = [];
    const handles: Array<{ method: string; handle: unknown }> = [];
    try {
      // 2.4.15 gfx.RB_FMT_D24S8 与 WebGL DEPTH_STENCIL 同值，保证 Mask 有独立模板缓冲。
      A.call(texture, 'initWithSize', width, height, gl.DEPTH_STENCIL);
      for (const [property, method] of [['_texture', 'isTexture'], ['_framebuffer', 'isFramebuffer'], ['_depthStencilBuffer', 'isRenderbuffer']] as const) {
        const handle = A.object(texture[property])._glID;
        if (!handle) throw new CocosError('VERIFICATION_FAILED', `Missing native ${property} handle`);
        handles.push({ method, handle });
      }
      camera.targetTexture = texture; A.call(camera, 'render', root);
      if (handles.some(({ method, handle }) => !A.call(gl, method, handle))) throw new CocosError('VERIFICATION_FAILED', 'Offscreen GPU objects are not live after rendering');
      for (const point of coordinates) {
        const pixels = new Uint8Array(4);
        const read = A.call(texture, 'readPixels', pixels, point.x, point.y, 1, 1);
        if (read !== pixels) throw new CocosError('VERIFICATION_FAILED', 'Native pixel read did not return the supplied buffer');
        rows.push({ ...point, rgba: Array.from(pixels) });
      }
    } finally {
      const failures: string[] = [];
      try { camera.targetTexture = originalTarget; A.call(camera, 'beforeDraw'); }
      catch (error) { failures.push(CocosError.from(error).message); }
      try { A.call(node, 'setPosition', position.x, position.y, position.z); node.angle = angle; }
      catch (error) { failures.push(CocosError.from(error).message); }
      try { A.call(texture, 'destroy'); } catch (error) { failures.push(CocosError.from(error).message); }
      // 原生 RenderTexture.destroy 释放纹理和 FBO，却不释放其深度模板 RenderBuffer。
      try { if (texture._depthStencilBuffer) { A.call(texture._depthStencilBuffer, 'destroy'); texture._depthStencilBuffer = null; } }
      catch (error) { failures.push(CocosError.from(error).message); }
      try {
        // 上下文丢失会让所有 is* 都返回 false，不能把它当成成功释放的证据。
        if (A.call(gl, 'isContextLost')) failures.push('WebGL context lost during cleanup verification');
        else for (const { method, handle } of handles) if (A.call(gl, method, handle)) failures.push(`${method} reports a surviving temporary GPU object`);
      } catch (error) { failures.push(CocosError.from(error).message); }
      if (failures.length) throw new CocosError('OUTCOME_UNKNOWN', 'Offscreen sampling cleanup failed', { failures });
    }
    return { rows, width, height, format: 'RGBA8', origin: 'bottom-left', scope: 'temporary-offscreen-render', targetRestored: camera.targetTexture === originalTarget, temporaryResourcesDestroyed: true, gpuObjectDeletionVerified: true,
      limitations: ['采样来自一次手动离屏渲染，不代表浏览器合成截图或驱动显存测量', '仅返回指定像素；未采样区域不能据此判定'] };
  }
}
