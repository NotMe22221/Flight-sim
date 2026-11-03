/** Keyboard cheat sheet from host.bindings(), grouped and searchable. */
import type { BindingInfo } from '../UiHost';
import { button, clear, deviceIcon, h, icon, isCoarsePointer } from '../dom';
import { bindingGroups } from '../bindingsModel';

export class HelpOverlay {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private bindings: BindingInfo[] = [];
  private onClose?: () => void;
  private card!: HTMLElement;

  constructor(layer: HTMLElement) {
    this.search = h('input', { class: 'input', type: 'search', placeholder: 'Search actions or keys…', autocomplete: 'off', spellcheck: false, onInput: () => this.render() });
    // the columns live in an auto-height element inside the scroller: a multi-column box with a fixed
    // height overflows sideways into extra (clipped) columns instead of scrolling down
    this.list = h('div', { class: 'help-groups' });
    const scroller = h('div', { class: 'help-scroll scroll' }, this.list);
    const card = this.card = h('div', { class: 'panel help-overlay', role: 'dialog', tabIndex: -1, aria: { label: 'Keyboard help' } },
      h('div', { class: 'row' }, icon('keyboard'), h('h2', { class: 'screen-title', style: 'font-size:1.1em;flex:1', text: 'Controls' }),
        button('', () => this.hide(), { icon: 'close', cls: 'btn-ghost btn-icon', title: 'Close (Esc)' })),
      this.search, scroller,
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
    // the card itself takes the focus on touch screens (a focused search box opens the keyboard)
    if (isCoarsePointer()) this.card.focus(); else this.search.focus();
  }
  hide(): void { if (!this.visible) return; this.el.classList.remove('visible'); const cb = this.onClose; this.onClose = undefined; cb?.(); }
  toggle(bindings: BindingInfo[], onClose?: () => void): void { this.visible ? this.hide() : this.show(bindings, onClose); }

  private render(): void {
    clear(this.list);
    const q = this.search.value.trim();
    // same grouping and pilot-first order as Settings › Controls; unbound actions only when searching
    const groups = bindingGroups(this.bindings, q)
      .map((g) => ({ group: g.group, rows: q ? g.rows : g.rows.filter((r) => !r.unbound) }))
      .filter((g) => g.rows.length > 0);
    if (groups.length === 0) { this.list.appendChild(h('div', { class: 'empty', text: this.bindings.length ? 'No matching bindings' : 'No bindings reported by the input module' })); return; }
    for (const { group, rows } of groups) {
      const g = h('div', { class: 'help-group' }, h('div', { class: 'section-label', text: group }));
      for (const r of rows) {
        g.appendChild(h('div', { class: 'help-row' }, h('span', { text: r.title }),
          h('span', { class: 'row', style: 'gap:6px' }, deviceIcon(r.info.device), h('span', { class: 'key', text: r.unbound ? 'unbound' : r.info.label }))));
      }
      this.list.appendChild(g);
    }
  }
}
