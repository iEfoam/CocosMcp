export class BuildPlan {
  constructor(args?: string[]);
  readonly profile: 'dev' | 'native' | 'release';
  readonly majors: number[];
  readonly targets: string[];
  readonly output: string;
  includes(target: string): boolean;
  static assertRelease(profile: unknown, fingerprint: string): void;
}
