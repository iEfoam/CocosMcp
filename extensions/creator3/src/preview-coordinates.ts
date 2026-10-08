import { CocosError, Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';

export class PreviewCoordinates {
  imageObservation(capture: JsonObject | undefined, captureId: JsonValue | undefined, observation: JsonObject, windowSize: number[]): JsonObject {
    if (!capture || captureId !== capture.captureId || capture.sceneGeneration !== observation.sceneGeneration || Json.canonical(capture.windowContentSize ?? null) !== Json.canonical(windowSize)) throw new CocosError('STALE_HANDLE', 'Image coordinates require the current captureId, scene generation and window geometry');
    for (const key of ['canvasRect', 'canvasPixelSize', 'designResolution', 'engineViewportRect', 'engineScale']) {
      if (Json.canonical(capture[key] ?? null) !== Json.canonical(observation[key] ?? null)) throw new CocosError('STALE_HANDLE', 'Canvas geometry changed after the reference capture');
    }
    return { ...observation, imageSize: { width: capture.width!, height: capture.height! } };
  }

  point(x: number, y: number, space: string, observation: JsonObject, windowSize: number[]): { x: number; y: number } {
    if (![x, y].every(value => Number.isFinite(value) && value >= 0)) throw new CocosError('INVALID_ARGUMENT', 'Input coordinates must be nonnegative finite numbers');
    if (windowSize.length !== 2 || !windowSize.every(value => Number.isFinite(value) && value > 0)) throw new CocosError('CONTEXT_UNAVAILABLE', 'Window content dimensions unavailable');
    let result = { x, y };
    let canvasRect: JsonObject | undefined;
    if (space !== 'window-css') {
      const rect = Json.object(observation.canvasRect, 'Canvas geometry');
      canvasRect = rect;
      if (![rect.x, rect.y, rect.width, rect.height].every(value => typeof value === 'number' && Number.isFinite(value)) || !(Number(rect.width) > 0 && Number(rect.height) > 0)) throw new CocosError('CONTEXT_UNAVAILABLE', 'Canvas geometry unavailable');
      if (space === 'canvas-css') result = { x: Number(rect.x) + x, y: Number(rect.y) + y };
      else if (space === 'design-top-left') {
        const design = Json.object(observation.designResolution, 'Design resolution');
        if (![Number(design.width), Number(design.height)].every(value => Number.isFinite(value) && value > 0)) throw new CocosError('CONTEXT_UNAVAILABLE', 'Design resolution unavailable');
        if (x >= Number(design.width) || y >= Number(design.height)) throw new CocosError('INVALID_ARGUMENT', 'Input coordinates must be inside the design resolution');
        const pixels = Json.object(observation.canvasPixelSize, 'Canvas pixel size'), viewport = Json.object(observation.engineViewportRect, 'Engine viewport'), scale = Json.object(observation.engineScale, 'Engine scale');
        if (![Number(pixels.width), Number(pixels.height), Number(scale.x), Number(scale.y)].every(value => Number.isFinite(value) && value > 0) || ![viewport.x, viewport.y].every(value => typeof value === 'number' && Number.isFinite(value))) throw new CocosError('CONTEXT_UNAVAILABLE', 'Actual engine coordinate transform unavailable');
        // 原生 viewport 的 y 从缓冲底部计算；显式设计坐标使用左上原点，并保留项目自身适配策略。
        result = { x: Number(rect.x) + (Number(viewport.x) + x * Number(scale.x)) * Number(rect.width) / Number(pixels.width),
          y: Number(rect.y) + (Number(pixels.height) - Number(viewport.y) - Number(design.height) * Number(scale.y) + y * Number(scale.y)) * Number(rect.height) / Number(pixels.height) };
      } else if (space === 'image-pixels') {
        const image = Json.object(observation.imageSize, 'Captured image dimensions');
        if (![Number(image.width), Number(image.height)].every(value => Number.isFinite(value) && value > 0)) throw new CocosError('CONTEXT_UNAVAILABLE', 'Captured image dimensions unavailable');
        result = { x: x * windowSize[0]! / Number(image.width), y: y * windowSize[1]! / Number(image.height) };
      } else throw new CocosError('INVALID_ARGUMENT', 'Unknown input coordinate space');
      if (result.x < Number(rect.x) || result.y < Number(rect.y) || result.x >= Number(rect.x) + Number(rect.width) || result.y >= Number(rect.y) + Number(rect.height)) throw new CocosError('INVALID_ARGUMENT', 'Input coordinates must be inside the Canvas area');
    }
    result = { x: Math.round(result.x), y: Math.round(result.y) };
    if (![result.x, result.y].every(value => Number.isFinite(value) && value >= 0) || result.x >= windowSize[0]! || result.y >= windowSize[1]!) throw new CocosError('INVALID_ARGUMENT', 'Input coordinates must be inside the preview content area');
    if (canvasRect && (result.x < Number(canvasRect.x) || result.y < Number(canvasRect.y) || result.x >= Number(canvasRect.x) + Number(canvasRect.width) || result.y >= Number(canvasRect.y) + Number(canvasRect.height))) throw new CocosError('INVALID_ARGUMENT', 'Rounded input coordinates must be inside the Canvas area');
    return result;
  }
  orientation(width: number, height: number, expected: unknown): string {
    const actual = width === height ? 'square' : width > height ? 'landscape' : 'portrait';
    if (expected !== undefined && expected !== actual) throw new CocosError('INVALID_ARGUMENT', 'Requested viewport orientation does not match dimensions');
    return actual;
  }
}
