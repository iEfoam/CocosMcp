export class CreatorAccount {
  constructor(localHome?: string);
  prepare(project: string, major: 2 | 3): Promise<{ home: string; account: string; nextAction?: string }>;
  local(major: 2 | 3): Promise<{ account: string }>;
  existing(project: string): Promise<{ instanceId: string; creatorMajor: number; status: string } | null>;
}
