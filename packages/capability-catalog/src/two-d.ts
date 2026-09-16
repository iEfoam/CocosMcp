import type { Capability, JsonSchema } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';
import { TwoDClipModel } from '../../animation-core/src/two-d.js';
import { GameplayTemplates } from '../../gameplay2d-core/src/templates.js';

export class TwoDCapabilities {
  list(): Capability[] {
    const rows: Capability[] = [], str = S.string(), root = { rootId: str }, component = { componentId: str };
    const number = { type: 'number', minimum: -1000000, maximum: 1000000 }, point = S.object({ x: number, y: number }, ['x', 'y']);
    const add = (id: string, title: string, props: Record<string, JsonSchema>, required: string[], effect: Capability['effect'] = 'read', module = 'F20'): void => {
      rows.push({ id, title, description: title, module, context: id.startsWith('runtime.') ? 'runtime' : 'editor', effect,
        inputSchema: S.object(props, required), outputSchema: {}, versions: [3], supportedMajors: [3], implementation: 'implemented', verification: 'unverified',
        prerequisites: ['Creator 3.8.8 与相应引擎模块；预览和真实设备分别验收'], rollback: '修改失败保留 completed/pending；运行时业务副作用不可自动回滚，不盲目重试' });
    };
    add('runtime.ui.inspect', '读取运行时布局和交互配置', root, ['rootId']);
    add('runtime.ui.assert', '断言子树节点激活、文本和按钮状态，不触发项目回调', { ...root, rows: { type: 'array', minItems: 1, maxItems: 100, items: { ...S.object({ nodeId: str, active: S.boolean(), text: { type: 'string', maxLength: 10000 }, interactable: S.boolean() }, ['nodeId']), minProperties: 2 } } }, ['rootId', 'rows']);
    add('runtime.ui.hit_test', '原生屏幕命中候选；不触发回调或伪称最终接收者', { ...root, x: number, y: number, windowId: { type: 'integer', minimum: 0 } }, ['rootId', 'x', 'y']);
    add('runtime.render2d.audit', '2D 合批候选诊断；不是实际提交批次', root, ['rootId'], 'read', 'F45');
    add('runtime.label.audit', '读取文字缓存配置并提示策略审查', root, ['rootId'], 'read', 'F17');
    add('runtime.atlas.inspect', '读取动态图集公开配置，不改变打包状态', {}, [], 'read', 'F16');
    const border = { type: 'number', minimum: 0, maximum: 16384 };
    const sprite = { url: str, spriteFrameUuid: str, settings: { ...S.object({ borderLeft: border, borderRight: border, borderTop: border, borderBottom: border, packable: S.boolean() }), minProperties: 1 } };
    add('spriteframe.inspect', '读取图片和 SpriteFrame 导入元数据、引用者', { url: str }, ['url'], 'read', 'F16');
    add('spriteframe.plan', '预览九宫格边距和动态图集资格修改', sprite, ['url', 'settings'], 'read', 'F16');
    add('spriteframe.apply', '按指纹修改 SpriteFrame 元数据并备份、重导入、读回', { ...sprite, planHash: str }, ['url', 'settings', 'planHash'], 'asset', 'F16');
    add('spriteframe.restore', '按当前指纹恢复同一图片的导入备份', { url: str, expectedHash: str, backupId: { type: 'string', pattern: '^[a-f0-9-]{36}$' } }, ['url', 'expectedHash', 'backupId'], 'asset', 'F16');
    const clip = { url: str, rootId: str, document: TwoDClipModel.schema };
    add('animation2d.plan', '规划原生序列帧、透明度与颜色轨道；不播放', clip, ['url', 'rootId', 'document'], 'read', 'F23');
    add('animation2d.create', '按计划创建原生 2D 动画资源并读回；不覆盖或自动绑定', { ...clip, planHash: str }, ['url', 'rootId', 'document', 'planHash'], 'asset', 'F23');
    add('gameplay2d.templates', '列出可生成的可编辑游戏组件和依赖', {}, [], 'read', 'F08');
    const recipe = { template: S.enum(...Object.keys(new GameplayTemplates().rows)), className: { type: 'string', pattern: '^[A-Z][A-Za-z0-9]{2,63}$' }, url: str, nodeId: str };
    add('gameplay2d.plan', '生成固定模板源码与绑定要求供审查；不执行项目逻辑', recipe, ['template', 'className', 'url', 'nodeId'], 'read', 'F08');
    add('gameplay2d.apply', '创建游戏组件脚本并挂载，保留已有逻辑；属性绑定另行配置', { ...recipe, planHash: str }, ['template', 'className', 'url', 'nodeId', 'planHash'], 'scene', 'F08');
    const ui = { parentId: str, kind: S.enum('menu', 'inventory', 'hud', 'dialogue'), name: str, width: { type: 'number', minimum: 64, maximum: 2048 }, height: { type: 'number', minimum: 64, maximum: 2048 }, slots: { type: 'integer', minimum: 1, maximum: 64 } };
    add('ui.template.plan', '规划菜单/背包/HUD/对白 UI 树；业务行为单独绑定', ui, ['parentId', 'kind', 'name'], 'read', 'F20');
    add('ui.template.build', '按已有 UI 守卫创建模板树并返回稳定节点映射', { ...ui, planHash: str }, ['parentId', 'kind', 'name', 'planHash'], 'scene', 'F20');
    const layout = { parentId: str, prefabUuid: str, name: str, count: { type: 'integer', minimum: 1, maximum: 200 }, columns: { type: 'integer', minimum: 1, maximum: 200 }, spacing: { type: 'number', exclusiveMinimum: 0, maximum: 10000 }, seed: { type: 'integer', minimum: 0, maximum: 4294967295 }, jitter: { type: 'number', minimum: 0, maximum: 5000 } };
    add('level2d.plan', '按固定种子规划预制体网格和抖动分布', layout, ['parentId', 'prefabUuid', 'name', 'count', 'columns', 'spacing'], 'read', 'F05');
    add('level2d.apply', '执行受守卫的关卡实例化并报告部分失败', { ...layout, planHash: str }, ['parentId', 'prefabUuid', 'name', 'count', 'columns', 'spacing', 'planHash'], 'scene', 'F05');
    add('navigation2d.find_path', '四邻接等权网格最短路线；不代表物理寻路', { width: { type: 'integer', minimum: 1, maximum: 128 }, height: { type: 'integer', minimum: 1, maximum: 128 }, start: point, end: point, blocked: { type: 'array', maxItems: 16384, items: point } }, ['width', 'height', 'start', 'end', 'blocked'], 'read', 'F08');
    add('preview.validate_viewports', '逐尺寸捕获真实绘制帧并恢复窗口；布局正确性另行审查', { rows: { type: 'array', minItems: 1, maxItems: 8, items: S.object({ width: { type: 'integer', minimum: 256, maximum: 2048 }, height: { type: 'integer', minimum: 256, maximum: 2048 } }, ['width', 'height']) } }, ['rows'], 'runtime', 'F43');
    add('runtime.physics2d.test_point', '查询包含世界坐标点的碰撞体', { point }, ['point'], 'read', 'F33');
    add('runtime.physics2d.test_aabb', '查询世界坐标矩形重叠碰撞体', { x: number, y: number, width: { type: 'number', exclusiveMinimum: 0, maximum: 100000 }, height: { type: 'number', exclusiveMinimum: 0, maximum: 100000 } }, ['x', 'y', 'width', 'height'], 'read', 'F33');
    add('runtime.physics2d.trace_contacts', '有界采集已有 Collider2D 的碰撞事件，结束清理监听', { componentIds: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: str }, frames: { type: 'integer', minimum: 1, maximum: 300 } }, ['componentIds', 'frames'], 'read', 'F33');
    add('runtime.spine.inspect', '读取 Spine 当前轨道和动画/皮肤列表', component, ['componentId'], 'read', 'F26');
    add('runtime.spine.play', 'Spine 命名动画播放或排队；不覆盖事件监听', { ...component, name: str, trackIndex: { type: 'integer', minimum: 0, maximum: 7 }, loop: S.boolean(), queue: S.boolean(), delay: { type: 'number', minimum: 0, maximum: 600 } }, ['componentId', 'name'], 'runtime', 'F26');
    add('runtime.spine.set_skin', '设置已有 Spine 皮肤并读取当前骨架', { ...component, name: str }, ['componentId', 'name'], 'runtime', 'F26');
    add('runtime.spine.set_attachment', '设置指定插槽的已有附件', { ...component, slot: str, name: str }, ['componentId', 'slot', 'name'], 'runtime', 'F26');
    add('runtime.spine.trace', '按真实帧记录 Spine 轨道；不安装覆盖式事件回调', { ...component, frames: { type: 'integer', minimum: 1, maximum: 300 } }, ['componentId', 'frames'], 'read', 'F26');
    add('runtime.tilemap.inspect', '读取地图图层和对象组', component, ['componentId'], 'read', 'F28');
    const region = { ...component, x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, width: { type: 'integer', minimum: 1, maximum: 64 }, height: { type: 'integer', minimum: 1, maximum: 64 } };
    add('runtime.tilemap.query_region', '读取已有 TiledLayer 区域 GID 和翻转位', region, ['componentId', 'x', 'y', 'width', 'height'], 'read', 'F28');
    const edits = { ...component, rows: { type: 'array', minItems: 1, maxItems: 512, items: S.object({ x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, gid: { type: 'integer', minimum: 0, maximum: 536870911 }, flags: { type: 'integer', minimum: 0, maximum: 4294967295 } }, ['x', 'y', 'gid']) } };
    add('runtime.tilemap.plan', '预览运行时瓦片修改；不改 TMX 源文件', edits, ['componentId', 'rows'], 'read', 'F28');
    add('runtime.tilemap.apply', '按快照守卫修改运行时瓦片并读回', { ...edits, planHash: str }, ['componentId', 'rows', 'planHash'], 'runtime', 'F28');
    return rows;
  }
}
