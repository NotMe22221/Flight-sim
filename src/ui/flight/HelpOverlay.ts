/** Keyboard cheat sheet from host.bindings(), grouped and searchable. */
import type { BindingInfo } from '../UiHost';
import { button, clear, deviceIcon, h, humanizeAction, icon } from '../dom';

export class HelpOverlay {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private bindings: BindingInfo[] = [];
  private onClose?: () => void;

  constructor(layer: HTMLElement) {
    this.search = h('input', { class: 'input', type: 'search', placeholder: 'Search actions or keys…', autocomplete: 'off', spellcheck: false, onInput: () => this.render() });
    this.list = h('div', { class: 'help-groups scroll', style: 'flex:1;min-height:0;overflow:auto' });
    const card = h('div', { class: 'panel help-overlay', role: 'dialog', aria: { label: 'Keyboard help' } },
      h('div', { class: 'row' }, icon('keyboard'), h('h2', { class: 'screen-title', style: 'font-size:1.1em;flex:1', text: 'Controls' }),
        button('', () => this.hide(), { icon: 'close', cls: 'btn-ghost btn-icon', title: 'Close (Esc)' })),
      this.search, this.list,
      h('div', { class: 'muted', style: 'font-size:.8em', text: 'Rebind keys in Settings › Controls. Laptop profile puts pitch/roll on the arrow keys and rudder on Q/E.' }));
    this.el = h('div', { class: 'modal-backdrop', onClick: (e) => { if (e.target === this.el) this.hide(); } }, card);
    layer.appendChild(this.el);
  }

  get visible(): boolean { return this.el.classList.contains('visible'); }

  show(bindings: BindingInfo[], onClose?: () => void): void {
    this.bindings = bindings;
    this.onClose = onClose;
    this.el.classList.add('visible');
    this.render();
    this.search.focus();
  }
  hide(): void { if (!this.visible) return; this.el.classList.remove('visible'); const cb = this.onClose; this.onClose = undefined; cb?.(); }
  toggle(bindings: BindingInfo[], onClose?: () => void): void { this.visible ? this.hide() : this.show(bindings, onClose); }

  private render(): void {
    clear(this.list);
    const q = this.search.value.trim().toLowerCase();
    const groups = new Map<string, BindingInfo[]>();
    for (const b of this.bindings) {
      if (b.device === 'none' && !q) continue;
      const label = humanizeAction(b.action);
      if (q && !label.toLowerCase().includes(q) && !b.label.toLowerCase().includes(q) && !b.group.toLowerCase().includes(q)) continue;
      const g = groups.get(b.group) ?? [];
      g.push(b);
      groups.set(b.group, g);
    }
    if (groups.size === 0) { this.list.appendChild(h('div', { class: 'empty', text: this.bindings.length ? 'No matching bindings' : 'No bindings reported by the input module' })); return; }
    for (const [group, items] of groups) {
      const g = h('div', { class: 'help-group' }, h('div', { class: 'section-label', text: group }));
      for (const b of items) {
        g.appendChild(h('div', { class: 'help-row' }, h('span', { text: humanizeAction(b.action) }),
          h('span', { class: 'row', style: 'gap:6px' }, deviceIcon(b.device), h('span', { class: 'key', text: b.device === 'none' ? 'unbound' : b.label }))));
      }
      this.list.appendChild(g);
    }
  }
}
