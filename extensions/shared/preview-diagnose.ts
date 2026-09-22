import type { JsonObject } from '../../packages/contracts/src/index.js';

export class PreviewDiagnosis {
  summarize(result: JsonObject): JsonObject {
    const rows = (Array.isArray(result.rows) ? result.rows : []) as JsonObject[];
    const findings: JsonObject[] = [];
    const evidence = (code: string, message: string, matching: JsonObject[]): void => { if (matching.length) findings.push({ code, message, sequences: matching.map(row => row.sequence ?? null) }); };
    evidence('HTTP_ERROR_STATUS', '观察到 HTTP 错误状态码；是否为身份验证失败须结合业务响应', rows.filter(row => row.kind === 'http-error'));
    evidence('CORS_BLOCKED', '浏览器报告 CORS 阻止响应读取', rows.filter(row => row.corsError));
    evidence('NETWORK_FAILURE', '浏览器报告请求失败；不能仅凭 ERR_FAILED 判断为 CORS', rows.filter(row => row.kind === 'network-failure' && !row.corsError));
    evidence('CLIENT_ERROR', '观察到客户端错误；是否涉及响应解析或场景切换须结合堆栈和运行时状态', rows.filter(row => ['error', 'unhandledrejection'].includes(String(row.kind)) || row.kind === 'console' && row.level === 'error'));
    evidence('WEBSOCKET_FAILURE', '观察到 WebSocket 握手或帧错误', rows.filter(row => row.kind === 'websocket-error' || row.kind === 'websocket-handshake' && row.status !== 101));
    const connected = rows.filter(row => row.kind === 'websocket-handshake' && row.status === 101);
    for (const connection of connected) {
      const frames = rows.filter(row => row.kind === 'websocket-frame' && row.requestId === connection.requestId && row.frameType !== 'control');
      const sent = frames.filter(row => row.direction === 'sent');
      if (sent.length && !frames.some(row => row.direction === 'received')) evidence('WEBSOCKET_NO_RESPONSE_OBSERVED', '连接成功并发送数据帧，但本观察区间未收到数据帧；不能据此断言协议不兼容', [connection, ...sent]);
    }
    if (!rows.some(row => ['http-request', 'http-response', 'http-error', 'websocket-frame'].includes(String(row.kind)))) findings.push({ code: 'NO_REQUEST_OBSERVED', message: '本观察区间未捕捉到请求；不能证明点击未发生或未触发业务行为' });
    const incomplete = result.hasMore === true || rows.some(row => row.kind === 'capture-gap') || Number(result.droppedBefore) > 0 || result.connection !== 'connected';
    return { ...result, findings, evidenceComplete: !incomplete, diagnosis: 'evidence-only', applicationProtocol: 'unknown', limitations: ['时间关联不证明业务因果关系', '完整时间线需读取所有游标分页；未收到帧不同于应用层握手超时'] };
  }
}
