import { Ajv, type ValidateFunction } from 'ajv';
import { CocosError, type Capability, type JsonObject } from '../../contracts/src/index.js';
import { Operations } from './operations.js';
import modules from './modules.json' with { type: 'json' };

export class CapabilityCatalog {
  private readonly capabilities = new Map<string, Capability>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv = new Ajv({ allErrors: true, strict: true });

  constructor(rows: Capability[] = new Operations().list()) {
    for (const row of rows) this.register(row);
  }

  register(capability: Capability): void {
    if (this.capabilities.has(capability.id)) throw new CocosError('OPERATION_CONFLICT', `Duplicate capability: ${capability.id}`);
    this.validators.set(capability.id, this.ajv.compile(capability.inputSchema));
    this.capabilities.set(capability.id, capability);
  }

  describe(id: string): Capability {
    const capability = this.capabilities.get(id);
    if (!capability) throw new CocosError('UNSUPPORTED_CAPABILITY', `Unknown capability: ${id}`);
    return capability;
  }

  validate(id: string, params: JsonObject): Capability {
    const capability = this.describe(id);
    const validate = this.validators.get(id)!;
    if (!validate(params)) throw new CocosError('INVALID_ARGUMENT', this.ajv.errorsText(validate.errors), { capabilityId: id });
    return capability;
  }

  search(query = '', module?: string, offset = 0, limit = 100): { rows: Capability[]; total: number; nextOffset: number | null } {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const rows = [...this.capabilities.values()].filter(row => (!module || row.module === module)
      && terms.every(term => `${row.id} ${row.title} ${row.module}`.toLocaleLowerCase().includes(term)));
    return { rows: rows.slice(offset, offset + limit), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null };
  }

  coverage(): { rows: Array<{ id: string; title: string; scope: string; registeredOperations: number; implementedOperations: number; plannedOperations: number; creator2Operations: number; creator3Operations: number; status: 'partial' | 'planned' | 'implemented'; verifiedOperations: number; verification: Record<string, number> }> } {
    const operations = [...this.capabilities.values()];
    return { rows: modules.map(module => {
      const matching = operations.filter(row => row.module === module.id);
      const verification = matching.reduce<Record<string, number>>((counts, row) => { counts[row.verification] = (counts[row.verification] ?? 0) + 1; return counts; }, {});
      const implementedOperations = matching.filter(row => row.implementation === 'implemented').length;
      const plannedOperations = matching.length - implementedOperations;
      return { ...module, registeredOperations: matching.length, implementedOperations, plannedOperations,
        creator2Operations: matching.filter(row => row.supportedMajors?.includes(2)).length,
        creator3Operations: matching.filter(row => row.supportedMajors?.includes(3)).length,
        status: !matching.length ? 'planned' : plannedOperations === 0 ? 'implemented' : 'partial', verification,
        // 注册一个通用入口不能证明整个功能模块已经覆盖；模块完成需工作流验收。
        verifiedOperations: matching.filter(row => row.verification === 'editor-verified' || row.verification === 'runtime-verified' || row.verification === 'device-verified').length };
    }) };
  }
}

export { Operations } from './operations.js';
export { Schema } from './schema.js';
