import { createPanelDefinition } from '../../shared/panel.js';

declare const Editor: { Panel: { extend(definition: ReturnType<typeof createPanelDefinition>): unknown } };
export = Editor.Panel.extend(createPanelDefinition(2));
