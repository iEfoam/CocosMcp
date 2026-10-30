import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { CreatorAccount } from './creator-account.mjs';
export class CreatorLauncher {
  constructor(account?: CreatorAccount, options?: { timeoutMs?: number; pollMs?: number });
  alive(pid: number): boolean;
  spawnEditor(executable: string, args: string[], options: SpawnOptions): ChildProcess;
  plan(project: string, executable: string, major: 2 | 3): Promise<{ project: string; executable: string; major: number; home: string; userData: string; args: string[] }>;
  launch(project: string, executable: string, major: 2 | 3, options?: { instanceId?: string }): Promise<Record<string, unknown>>;
}
