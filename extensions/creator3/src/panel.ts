import { createPanelDefinition } from '../../shared/panel.js';

declare const Editor: { Panel: { define?: (definition: ReturnType<typeof createPanelDefinition>) => unknown } };
const definition = createPanelDefinition(3);
// Creator 3.0–3.2 可直接导出定义，3.3 起使用官方的 Panel.define 注册入口。
export = Editor.Panel.define ? Editor.Panel.define(definition) : definition;
