export interface CreatorInstance {
  instanceId: string; creatorMajor: number; pid: number;
  status: 'existing-editor-reused' | 'existing-editor-login-required' | 'existing-editor-present-unverified';
  loginState: 'logged-in' | 'logged-out' | 'unknown';
}
export type ExistingCreator = CreatorInstance | { status: 'existing-editor-ambiguous' | 'existing-editor-mismatch'; loginState: 'unknown'; rows: CreatorInstance[] };
export class CreatorAccount {
  constructor(localHome?: string);
  prepare(project: string, major: 2 | 3): Promise<{ home: string; account: string; nextAction?: string; credentialFingerprint?: string; backupPath?: string; refreshDeferred?: string; validation?: string }>;
  local(major: 2 | 3): Promise<{ account: string }>;
  processState(pid: number): Promise<'creator' | 'other' | 'unknown'>;
  existing(project: string, options?: { major?: 2 | 3; instanceId?: string }): Promise<ExistingCreator | null>;
}
