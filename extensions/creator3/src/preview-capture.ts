import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';
import { PreviewObserver } from './preview-observer.js';
import { CaptureEvidence } from './capture-evidence.js';
import type { PreviewWindow } from './preview.js';

interface PreviewCaptureHost {
  current(window: PreviewWindow): boolean;
  inspect(window: PreviewWindow, params?: JsonObject): Promise<JsonObject>;
  observe(frame: JsonObject, params: JsonObject): JsonObject;
  bounded<T>(task: Promise<T>, milliseconds: number): Promise<T>;
  engineReadySource(): string;
  rendered(): void;
  diagnostics(): JsonObject[];
}

/** 截图缓存与帧证据共同失效；窗口所有权和场景观察仍由预览会话管理。 */
export class ManagedPreviewCapture {
  private latest: JsonObject | undefined;
  constructor(private readonly host: PreviewCaptureHost) {}
  get last(): JsonObject | undefined { return this.latest; }
  reset(): void { this.latest = undefined; }
  async execute(window: PreviewWindow, params: JsonObject): Promise<JsonObject> {
    if (params.frameMode === 'lastFrame') {
      const current = await this.host.inspect(window, params);
      if (!this.latest || this.latest.sceneGeneration !== current.sceneGeneration) throw new CocosError('CONTEXT_UNAVAILABLE', 'No captured frame exists in the current scene generation');
      return { ...this.latest, stale: true, freshness: 'explicit-last-frame', imageDelivery: params.imageDelivery ?? 'image' };
    }
    // 等待引擎实际完成一帧，而不是把页面加载或 Canvas 存在误当作场景已经渲染。
    const frame = await this.host.bounded(window.webContents.executeJavaScript(`(async () => {
      ${this.host.engineReadySource()}
      ${new PreviewObserver().source()}
      return new Promise(resolve => {
        const timer=setTimeout(() => {cc.director.off(cc.Director.EVENT_AFTER_DRAW, done);resolve({...read(),ready:false, reason:'frame-timeout'});},5000);
        function done(){clearTimeout(timer);resolve(read());}
        cc.director.once(cc.Director.EVENT_AFTER_DRAW,done);
      });
    })()`), 18000);
    if (!frame || typeof frame !== 'object' || (frame as { ready?: boolean }).ready !== true) throw new CocosError('CONTEXT_UNAVAILABLE', 'Preview has not rendered a game frame', frame as JsonValue);
    if (!this.host.current(window) || window.isDestroyed()) throw new CocosError('STALE_HANDLE', 'Managed preview session changed during capture');
    const observed = this.host.observe(Json.object(frame), params);
    this.host.rendered();
    const image = await window.webContents.capturePage();
    const current = await this.host.inspect(window);
    if (current.sceneGeneration !== observed.sceneGeneration) throw new CocosError('STALE_HANDLE', 'Scene changed during window capture; image discarded', { before: observed.sceneGeneration!, after: current.sceneGeneration! });
    if (image.isEmpty()) throw new CocosError('VERIFICATION_FAILED', 'Preview capture returned an empty image');
    const capture = { ...new CaptureEvidence().summarize(image), ...observed, windowContentSize: window.getContentSize?.() ?? null, stale: false, source: 'managed-preview-window',
      imageDelivery: params.imageDelivery ?? 'image',
      frameBinding: 'draw-observed-before-composite', frameIndexAfterCapture: current.frameIndex ?? null, exactPixelFrameIndex: null,
      verification: 'rendered-frame-captured', businessOutcomeVerified: false, layoutVerified: false,
      checks: [{ check: 'image-nonempty', status: 'passed' }, { check: 'frame-drawn', status: 'passed' }, { check: 'expected-layout', status: 'unknown' }], rows: this.host.diagnostics().slice(-50) };
    this.latest = capture;
    return capture;
  }
}
