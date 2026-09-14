import type { BridgeDescriptor, CreatorMajor, JsonObject } from '../../contracts/src/index.js';

/** 面板仅接收展示信息；桥接 token 始终留在扩展主进程。 */
export interface PanelState {
  extension?: { version: string; buildId: string; installedVersion: string; installedBuildId: string; reloadRequired: boolean; updating: boolean; message: string | null; latestVersion?: string; checking?: boolean };
  projectPath: string;
  editorVersion: string;
  creatorMajor: CreatorMajor;
  instance: Omit<BridgeDescriptor, 'token'> | null;
  supportedCapabilities: string[];
  logs: JsonObject[];
  service?: { status: 'stopped' | 'starting' | 'running' | 'error'; endpoint: string | null; error: string | null };
  runtimeConfigured: boolean;
  runtimeStatus?: { connected: number; error: string | null };

}
