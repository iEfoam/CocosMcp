import { Ajv, type ValidateFunction } from 'ajv';
import { CocosError, type Capability, type JsonObject } from '../../contracts/src/index.js';
import { ServiceTools } from './service-tools.js';
import { VerificationRegistry } from './verification.js';
import acceptance from './module-acceptance.json' with { type: 'json' };
import { Operations } from './operations.js';
import modules from './modules.json' with { type: 'json' };

export interface ModuleAcceptance {
  moduleId: string; reviewedScope: string;
  criteria: Array<{ title: string; entryIds: string[]; evidenceIds: string[] }>;
}

export class CapabilityCatalog {
  private readonly capabilities = new Map<string, Capability>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv = new Ajv({ allErrors: true, strict: true });

  constructor(rows: Capability[] = new Operations().list(), private readonly evidence = new VerificationRegistry(), private readonly acceptances: ModuleAcceptance[] = acceptance) {
    for (const row of rows) this.register(row);
  }

  register(capability: Capability): void {
    if (this.capabilities.has(capability.id)) throw new CocosError('OPERATION_CONFLICT', `Duplicate capability: ${capability.id}`);
    this.validators.set(capability.id, this.ajv.compile(capability.inputSchema));
    this.capabilities.set(capability.id, { ...capability, ...this.evidence.describe(capability.id) });
  }

  describe(id: string): Capability {
    const capability = this.capabilities.get(id);
    if (!capability) throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown capability: ${id}`);
    return capability;
  }

  validate(id: string, params: JsonObject): Capability {
    const capability = this.describe(id);
    if (capability.implementation !== 'implemented' || !(capability.supportedMajors ?? capability.versions).length) throw new CocosError('UNSUPPORTED_CAPABILITY', `Capability is not executable: ${id}`);
    const validate = this.validators.get(id)!;
    if (!validate(params)) throw new CocosError('INVALID_ARGUMENT', this.ajv.errorsText(validate.errors), { capabilityId: id });
    return capability;
  }

  search(query = '', module?: string, offset = 0, limit = 100) {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const rows = [...this.capabilities.values()].filter(row => (!module || row.module === module)
      && terms.every(term => `${row.id} ${row.title} ${row.module}`.toLocaleLowerCase().includes(term)));
    const serviceRows = this.serviceTools().filter(row => (!module || row.module === module) && terms.every(term => `${row.id} ${row.title} ${row.module}`.toLocaleLowerCase().includes(term)));
    return { rows: rows.slice(offset, offset + limit), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null,
      serviceTools: { rows: serviceRows.slice(offset, offset + limit), total: serviceRows.length, nextOffset: offset + limit < serviceRows.length ? offset + limit : null } };
  }

  serviceTools() { return new ServiceTools().list().map(row => ({ ...row, ...this.evidence.describe(row.id) })); }

  coverage() {
    const operations = [...this.capabilities.values()];
    const tools = this.serviceTools();
    return { rows: modules.map(module => {
      const matching = operations.filter(row => row.module === module.id);
      const serviceTools = tools.filter(row => row.module === module.id && !row.delegatesTo);
      const entries = [...matching, ...serviceTools];
      const verification = entries.reduce<Record<string, number>>((counts, row) => { counts[row.verification] = (counts[row.verification] ?? 0) + 1; return counts; }, {});
      const implementedOperations = matching.filter(row => row.implementation === 'implemented').length;
      const implementedEntries = entries.filter(row => row.implementation === 'implemented').length;
      const assessment = this.acceptances.find(row => row.moduleId === module.id);
      const accepted = assessment?.reviewedScope === module.scope && assessment.criteria.length > 0 && assessment.criteria.every(criterion =>
        criterion.title.length > 0 && criterion.entryIds.length > 0 && criterion.evidenceIds.length > 0 && criterion.entryIds.every(id => {
          const entry = entries.find(row => row.id === id);
          return entry?.implementation === 'implemented' && entry.verificationEvidence?.some(evidence =>
            criterion.evidenceIds.includes(evidence.id) && evidence.applicability === 'current-source' && ['editor-verified', 'runtime-verified', 'device-verified'].includes(evidence.level));
        }));
      // 模块完成必须另有完整范围验收；通用入口、少数操作和适配器测试都不能替代它。
      const status = !implementedEntries ? 'planned' as const : accepted ? 'implemented' as const : 'partial' as const;
      return { ...module, registeredOperations: matching.length, implementedOperations, plannedOperations: matching.length - implementedOperations,
        registeredServiceTools: serviceTools.length, implementedEntries, serviceTools,
        creator2Operations: matching.filter(row => row.supportedMajors?.includes(2)).length,
        creator3Operations: matching.filter(row => row.supportedMajors?.includes(3)).length,
        status, scopeAcceptance: accepted ? 'accepted' as const : 'pending' as const,
        scopeAcceptanceReason: accepted ? '显式完整范围验收及当前源码证据通过' : '尚无覆盖完整模块范围且匹配当前源码的验收，不能由操作数量推断完成',
        verification, testedEntries: entries.filter(row => !['unverified', 'source-only'].includes(row.verification)).length,
        verifiedOperations: matching.filter(row => ['editor-verified', 'runtime-verified', 'device-verified'].includes(row.verification)).length,
        historicalEvidenceEntries: entries.filter(row => row.verificationEvidence?.some(evidence => evidence.applicability === 'historical')).length };
    }), counting: { operations: operations.length, independentServiceTools: tools.filter(row => !row.delegatesTo).length,
      aliasServiceTools: tools.filter(row => row.delegatesTo).length, policy: '独立服务入口单独计数，别名不重复计数；模块范围完成需要显式验收。' } };
  }
}

export { Operations } from './operations.js';
export { Schema } from './schema.js';
