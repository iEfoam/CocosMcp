export interface TemporaryReceipt { directory: string; owner: { version: number; taskId: string; kind: string; purpose: string; pid: number; createdAtUTC: string; state: string; retentionReason: string; recyclable: boolean; finishedAtUTC?: string }; dev: number; ino: number }
export class WorkspaceStorage {
  constructor(root: string, probe?: (directory: string) => Promise<{ clear: boolean; reason: string }>);
  static openReferences(directory: string): Promise<{ clear: boolean; reason: string }>;
  workDirectory(relative: string): Promise<string>;
  createTestRun(): Promise<TemporaryReceipt>;
  createBuildRun(jobId: string): Promise<TemporaryReceipt>;
  verify(receipt: TemporaryReceipt): Promise<void>;
  finish(receipt: TemporaryReceipt, succeeded: boolean): Promise<void>;
  cleanup(receipt: TemporaryReceipt): Promise<{ removed: boolean; reason: string }>;
  inventory(maxEntries?: number): Promise<{ createdAtUTC: string; root: string; visited: number; maxEntries: number; rows: Array<{ path: string; category: string; complete: boolean; logicalBytes?: number; allocatedBytes?: number; owner?: { taskId: string | null; state: string; processState: string } | null; retentionReason: string; canDelete: false }>; limitations: string[] }>;
}
