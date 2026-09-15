import { RuntimeController } from './index.js';
import { CocosError, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess, type RuntimeObject } from './access.js';

export interface RuntimeConnectionOptions { url: string; token: string; projectId: string; cc: RuntimeObject; major: 2 | 3; development: boolean }
interface XhrLike {
  status: number; responseText: string; timeout: number;
  onload: (() => void) | null; onerror: (() => void) | null; ontimeout: (() => void) | null;
  open(method: string, url: string, async: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body: string): void;
}
declare const XMLHttpRequest: new () => XhrLike;

export class DevelopmentConnection {
  private active = false;
  private runtimeInstanceId = '';
  private readonly controller: RuntimeController;
  constructor(private readonly options: RuntimeConnectionOptions) {
    if (!options.development) throw new CocosError('UNAUTHORIZED', 'Runtime bridge must only be enabled in a development build');
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(options.url)) throw new CocosError('INVALID_ARGUMENT', 'Default runtime bridge requires a loopback URL');
    this.controller = new RuntimeController({ cc: options.cc, major: options.major });
  }

  private request(path: string, body: JsonObject): Promise<JsonObject> {
    return new Promise((accept, reject) => {
      const request = new XMLHttpRequest(); request.open('POST', `${this.options.url.replace(/\/$/, '')}${path}`, true); request.timeout = 15_000;
      request.setRequestHeader('content-type', 'application/json'); request.setRequestHeader('authorization', `Bearer ${this.options.token}`);
      request.onload = () => {
        try {
          const result = JSON.parse(request.responseText) as JsonObject;
          if (request.status < 200 || request.status >= 300) reject(new Error(`Gateway ${request.status}: ${request.responseText}`)); else accept(result);
        } catch (error) { reject(error); }
      };
      request.onerror = () => reject(new Error('Runtime gateway connection failed'));
      request.ontimeout = () => reject(new Error('Runtime gateway request timed out'));
      request.send(JSON.stringify({ ...body, projectId: this.options.projectId }));
    });
  }

  async start(): Promise<void> {
    if (this.active) return;
    const registered = await this.request('/runtime/register', { version: RuntimeAccess.engineVersion(this.options.cc), platform: 'development-runtime' });
    this.runtimeInstanceId = String(registered.runtimeInstanceId); this.active = true;
    void this.poll();
  }

  private async poll(): Promise<void> {
    while (this.active) {
      try {
        const response = await this.request('/runtime/poll', { runtimeInstanceId: this.runtimeInstanceId });
        if (!this.active) break;
        const command = response.command as JsonObject | null;
        if (!command) continue;
        let result: JsonValue = null; let error: JsonValue = null;
        try { result = await this.controller.execute(String(command.capabilityId), command.params as JsonObject); }
        catch (failure) { error = JSON.parse(JSON.stringify(CocosError.from(failure, 'RUNTIME_ERROR').toJSON())) as JsonValue; }
        await this.request('/runtime/reply', { runtimeInstanceId: this.runtimeInstanceId, commandId: command.id!, result, error });
      } catch (error) {
        this.controller.connectionLost();
        if (this.active) { console.warn('[CocosMCP runtime]', error); await new Promise(accept => setTimeout(accept, 2000)); }
      }
    }
  }

  async stop(): Promise<void> {
    this.active = false; this.controller.dispose();
    if (this.runtimeInstanceId) await this.request('/runtime/disconnect', { runtimeInstanceId: this.runtimeInstanceId });
  }
}

export class CocosMCP {
  static async connect(options: RuntimeConnectionOptions): Promise<DevelopmentConnection> { const connection = new DevelopmentConnection(options); await connection.start(); return connection; }
}
