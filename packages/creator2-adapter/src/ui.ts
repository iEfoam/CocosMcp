import { createHash } from 'crypto';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import type { Creator2Port } from './index.js';

export class Creator2UiService {
  constructor(private readonly port: Creator2Port) {}
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    if (this.port.version !== '2.4.15') throw new CocosError('UNSUPPORTED_VERSION', 'UI adapter requires Creator 2.4.15');
    if (id === 'ui.inspect_layout' || id === 'ui.validate_interaction') return Json.value(await this.port.scene(id, p));
    const planning = id === 'ui.structure.apply' ? 'ui.structure.plan' : id === 'ui.build' ? 'ui.plan' : id === 'ui.apply' ? 'ui.diff' : id;
    const result = Json.object(Json.value(await this.port.scene(planning, p)));
    const { planHash: _ignored, ...params } = p;
    const fingerprint = await this.port.scene('fingerprint');
    const planHash = createHash('sha256').update(Json.canonical(Json.value({ params, result, fingerprint, version: this.port.version }))).digest('hex');
    if (id === 'ui.plan' || id === 'ui.diff' || id === 'ui.structure.plan') return { ...result, planHash };
    if (p.planHash !== planHash) throw new CocosError('STALE_REVISION', 'UI changed; obtain a fresh plan');
    return Json.value(await this.port.scene(id, p));
  }
}
