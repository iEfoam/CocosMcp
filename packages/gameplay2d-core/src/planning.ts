import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { UiDocumentModel, type UiDocument, type UiNode } from '../../ui-core/src/index.js';

export class TwoDPlanning {
  layout(p: JsonObject): JsonObject[] {
    const count = Number(p.count), columns = Number(p.columns), spacing = Number(p.spacing), seed = Number(p.seed ?? 1), jitter = Number(p.jitter ?? 0);
    if (!Number.isInteger(count) || count < 1 || count > 200 || !Number.isInteger(columns) || columns < 1 || columns > 200 || !Number.isFinite(spacing) || spacing <= 0 || spacing > 10000 || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isFinite(jitter) || jitter < 0 || jitter > spacing / 2) throw new CocosError('INVALID_ARGUMENT', 'Invalid bounded level layout');
    let state = seed >>> 0;
    const random = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    return Array.from({ length: count }, (_, index) => ({ name: `${Json.string(p.name, 'name')}_${String(index + 1).padStart(3, '0')}`, position: { x: (index % columns) * spacing + (random() * 2 - 1) * jitter, y: -Math.floor(index / columns) * spacing + (random() * 2 - 1) * jitter, z: 0 } }));
  }
  path(p: JsonObject): JsonObject {
    const width = Number(p.width), height = Number(p.height);
    if (![width, height].every(n => Number.isInteger(n) && n >= 1 && n <= 128)) throw new CocosError('INVALID_ARGUMENT', 'Grid dimensions must be 1..128');
    const index = (value: JsonValue | undefined): number => { const point = Json.object(value), x = Number(point.x), y = Number(point.y); if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) throw new CocosError('INVALID_ARGUMENT', 'Grid coordinate outside bounds'); return y * width + x; };
    if (!Array.isArray(p.blocked) || p.blocked.length > width * height) throw new CocosError('INVALID_ARGUMENT', 'Invalid blocked cells');
    const blocked = new Set(p.blocked.map(index)), start = index(p.start), end = index(p.end);
    if (blocked.has(start) || blocked.has(end)) throw new CocosError('INVALID_ARGUMENT', 'Start/end is blocked');
    // 四邻接等权网格用 BFS，保证最短路径；不声称生成物理可通行路线。
    const queue = [start], previous = new Map<number, number>([[start, -1]]);
    for (let cursor = 0; cursor < queue.length && !previous.has(end); cursor++) {
      const current = queue[cursor]!, x = current % width, y = Math.floor(current / width);
      for (const [nx, ny] of [[x + 1, y], [x, y + 1], [x - 1, y], [x, y - 1]]) {
        if (nx! < 0 || ny! < 0 || nx! >= width || ny! >= height) continue;
        const next = ny! * width + nx!;
        if (!blocked.has(next) && !previous.has(next)) { previous.set(next, current); queue.push(next); }
      }
    }
    const route: number[] = [];
    if (previous.has(end)) for (let node = end; node !== -1; node = previous.get(node)!) route.push(node);
    return { reached: previous.has(end), rows: route.reverse().map(node => ({ x: node % width, y: Math.floor(node / width) })), visited: previous.size, algorithm: 'breadth-first-four-neighbor', physicsVerified: false };
  }
  ui(p: JsonObject): UiDocument {
    const kind = Json.string(p.kind, 'kind'), name = Json.string(p.name, 'name');
    const width = Number(p.width ?? 600), height = Number(p.height ?? 400), count = Number(p.slots ?? 12);
    if (![width, height].every(n => Number.isFinite(n) && n >= 64 && n <= 2048) || !Number.isInteger(count) || count < 1 || count > 64) throw new CocosError('INVALID_ARGUMENT', 'Invalid UI template dimensions');
    const label = (key: string, text: string, x: number, y: number, w: number, h: number, button = false): UiNode => ({ key, name: key, position: { x, y, z: 0 }, components: [
      { type: 'cc.UITransform', properties: { contentSize: { width: w, height: h } } },
      { type: 'cc.Label', properties: { string: text, fontSize: 24, lineHeight: 30, overflow: 1, enableWrapText: true } },
      ...(button ? [{ type: 'cc.Button', properties: { transition: 0, interactable: true } }] : []),
    ] });
    let children: UiNode[];
    if (kind === 'menu') children = ['Resume', 'Settings', 'Close'].map((text, i) => label(`Action${i}`, text, 0, 70 - i * 70, width - 40, 56, true));
    else if (kind === 'inventory') { const columns = Math.max(1, Math.floor(width / 90)); children = Array.from({ length: count }, (_, i) => label(`Slot${i}`, `Slot ${i + 1}`, -width / 2 + 45 + i % columns * 90, height / 2 - 45 - Math.floor(i / columns) * 90, 80, 80, true)); }
    else if (kind === 'hud') children = [label('Health', 'HP —', -width / 4, 0, width / 2 - 20, 50), label('Score', 'Score —', width / 4, 0, width / 2 - 20, 50)];
    else if (kind === 'dialogue') children = [label('Text', 'Bind dialogue data', 0, 50, width - 40, height - 150), label('Choice0', 'Continue', 0, -height / 2 + 50, width - 40, 60, true)];
    else throw new CocosError('INVALID_ARGUMENT', 'Unknown UI template');
    const document: UiDocument = { version: 1, root: { key: 'Root', name, components: [{ type: 'cc.UITransform', properties: { contentSize: { width, height } } }], children } };
    new UiDocumentModel().parse(document); return document;
  }
}
