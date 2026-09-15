import { RenderRuntimeCapabilities } from './render-runtime.js';
import type { Capability, CreatorMajor, Effect, JsonSchema } from '../../contracts/src/index.js';
import { Schema as S } from './schema.js';
import { ShaderCapabilities } from './shader.js';
import { SceneProductionCapabilities } from './scene-production.js';
import { UiCapabilities } from './ui.js';
import { TextureCapabilities } from './texture.js';
import { RuntimeInteractionCapabilities } from './runtime-interaction.js';
import { RuntimeAnimationCapabilities } from './animation-runtime.js';
import { AnimationCapabilities } from './animation.js';
import { RuntimeAssetCapabilities } from './runtime-assets.js';

export class Operations {
  private readonly rows: Capability[] = [];

  private add(id: string, module: string, title: string, effect: Effect, properties: Record<string, JsonSchema> = {}, required: string[] = [], versions: CreatorMajor[] = [2, 3], options: {
    implementation?: 'implemented' | 'planned'; verification?: Capability['verification']; platforms?: string[]; prerequisites?: string[]; supportedMajors?: CreatorMajor[];
    sideEffects?: string[]; risks?: string[]; rollback?: string; source?: string;
  } = {}): void {
    this.rows.push({ id, module, title, description: title, context: id.startsWith('runtime.') ? 'runtime' : 'editor', effect,
      inputSchema: S.object(properties, required), outputSchema: {}, versions, supportedMajors: options.supportedMajors ?? versions, implementation: options.implementation ?? 'implemented',
      verification: options.verification ?? 'unverified', platforms: options.platforms ?? (id.startsWith('runtime.') ? ['runtime'] : ['editor']),
      ...(options.prerequisites ? { prerequisites: options.prerequisites } : {}),
      ...(options.sideEffects ? { sideEffects: options.sideEffects } : {}),
      ...(options.risks ? { risks: options.risks } : {}), ...(options.rollback ? { rollback: options.rollback } : {}),
      ...(options.source ? { source: options.source } : {}) });
  }

  list(): Capability[] {
    if (this.rows.length) return this.rows;
    const str = S.string(); const bool = S.boolean(); const obj = S.record(); const strings = S.array(str);
    const node = { nodeId: str }; const component = { componentId: str }; const asset = { url: str };
    this.add('editor.status', 'F01', '读取编辑器实例、版本和场景状态', 'read');
    this.add('scene.query', 'F04', '读取当前场景信息和修改状态', 'read');
    this.add('scene.snapshot', 'F04', '生成可重放的当前场景序列化快照', 'read');
    this.add('scene.diff', 'F04', '将当前场景与基线快照进行结构化差异比较', 'read', { baseline: S.any() }, ['baseline']);
    this.add('scene.hierarchy', 'F04', '分页读取场景层级', 'read', { rootId: str, offset: S.integer(), limit: S.integer(1), includeComponents: bool, includeInternal: bool });
    this.add('scene.open', 'F04', '打开已有场景；有未保存修改时拒绝切换', 'scene', { uuid: str }, ['uuid']);
    this.add('scene.save', 'F04', '保存当前场景并查询修改状态', 'scene');
    this.add('scene.save_copy', 'F04', '保存场景副本到新资源；保留当前场景及修改状态', 'asset', { url: str }, ['url'], [3]);
    this.add('scene.create', 'F04', '通过编辑器创建空场景', 'scene', { url: str }, ['url']);
    this.add('scene.close', 'F04', '关闭已保存的场景', 'scene');
    this.add('scene.undo', 'F10', '撤销最近一次编辑操作', 'scene');
    this.add('scene.redo', 'F10', '重做最近一次编辑操作', 'scene');
    this.add('node.query', 'F05', '读取节点及组件属性', 'read', node, ['nodeId']);
    this.add('node.find', 'F05', '按名称或场景路径查询节点，保留全部匹配', 'read', { name: str, path: str });
    this.add('node.create', 'F05', '创建节点并返回实际节点信息', 'scene', { name: str, parentId: str, assetUuid: str }, ['name']);
    this.add('node.delete', 'F05', '删除指定节点', 'scene', node, ['nodeId']);
    this.add('node.duplicate', 'F05', '复制指定节点', 'scene', node, ['nodeId']);
    this.add('node.reparent', 'F05', '修改父节点并可保持世界变换', 'scene', { ...node, parentId: str, keepWorldTransform: bool }, ['nodeId', 'parentId']);
    this.add('node.set', 'F06', '编辑节点属性并读回验证', 'scene', { ...node, properties: obj }, ['nodeId', 'properties']);
    this.add('node.reset', 'F06', '重置节点变换', 'scene', node, ['nodeId']);
    this.add('component.types', 'F07', '枚举当前工程全部已注册组件', 'read');
    this.add('component.add', 'F07', '添加内置或项目脚本组件', 'scene', { ...node, type: str }, ['nodeId', 'type']);
    this.add('component.query', 'F07', '读取指定组件实例的属性描述', 'read', component, ['componentId']);
    this.add('component.delete', 'F07', '按实例 ID 删除组件', 'scene', component, ['componentId']);
    this.add('component.set', 'F07', '修改组件属性和引用并读回验证', 'scene', { ...component, properties: obj }, ['componentId', 'properties']);
    this.add('component.reset', 'F07', '重置指定组件实例', 'scene', component, ['componentId']);
    this.add('component.invoke', 'F08', '执行组件方法；可能产生任意项目脚本副作用', 'external', { ...component, method: str, args: S.array() }, ['componentId', 'method'], [2, 3], {
      risks: ['项目脚本可执行任意业务副作用'], prerequisites: ['--allow-project-code'], rollback: '由项目脚本自行提供补偿逻辑' });
    this.add('asset.query', 'F13', '查询资源；支持类型和路径过滤', 'read', { pattern: str, type: str, offset: S.integer(), limit: S.integer(1) });
    for (const [id, title] of [['info', '读取资源信息'], ['meta', '读取导入设置'], ['dependencies', '查询直接资源依赖'], ['users', '查询资源反向引用']] as const) {
      this.add(`asset.${id}`, id === 'dependencies' || id === 'users' ? 'F15' : 'F14', title, 'read', asset, ['url'], [2, 3], id === 'dependencies' || id === 'users' ? { supportedMajors: [3] } : {});
    }
    this.add('asset.location', 'F13', '规划新资源路径：优先复用已有类型目录，没有则建议创建；不写入资源', 'read', { url: str }, ['url'], [3]);
    const organize = { scopeUrl: str, recursive: bool, urls: { type: 'array', items: str, maxItems: 2000 } };
    this.add('asset.organize.plan', 'F13', '按类型预览项目资源整理；默认仅根目录，保留已归类目录，跳过路径敏感资源；agent 必须审查字符串加载路径', 'read', organize, [], [3]);
    this.add('asset.organize.apply', 'F13', '执行已审查的资源整理计划；传相同范围及 planHash，通过 AssetDB 移动并验证 UUID，返回逐项记录与回滚路径', 'asset', { ...organize, planHash: str }, ['planHash'], [3]);
    this.add('asset.create', 'F13', '通过 AssetDB 创建文本资源', 'asset', { ...asset, content: { type: 'string' } }, ['url', 'content']);
    this.add('asset.save', 'F13', '通过 AssetDB 保存文本资源', 'asset', { ...asset, content: { type: 'string' } }, ['url', 'content']);
    this.add('asset.import', 'F13', '导入工程目录内的文件', 'asset', { sourcePath: str, targetUrl: str }, ['sourcePath', 'targetUrl']);
    this.add('asset.copy', 'F13', '复制资源及元数据', 'asset', { sourceUrl: str, targetUrl: str }, ['sourceUrl', 'targetUrl']);
    this.add('asset.move', 'F13', '移动资源并保留 UUID', 'asset', { sourceUrl: str, targetUrl: str }, ['sourceUrl', 'targetUrl']);
    for (const [id, title] of [['delete', '删除资源'], ['refresh', '刷新资源并等待导入'], ['reimport', '重新导入资源']] as const) this.add(`asset.${id}`, 'F13', title, 'asset', asset, ['url']);
    this.add('asset.set_meta', 'F14', '合并指定资源的导入设置并重新导入', 'asset', { ...asset, userData: obj }, ['url', 'userData']);
    this.add('asset.resolve', 'F13', '转换资源 URL、UUID 和文件路径', 'read', { reference: str }, ['reference']);
    this.add('prefab.instantiate', 'F09', '实例化预制体到场景', 'scene', { uuid: str, parentId: str, name: str }, ['uuid']);
    this.add('prefab.create', 'F09', '将节点保存成预制体资源', 'asset', { ...node, url: str }, ['nodeId', 'url']);
    this.add('prefab.apply', 'F09', '将预制体实例修改应用到资源', 'asset', node, ['nodeId']);
    this.add('prefab.revert', 'F09', '还原预制体实例修改', 'scene', node, ['nodeId']);
    this.add('prefab.unlink', 'F09', '解除预制体实例关联', 'scene', node, ['nodeId']);
    this.add('view.query', 'F11', '读取场景视图、Gizmo 与网格状态', 'read', {}, [], [2, 3], { supportedMajors: [3] });
    this.add('view.set', 'F11', '修改场景视图、Gizmo 与网格', 'configuration', { is2D: bool, grid: bool, tool: str, coordinate: str, pivot: str }, [], [2, 3], { supportedMajors: [3] });
    this.add('view.focus', 'F11', '聚焦指定节点', 'configuration', { nodeIds: strings }, ['nodeIds'], [2, 3], { supportedMajors: [3] });
    this.add('selection.query', 'F03', '读取编辑器选中对象', 'read', { type: S.enum('node', 'asset') });
    this.add('selection.set', 'F03', '设置编辑器选中对象', 'configuration', { type: S.enum('node', 'asset'), ids: strings }, ['type', 'ids']);
    this.add('project.settings.get', 'F02', '查询项目配置；不读取全局用户凭据', 'read', { name: str, key: str }, ['name'], [2, 3], { supportedMajors: [3] });
    this.add('project.settings.set', 'F02', '修改项目配置', 'configuration', { name: str, key: str, value: {} }, ['name', 'key', 'value'], [2, 3], { supportedMajors: [3] });
    this.add('editor.messages', 'F12', '列出本地版本已发现的编辑器消息', 'read', { package: str, publicOnly: bool }, [], [2, 3], { supportedMajors: [3] });
    this.add('editor.message', 'F12', '调用已发现的编辑器消息；内部接口需要精确版本匹配', 'external', { package: str, message: str, args: S.array(), editorVersion: str }, ['package', 'message', 'editorVersion'], [2, 3], { supportedMajors: [3],
      risks: ['内部编辑器接口随补丁版本变化'], prerequisites: ['精确 editorVersion', '--allow-project-code'], rollback: '重新加载工程或使用编辑器撤销' });
    this.add('scene.script', 'F08', '调用已安装扩展的场景脚本方法', 'external', { extension: str, method: str, args: S.array() }, ['extension', 'method'], [2, 3], {
      risks: ['扩展脚本可能修改工程外部状态'], prerequisites: ['--allow-project-code'], rollback: '由扩展提供补偿操作' });
    this.add('preview.start', 'F43', '启动项目预览；3.8.8 使用独立 MCP 窗口并要求场景已保存', 'runtime', { width: { type: 'integer', minimum: 256, maximum: 2048 }, height: { type: 'integer', minimum: 256, maximum: 2048 }, visible: bool });
    this.add('preview.resize', 'F43', '调整 MCP 预览内容尺寸并等待实际绘制；返回截图，不自动判定布局正确', 'runtime', { width: { type: 'integer', minimum: 256, maximum: 2048 }, height: { type: 'integer', minimum: 256, maximum: 2048 } }, ['width', 'height'], [3]);
    this.add('preview.input', 'F36', '向 MCP 自有预览窗口发送点击或滚轮并截取下一帧；会聚焦窗口，须另行验证业务结果', 'runtime', { action: S.enum('click', 'wheel'), x: { type: 'integer', minimum: 0, maximum: 2047 }, y: { type: 'integer', minimum: 0, maximum: 2047 }, deltaX: { type: 'integer', minimum: -2000, maximum: 2000 }, deltaY: { type: 'integer', minimum: -2000, maximum: 2000 } }, ['action', 'x', 'y'], [3], { rollback: '点击可能已产生业务副作用，失败先查询游戏状态；不自动重复点击' });
    this.add('preview.stop', 'F43', '停止项目预览', 'runtime', {}, [], [2, 3], { supportedMajors: [3] });
    this.add('preview.logs', 'F44', '分页查询 Web 预览异常与网络失败；按会话持久化，返回截断和捕捉缺口', 'read', { sessionId: { type: 'string', pattern: '^[a-f0-9]{32}$' }, cursor: S.integer(), limit: { type: 'integer', minimum: 1, maximum: 500 }, level: S.enum('warning', 'error'), kind: str, contains: str }, [], [3]);
    this.add('preview.status', 'F43', '查询 MCP 预览窗口和最近的渲染诊断', 'read', {}, [], [3]);
    this.add('preview.capture', 'F46', '在真实绘制帧之后截取 MCP 预览窗口；不要求开发运行时网关', 'read', {}, [], [3], { prerequisites: ['Creator 3.8.8；preview.start 已完成'], rollback: '只读截图，不修改项目资源' });
    this.add('logs.query', 'F44', '分页查询桥接事件，按级别过滤；Creator 控制台请用 console.query', 'read', { cursor: S.integer(), level: S.enum('debug', 'info', 'warn', 'error'), limit: S.integer(1) });
    this.add('console.query', 'F44', '读取 Creator 控制台（含 Scene 报错和堆栈），支持级别、进程、关键词和游标分页', 'read', {
      cursor: S.integer(), limit: { type: 'integer', minimum: 1, maximum: 500 }, level: S.enum('debug', 'info', 'warn', 'error'), process: str, contains: str,
    }, [], [3], { prerequisites: ['Creator 3.8.8 Editor.Logger.query；其他版本不宣称已验证'] });
    this.rows.push(...new UiCapabilities().list());
    this.rows.push(...new TextureCapabilities().list());
    this.rows.push(...new AnimationCapabilities().list());
    this.rows.push(...new RuntimeAnimationCapabilities().list());
    this.rows.push(...new RuntimeInteractionCapabilities().list());
    this.rows.push(...new RenderRuntimeCapabilities().list());
    this.rows.push(...new RuntimeAssetCapabilities().list());
    this.add('font.inspect', 'F17', '读取字体类型、位图字体字形覆盖和当前场景 Label 引用；动态字体缺字检查返回 unknown', 'read', { uuid: str, sampleText: { type: 'string', maxLength: 10000 } }, ['uuid'], [3], { prerequisites: ['Creator 3.8.8'] });
    this.add('scene.validate', 'F51', '检查缺失组件与无效对象引用', 'read');
    for (const [id, title, effect] of [
      ['query', '查询当前运行场景和引擎状态', 'read'],
      ['hierarchy', '分页读取运行时节点树', 'read'],
      ['types', '列出当前运行时可访问的引擎类型', 'read'],
      ['inspect', '检查对象属性描述及方法', 'read'],
      ['get', '读取对象属性', 'read'],
      ['set', '设置运行时对象属性', 'runtime'],
      ['invoke', '调用公开引擎方法', 'external'],
      ['create', '构造引擎对象并返回受控句柄', 'runtime'],
      ['release', '释放对象句柄；可明确销毁所拥有的对象', 'runtime'],
      ['subscribe', '订阅对象事件', 'runtime'],
      ['unsubscribe', '取消事件订阅', 'runtime'],
      ['events', '读取订阅事件', 'read'],
      ['pause', '暂停游戏循环', 'runtime'],
      ['resume', '恢复游戏循环', 'runtime'],
      ['capture', '捕获当前游戏 Canvas 图像', 'read'],
      ['statistics', '读取可用的真实运行时指标', 'read'],
    ] as const) {
      const props: Record<string, JsonSchema> = {
        target: str, path: str, method: str, args: S.array(), value: {}, type: str, event: str,
        subscriptionId: str, cursor: S.integer(), offset: S.integer(), limit: S.integer(1), destroy: bool,
      };
      this.add(`runtime.${id}`, id === 'capture' ? 'F46' : id === 'statistics' ? 'F45' : id === 'subscribe' || id === 'events' ? 'F36' : 'F39', title, effect, props, [], [2, 3], {
        platforms: ['development-runtime'], prerequisites: ['开发构建运行时桥接'],
        ...(id === 'invoke' ? { risks: ['仅允许公开引擎 API，禁止私有成员和危险构造'], rollback: '运行时重启后句柄自动失效' } : {}) });
    }
    this.rows.push(...new ShaderCapabilities().list());
    this.rows.push(...new SceneProductionCapabilities().list());
    return this.rows;
  }
}
