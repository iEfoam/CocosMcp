import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { UiDocumentModel } from '../../ui-core/src/index.js';
import type { EditorPort } from './port.js';

export class UiProperties {
  constructor(private readonly port: EditorPort) {}
  async resolve(properties: JsonObject, mapping: Map<string, string>): Promise<JsonObject> {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(properties)) {
      if (UiDocumentModel.eventProperties.has(key)) result[key] = Json.value(await this.port.scene('ui.eventBindings', { events: value }));
      else if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.nodeKey === 'string') {
        const nodeId = mapping.get(value.nodeKey);
        if (!nodeId) throw new CocosError('INVALID_ARGUMENT', `UI reference is not mapped: ${value.nodeKey}`);
        if (typeof value.componentType === 'string') {
          const tree = Json.object(await this.port.scene('hierarchy', { rootId: nodeId, limit: 1 }));
          const components = Json.object((tree.rows as JsonValue[])[0]).components as JsonObject[];
          const matches = components.filter(c => c.type === value.componentType);
          if (matches.length !== 1) throw new CocosError('INVALID_ARGUMENT', 'UI component reference is missing or ambiguous');
          result[key] = { uuid: matches[0]!.componentId! };
        } else result[key] = { uuid: nodeId };
      } else if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.assetUuid === 'string') result[key] = { uuid: value.assetUuid };
      else result[key] = value;
    }
    return result;
  }
}
