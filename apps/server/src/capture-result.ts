import type { CallToolResult } from '@modelcontextprotocol/server';
import { Json, type JsonObject, type JsonValue } from '../../../packages/contracts/src/index.js';

/** 截图工具返回标准 MCP image，客户端无需手动解码 JSON 中的 data URL。 */
export class CaptureResult {
  format(value: JsonValue): CallToolResult {
    const plain = (): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return plain();
    if (!['preview.capture', 'runtime.capture', 'runtime.shader.preview.capture'].includes(String(value.capabilityId))) return plain();
    const result = value.result;
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.dataUrl !== 'string') return plain();
    const matched = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(result.dataUrl);
    if (!matched) return plain();
    const summary: JsonObject = Json.object(Json.value(value));
    delete Json.object(summary.result).dataUrl;
    return { content: [{ type: 'text', text: JSON.stringify(summary) }, { type: 'image', data: matched[1]!, mimeType: 'image/png' }], structuredContent: value };
  }
}
