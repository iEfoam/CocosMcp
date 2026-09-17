import { createHash } from 'crypto';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import type { Creator2Port } from './index.js';
import { AnimationEditService } from '../../creator3-adapter/src/animation-edit.js';

export class Creator2AnimationService {
  constructor(private readonly port: Creator2Port) {}
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    if (this.port.version !== '2.4.15') throw new CocosError('UNSUPPORTED_VERSION', 'Animation adapter requires Creator 2.4.15');
    if (['animation.clip.read', 'animation.clip.patch', 'animation.clip.restore'].includes(id)) return new AnimationEditService({ version: this.port.version, projectPath: this.port.projectPath, scene: (...args) => this.port.scene(...args), request: async (_channel, message, ...args) => {
      if (message === 'query-asset-info') return this.port.asset('assetInfo', ...args);
      if (message === 'save-asset') return this.port.asset('saveExists', ...args);
      throw new CocosError('UNSUPPORTED_CAPABILITY', message);
    } }).execute(id, p);
    if (id === 'animation.clip.inspect' || id === 'animation.clip.sample') return Json.value(await this.port.scene(id, p));
    const content = await this.port.scene(id.startsWith('animation2d') ? 'animation2d.serialize' : 'animation.clip.serialize', p);
    const planHash = createHash('sha256').update(Json.canonical(Json.value({ url: p.url, rootId: p.rootId, document: p.document, fingerprint: await this.port.scene('fingerprint') }))).digest('hex');
    if (id === 'animation2d.plan') return { planHash, content: Json.value(content), url: p.url! };
    if (id === 'animation2d.create' && p.planHash !== planHash) throw new CocosError('STALE_REVISION', 'Animation plan changed');
    const rows = Json.value(await this.port.asset('create', p.url, typeof content === 'string' ? content : JSON.stringify(content)));
    const uuid = Json.string(Json.value(await this.port.asset('urlToUuid', p.url)), 'uuid');
    return { rows, uuid, clip: Json.value(await this.port.scene('animation.clip.inspect', { uuid })) };
  }
}
