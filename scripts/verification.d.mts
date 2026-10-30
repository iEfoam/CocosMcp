import type { JsonObject } from '../packages/contracts/src/index.js';
export class VerificationBuild {
  recordPath: string;
  attemptPath: string;
  fingerprint(): Promise<string>;
  clear(): Promise<void>;
  definitions(): Promise<Record<string, string>>;
  verifiedRecords(root?: string): Promise<JsonObject[]>;
  attempt(before: string, sources: string[], reportPath: string, exitCode: number): Promise<void>;
  overview(fingerprint: string, root?: string): Promise<JsonObject>;
  record(before: string, sources: string[], reportPath: string): Promise<void>;
}
