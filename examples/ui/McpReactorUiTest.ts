import { _decorator, Component, Node, UITransform, Canvas, Camera, Layers, Color, Graphics, Label, Button, EditBox, ScrollView, Mask, Widget } from 'cc';
const { ccclass, property } = _decorator;

/** 独立测试层只在游戏运行时创建；移除该组件即可取消整组测试控件。 */
@ccclass('McpReactorUiTest')
export class McpReactorUiTest extends Component {
  @property clicks = 0;
  @property inputText = '';
  @property scrollEvents = 0;
  @property ready = false;
  private status!: Label;
  private scroll!: ScrollView;
  private overlay!: Node;
  onLoad() {
    const canvasNode = this.box(this.node, 'UITestCanvas', 1280, 720);
    this.overlay = canvasNode;
    const canvas = canvasNode.addComponent(Canvas);
    const cameraNode = new Node('UITestCamera'); cameraNode.parent = canvasNode; cameraNode.setPosition(0, 0, 1000);
    const camera = cameraNode.addComponent(Camera); camera.projection = Camera.ProjectionType.ORTHO;
    camera.orthoHeight = 360; camera.near = 0.1; camera.far = 2000;
    camera.clearFlags = Camera.ClearFlag.DEPTH_ONLY; camera.visibility = Layers.Enum.UI_2D; camera.priority = 100;
    canvas.cameraComponent = camera;
    const panel = this.box(canvasNode, 'UITestPanel', 340, 500);
    const widget = panel.addComponent(Widget); widget.isAlignRight = true; widget.isAlignTop = true; widget.right = 20; widget.top = 20; widget.alignMode = Widget.AlignMode.ALWAYS;
    this.paint(panel, 340, 500, new Color(10, 21, 34, 250));
    const accent = this.box(panel, 'HeaderAccent', 42, 3, -125, 222); this.paint(accent, 42, 3, new Color(66, 221, 236));
    this.label(panel, 'Title', 'REACTOR CONTROL', 0, 187, 300, 34, 22);
    this.label(panel, 'Hint', '●  ONLINE    /    INTERACTION LAB', 0, 154, 300, 24, 11);
    const button = this.box(panel, 'TestButton', 292, 48, 0, 105); this.paint(button, 292, 48, new Color(15, 104, 130));
    this.label(button, 'ButtonText', 'RUN DIAGNOSTIC    →', 0, 0, 280, 44, 16);
    button.addComponent(Button).transition = Button.Transition.SCALE;
    button.on(Button.EventType.CLICK, () => { this.clicks++; this.status.string = `Clicks: ${this.clicks} | ${this.inputText || 'Ready'}`; });
    this.status = this.label(panel, 'Status', 'Clicks: 0 | Ready', 0, 64, 292, 25, 13);
    const input = this.box(panel, 'TestInput', 292, 46, 0, 18); input.active = false; const inputBackground = this.box(input, 'Background', 292, 46); this.paint(inputBackground, 292, 46, new Color(17, 34, 51));
    const text = this.label(input, 'InputText', '', 0, 0, 264, 40, 18);
    const placeholder = this.label(input, 'Placeholder', 'Type a command or message', 0, 0, 264, 40, 16); placeholder.color = new Color(144, 163, 185);
    const edit = input.addComponent(EditBox); edit.textLabel = text; edit.placeholderLabel = placeholder; edit.inputMode = EditBox.InputMode.SINGLE_LINE; edit.maxLength = 40; edit.placeholder = 'Type a command or message';
    // EditBox 原生布局以左上角定位标签，必须匹配其锚点，避免文字逸出输入框。
    text.node.getComponent(UITransform)!.setAnchorPoint(0, 1); placeholder.node.getComponent(UITransform)!.setAnchorPoint(0, 1);
    text.horizontalAlign = Label.HorizontalAlign.LEFT; placeholder.horizontalAlign = Label.HorizontalAlign.LEFT; input.active = true;
    input.on(EditBox.EventType.TEXT_CHANGED, (value: EditBox) => { this.inputText = value.string; this.status.string = `Clicks: ${this.clicks} | ${value.string}`; });
    this.label(panel, 'ScrollHint', 'ACTIVITY STREAM                  12 EVENTS', 0, -28, 292, 24, 10);
    const scrollNode = this.box(panel, 'TestScroll', 292, 165, 0, -120); this.paint(scrollNode, 292, 165, new Color(12, 27, 42));
    const viewport = this.box(scrollNode, 'Viewport', 292, 165); viewport.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;
    const content = this.box(viewport, 'Content', 280, 540, 0, 82.5); content.getComponent(UITransform)!.setAnchorPoint(0.5, 1);
    const checks = ['Core temperature', 'Energy containment', 'Coolant pressure', 'Field stability', 'Signal integrity', 'Power distribution', 'Shield calibration', 'Input response', 'Frame timing', 'Memory budget', 'Asset integrity', 'System readiness'];
    for (let i = 0; i < checks.length; i++) {
      const row = this.box(content, `Log${i + 1}`, 272, 38, 0, -24 - i * 44);
      this.paint(row, 272, 38, i % 2 ? new Color(17, 35, 50) : new Color(20, 40, 55));
      const number = this.label(row, 'Index', String(i + 1).padStart(2, '0'), -113, 0, 28, 30, 11); number.color = new Color(85, 153, 173);
      this.label(row, 'Message', checks[i], -4, 0, 186, 30, 13);
      const check = this.label(row, 'State', 'OK', 112, 0, 30, 28, 10); check.color = new Color(88, 226, 178);
    }
    this.scroll = scrollNode.addComponent(ScrollView); this.scroll.content = content; this.scroll.horizontal = false; this.scroll.vertical = true; this.scroll.inertia = false;
    scrollNode.on(ScrollView.EventType.SCROLLING, () => { this.scrollEvents++; });
    this.label(panel, 'Footer', 'CREATOR 3.8    /    MCP VALIDATION' , 0, -228, 310, 22, 11);
    this.ready = true;
  }
  get scrollOffsetY() { return this.scroll?.getScrollOffset().y ?? 0; }
  private box(parent: Node, name: string, width: number, height: number, x = 0, y = 0) {
    const node = new Node(name); node.layer = Layers.Enum.UI_2D; node.parent = parent; node.setPosition(x, y, 0); node.addComponent(UITransform).setContentSize(width, height); return node;
  }
  private paint(node: Node, width: number, height: number, color: Color) {
    const g = node.addComponent(Graphics); g.fillColor = color; g.roundRect(-width / 2, -height / 2, width, height, Math.min(12, height / 2)); g.fill(); if (height > 10) { g.strokeColor = new Color(65, 125, 148, 85); g.lineWidth = 1; g.stroke(); }
  }
  private label(parent: Node, name: string, text: string, x: number, y: number, width: number, height: number, size: number) {
    const node = this.box(parent, name, width, height, x, y); const label = node.addComponent(Label); label.string = text; label.fontSize = size; label.lineHeight = size + 6; label.overflow = Label.Overflow.CLAMP; label.horizontalAlign = Label.HorizontalAlign.CENTER; label.verticalAlign = Label.VerticalAlign.CENTER; label.color = new Color(221, 235, 247); return label;
  }
}
