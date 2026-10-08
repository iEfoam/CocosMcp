import { createHash, randomBytes } from 'crypto';
import type { JsonObject } from '../../../packages/contracts/src/index.js';

export interface PreviewImage { isEmpty(): boolean; toDataURL(): string; getSize(): { width: number; height: number }; toBitmap?(): Buffer }

export class CaptureEvidence {
  summarize(image: PreviewImage): JsonObject {
    const dataUrl = image.toDataURL(), bytes = Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
    const logicalSize = image.getSize();
    const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const size = png ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : logicalSize;
    let pixelDiagnostic: JsonObject = { status: 'unknown', reason: 'bitmap-sampling-unavailable' };
    try { if (image.toBitmap) {
      const bitmap = image.toBitmap(), stride = Math.max(1, Math.floor(bitmap.length / 4 / 4096));
      let samples = 0, transparent = 0; const colors = new Set<string>();
      for (let i = 0; i + 3 < bitmap.length; i += stride * 4) {
        samples++; if (bitmap[i + 3] === 0) transparent++;
        colors.add(bitmap.subarray(i, i + 4).toString('hex'));
      }
      pixelDiagnostic = { status: samples ? 'sampled' : 'unknown', samples, uniqueColors: colors.size, allTransparent: samples > 0 && transparent === samples, monochrome: samples > 0 && colors.size === 1,
        interpretation: 'Color sampling is diagnostic evidence; black or monochrome scenes may be valid' };
    } } catch { pixelDiagnostic = { status: 'unknown', reason: 'bitmap-sampling-failed' }; }
    return { captureId: randomBytes(16).toString('hex'), dataUrl, ...size, capturedAt: new Date().toISOString(),
      image: { mimeType: 'image/png', ...size, dimensionsSource: png ? 'png-header' : 'native-image', logicalSize, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, pixelDiagnostic };
  }
}
