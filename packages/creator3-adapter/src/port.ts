import type { JsonValue } from '../../contracts/src/index.js';

export interface EditorPort {
  version: string;
  projectPath: string;
  extensionName: string;
  request(channel: string, message: string, ...args: unknown[]): Promise<unknown>;
  scene(method: string, ...args: unknown[]): Promise<unknown>;
  selection(type: string, ids?: string[]): string[];
  getSetting(name: string, key?: string): Promise<unknown>;
  setSetting(name: string, key: string, value: JsonValue): Promise<void>;
  messages(packageName?: string): Array<{ package: string; message: string; public: boolean }>;
  preview?(method: string, params: import('../../contracts/src/index.js').JsonObject): Promise<JsonValue>;
  disposePreview?(): void;
  consoleAvailable?: boolean;
  consoleQuery?(params: import('../../contracts/src/index.js').JsonObject): Promise<JsonValue>;
  shader?(method: string, params: import('../../contracts/src/index.js').JsonObject): Promise<JsonValue>;
}
