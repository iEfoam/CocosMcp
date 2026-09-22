import { createServer, type Server } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { timingSafeEqual } from 'node:crypto';
import type { CocosMcpServer } from './mcp.js';

export class McpTransport {
  private stdio: StdioServerHandle | undefined;
  private http: Server | undefined;
  private handler: ReturnType<typeof createMcpHandler> | undefined;

  startStdio(factory: CocosMcpServer): void {
    this.stdio = serveStdio(() => factory.create(), { onerror: error => console.error('[MCP]', error.message) });
  }

  async startHttp(factory: CocosMcpServer, port: number, token: string): Promise<number> {
    this.handler = createMcpHandler(() => factory.create(), { legacy: 'stateless', onerror: error => console.error('[MCP]', error.message) });
    const handler = toNodeHandler(this.handler);
    this.http = createServer((request, response) => {
      const deny = (status: number, message: string): void => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: message })); };
      try {
        const host = new URL(`http://${request.headers.host ?? ''}`).hostname;
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { deny(403, 'Invalid Host'); return; }
        if (request.headers.origin) {
          const origin = new URL(request.headers.origin);
          if (!['http:', 'https:'].includes(origin.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) { deny(403, 'Invalid Origin'); return; }
        }
        if (request.method !== 'POST') { deny(405, 'MCP endpoint requires POST'); return; }
        const contentType = request.headers['content-type'] ?? '';
        if (!contentType.toLowerCase().startsWith('application/json')) { deny(415, 'Content-Type must be application/json'); return; }
        const contentLength = request.headers['content-length'];
        if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > 8 * 1024 * 1024)) { deny(413, 'MCP request body exceeds 8 MB'); return; }
        const actual = Buffer.from(request.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${token}`);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { deny(401, 'Bearer token required'); return; }
        if (request.url !== '/mcp') { deny(404, 'Use /mcp'); return; }
        void handler(request as Parameters<typeof handler>[0], response).catch(error => { if (!response.headersSent) deny(500, String(error)); else response.destroy(); });
      } catch { deny(400, 'Invalid request'); }
    });
    const server = this.http;
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('MCP listener unavailable');
    return address.port;
  }

  async close(): Promise<void> {
    await this.stdio?.close();
    if (this.http) { this.http.closeAllConnections(); await new Promise<void>((accept, reject) => this.http!.close(error => error ? reject(error) : accept())); }
    await this.handler?.close();
  }
}
