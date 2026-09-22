import type { Verification } from '../../contracts/src/index.js';
import historical from './verification-history.json' with { type: 'json' };

declare const __COCOS_SOURCE_FINGERPRINT__: string | undefined;
declare const __COCOS_VERIFICATION_EVIDENCE__: Evidence[] | undefined;

export interface Evidence {
  id: string; level: Verification; entryIds: string[]; sourceFingerprint?: string;
  source: string; reportSha256?: string; creatorVersion?: string; limitations: string;
}
export interface VerificationContext { sourceFingerprint?: string | undefined; records: Evidence[] }

/** 实测历史与当前源码验收分开；缺少源码指纹的旧报告不能证明当前改动已通过。 */
export class VerificationRegistry {
  constructor(private readonly context: VerificationContext = {
    sourceFingerprint: typeof __COCOS_SOURCE_FINGERPRINT__ === 'undefined' ? undefined : __COCOS_SOURCE_FINGERPRINT__,
    records: [...historical as Evidence[], ...(typeof __COCOS_VERIFICATION_EVIDENCE__ === 'undefined' ? [] : __COCOS_VERIFICATION_EVIDENCE__ ?? [])],
  }) {}
  describe(id: string): { verification: Verification; verificationEvidence: Array<Evidence & { applicability: 'current-source' | 'historical' }> } {
    const verificationEvidence = this.context.records.filter(row => row.entryIds.includes(id)).map(row => ({ ...row,
      applicability: row.sourceFingerprint && row.sourceFingerprint === this.context.sourceFingerprint ? 'current-source' as const : 'historical' as const }));
    const order: Verification[] = ['unverified', 'source-only', 'contract-tested', 'adapter-tested', 'editor-verified', 'runtime-verified', 'device-verified'];
    let verification: Verification = 'unverified';
    for (const row of verificationEvidence) if (row.applicability === 'current-source' && order.indexOf(row.level) > order.indexOf(verification)) verification = row.level;
    return { verification, verificationEvidence };
  }
}
