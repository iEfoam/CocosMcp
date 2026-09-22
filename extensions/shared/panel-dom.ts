/** 小范围 DOM 协调器：保留未变化节点，避免轮询丢失输入焦点、选择和滚动位置。 */
export class PanelDom {
  private readonly listeners = new WeakMap<EventTarget, Map<string, EventListener>>();
  private readonly html = new WeakMap<HTMLElement, string>();
  update(root: HTMLElement, html: string): void {
    if (this.html.get(root) === html) return;
    const template = root.ownerDocument.createElement('template');
    template.innerHTML = html;
    this.children(root, template.content);
    this.html.set(root, html);
  }
  on(target: EventTarget | null, event: string, handler: EventListener): void {
    if (!target) return;
    let listeners = this.listeners.get(target);
    if (!listeners) { listeners = new Map(); this.listeners.set(target, listeners); }
    const previous = listeners.get(event);
    if (previous) target.removeEventListener(event, previous);
    target.addEventListener(event, handler); listeners.set(event, handler);
  }
  private key(node: Node): string {
    if (node.nodeType !== 1) return '';
    const element = node as Element;
    for (const name of ['data-key', 'data-action', 'data-tab', 'data-search', 'data-log-select', 'data-locale', 'data-copy-log']) {
      if (element.hasAttribute(name)) return `${element.tagName}:${name}:${element.getAttribute(name)}`;
    }
    return '';
  }
  private children(current: Node, desired: Node): void {
    let cursor = current.firstChild;
    for (const next of Array.from(desired.childNodes)) {
      const key = this.key(next);
      let match = cursor;
      if (key && (!match || this.key(match) !== key)) match = Array.from(current.childNodes).find(child => this.key(child) === key) ?? null;
      if (!match || match.nodeType !== next.nodeType || match.nodeName !== next.nodeName || this.key(match) !== key) {
        current.insertBefore(next.cloneNode(true), cursor);
        continue;
      }
      if (match !== cursor) current.insertBefore(match, cursor);
      if (match.nodeType === 1) this.element(match as Element, next as Element);
      else if (match.nodeValue !== next.nodeValue) match.nodeValue = next.nodeValue;
      cursor = match.nextSibling;
    }
    while (cursor) { const next = cursor.nextSibling; current.removeChild(cursor); cursor = next; }
  }
  private element(current: Element, desired: Element): void {
    const active = (current.getRootNode() as Document | ShadowRoot).activeElement;
    // 不重写正在编辑的值或原生下拉选项；焦点离开后再同步服务端状态。
    if (current === active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(current.tagName)) return;
    for (const attribute of Array.from(current.attributes)) if (!desired.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    for (const attribute of Array.from(desired.attributes)) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    this.children(current, desired);
    if (current !== active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(current.tagName)) {
      const field = current as HTMLInputElement, target = desired as HTMLInputElement;
      if (field.value !== target.value) field.value = target.value;
    }
  }
}
