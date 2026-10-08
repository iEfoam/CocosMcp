import type { CallToolResult } from '@modelcontextprotocol/server';
import { Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';

/** 截图工具返回标准 MCP image，客户端无需手动解码 JSON 中的 data URL。 */
export class CaptureResult {
  format(value: JsonValue): CallToolResult {
    const plain = (): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return plain();
    if (!['preview.capture', 'preview.resize', 'preview.input', 'preview.validate_viewports', 'runtime.capture', 'runtime.shader.preview.capture'].includes(String(value.capabilityId))) return plain();
    const result = value.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return plain();
    const summary: JsonObject = Json.object(Json.value(value));
    const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
    const visit = (frame: JsonObject): void => {
      if (typeof frame.dataUrl === 'string') {
        const matched = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(frame.dataUrl);
        if (matched) { delete frame.dataUrl; images.push({ type: 'image', data: matched[1]!, mimeType: 'image/png' }); }
      }
      if (Array.isArray(frame.rows)) for (const row of frame.rows) if (row && typeof row === 'object' && !Array.isArray(row)) visit(row);
    };
    visit(Json.object(summary.result));
    if (!images.length) return plain();
    // 默认只传一份图片；旧客户端可显式请求 legacy-json 保留 structuredContent.dataUrl。
    return { content: [{ type: 'text', text: JSON.stringify(summary) }, ...images], structuredContent: result.imageDelivery === 'legacy-json' ? value : summary };
  }
}
