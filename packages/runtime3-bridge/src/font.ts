import { Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A } from './access.js';
import type { MaterialController } from './material.js';
import type { SceneInspector } from './scene.js';

export class FontInspector {
  constructor(private readonly inspector: SceneInspector, private readonly assets: MaterialController) {}
  async inspect(p: JsonObject): Promise<JsonValue> {
    const font = await this.assets.load(Json.string(p.uuid, 'uuid'), 'Font');
    const config = font.fntConfig ? A.object(font.fntConfig) : null, dictionary = config?.fontDefDictionary;
    const characters = [...new Set(Array.from(String(p.sampleText ?? '')).filter(character => !/\s/u.test(character)))];
    const rows = characters.map(character => ({ character, codePoint: character.codePointAt(0)!, present: dictionary ? Object.hasOwn(A.object(dictionary), String(character.codePointAt(0))) : null }));
    const users: JsonObject[] = [];
    for (const node of this.inspector.all()) for (const component of this.inspector.components(node)) if (this.inspector.type(component) === 'cc.Label' && component.font === font) users.push({ nodeId: A.uuid(node), componentId: A.uuid(component), text: String(component.string ?? ''), useSystemFont: Boolean(component.useSystemFont) });
    return { uuid: A.uuid(font), type: this.inspector.type(font), rows, users, glyphCoverage: dictionary ? 'bitmap-font-table' : 'unknown',
      missing: rows.filter(row => row.present === false).map(row => row.character), spriteFrameUuid: font.spriteFrame ? A.uuid(font.spriteFrame) : null,
      limitations: ['动态字体与系统字体的字形覆盖尚未解析', '读取当前已加载场景引用，不包含未打开场景或脚本加载路径'] };
  }
}
