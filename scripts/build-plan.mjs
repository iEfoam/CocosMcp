export class BuildPlan {
  constructor(args = []) {
    const options = new Map();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i], value = args[i + 1];
      if (!['--profile', '--major', '--targets'].includes(key) || !value || value.startsWith('--') || options.has(key)) throw new Error('Expected --profile dev|native|release, --major 2|3 or --targets server,client,runtime');
      options.set(key, value);
    }
    this.profile = options.get('--profile') ?? 'release';
    if (!['dev', 'native', 'release'].includes(this.profile)) throw new Error('Unknown build profile');
    if (this.profile === 'native') {
      if (!['2', '3'].includes(options.get('--major')) || options.has('--targets')) throw new Error('Native profile requires exactly --major 2 or 3');
      this.majors = [Number(options.get('--major'))]; this.targets = ['server', 'client', 'runtime', 'smoke'];
    } else {
      if (options.has('--major') || this.profile === 'release' && options.has('--targets')) throw new Error('Release builds must include all targets; --major is native-only');
      this.majors = this.profile === 'release' ? [2, 3] : [];
      this.targets = this.profile === 'release' ? ['server', 'client', 'runtime', 'smoke'] : (options.get('--targets') ?? 'server').split(',');
      if (this.targets.some(target => !['server', 'client', 'runtime', 'smoke'].includes(target)) || new Set(this.targets).size !== this.targets.length) throw new Error('Invalid or duplicate development target');
    }
    this.output = this.profile === 'dev' ? '.codex-work/build/profiles/dev' : '.codex-work/build';
  }
  includes(target) { return this.targets.includes(target); }
  static assertRelease(profile, fingerprint) {
    if (profile?.profile !== 'release' || profile.state !== 'completed' || profile.sourceFingerprint !== fingerprint
      || JSON.stringify(profile.majors) !== '[2,3]' || JSON.stringify(profile.targets) !== '["server","client","runtime","smoke"]') {
      throw new Error('Packaging requires a completed full release build of the current source; native/dev profiles cannot be released');
    }
  }
}
