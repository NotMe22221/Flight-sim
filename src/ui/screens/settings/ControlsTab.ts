/**
 * Settings › Controls: host.bindings() grouped, filterable by text and device; click a row to
 * rebind (host.rebind waits for the next key/button; Esc cancels); conflicts highlighted;
 * profile reset buttons (second click confirms).
 */
import type { SimAction } from '../../../core/types';
import type { BindingInfo } from '../../UiHost';
import { Txt, button, clear, deviceIcon, h, humanizeAction, segmented } from '../../dom';
import { BINDING_PROFILES, bindingGroups, conflictCount, type BindingProfileId, type DeviceFilter } from '../../bindingsModel';
import type { SettingsTabView, TabDeps } from './types';

const CONFIRM_MS = 3000;

export class ControlsTab implements SettingsTabView {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private conflicts: Txt;
  private device: DeviceFilter = 'all';
  private bindings: BindingInfo[] = [];
  private rebinding: SimAction | null = null;
  private endedThisTask = false;
  private confirm: { id: BindingProfileId; until: number } | null = null;
  private profileButtons = new Map<BindingProfileId, HTMLButtonElement>();

  constructor(private readonly d: TabDeps) {
    this.search = h('input', { class: 'input input-sm', type: 'search', placeholder: 'Search actions or keys…', autocomplete: 'off', spellcheck: false, aria: { label: 'Search bindings' }, onInput: () => this.render() });
    this.search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.search.value) { e.preventDefault(); this.search.value = ''; this.render(); } });
    const dev = segmented<DeviceFilter>([{ value: 'all', label: 'All' }, { value: 'keyboard', label: 'Keyboard' }, { value: 'gamepad', label: 'Gamepad' }, { value: 'mouse', label: 'Mouse' }],
      'all', (v) => { this.device = v; this.render(); });
    this.conflicts = new Txt(h('span', { class: 'badge badge-err' }), '');
    this.list = h('div', { class: 'settings-bindings' });
    const profiles = h('div', { class: 'row wrap' }, h('span', { class: 'muted', style: 'font-size:.85em', text: 'Reset to profile:' }),
      ...BINDING_PROFILES.map((p) => {
        const b = button(p.label, () => this.resetProfile(p.id), { cls: 'btn-sm', title: p.help });
        this.profileButtons.set(p.id, b);
        return b;
      }));
    this.el = h('div', { class: 'col', style: 'gap:12px' },
      h('div', { class: 'row wrap' }, h('div', { style: 'flex:1;min-width:220px' }, this.search), dev.el, this.conflicts.el),
      h('div', { class: 'muted', style: 'font-size:.85em', text: 'Click an action, then press the new key or button. Esc cancels. Keys shown red are bound twice.' }),
      h('section', { class: 'panel settings-group' }, this.list),
      profiles);
  }

  onShow(): void { this.reload(); }
  /**
   * Leaving the tab (Back button, another tab) while the input module still waits for a key: cancel
   * it, or the next key pressed in flight would silently become the new binding.
   */
  onHide(): void { if (this.rebinding) this.cancelPending(); }
  sync(): void { /* bindings live in the input module, not in PersistedSettings */ }

  /**
   * Esc while waiting for a key belongs to the input module (it cancels the rebind). The rebind
   * promise may already have settled when this listener runs (microtasks run between listeners of
   * a real key event), so the Esc that ended it is still swallowed until the next task.
   */
  onKey(e: KeyboardEvent): boolean { return e.key === 'Escape' && (this.rebinding !== null || this.endedThisTask); }

  dispose(): void { if (this.rebinding) this.cancelPending(); this.rebinding = null; }

  private cancelPending(): void {
    try { this.d.ctx.host.cancelRebind?.(); } catch { /* host gone */ }
  }

  private reload(): void {
    try { this.bindings = this.d.ctx.host.bindings(); } catch { this.bindings = []; }
    this.render(true);
  }

  /** `keepScroll`: a rebuild after a rebind/reset keeps the reader's place (a new filter starts at the top). */
  private render(keepScroll = false): void {
    const scroller = keepScroll ? this.el.closest<HTMLElement>('.settings-content') : null;
    const top = scroller ? scroller.scrollTop : 0;
    this.renderList();
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
  }

  private renderList(): void {
    clear(this.list);
    const n = conflictCount(this.bindings);
    this.conflicts.set(n ? `${n} conflicts` : '');
    this.conflicts.el.style.display = n ? '' : 'none';
    const groups = bindingGroups(this.bindings, this.search.value, this.device);
    if (!groups.length) { this.list.appendChild(h('div', { class: 'empty', text: this.bindings.length ? 'No matching actions' : 'The input module reported no bindings' })); return; }
    for (const g of groups) {
      const wrap = h('div', { class: 'binding-group' }, h('div', { class: 'section-label', text: g.group }));
      for (const r of g.rows) {
        const busy = this.rebinding === r.info.action;
        const conflictTitle = r.conflictWith.length ? `Also bound to: ${r.conflictWith.map(humanizeAction).join(', ')}` : '';
        const row = h('div', {
          class: `binding-row${r.conflictWith.length ? ' conflict' : ''}${busy ? ' rebinding' : ''}`, role: 'button', tabIndex: 0,
          title: conflictTitle || `Click to rebind ${r.title}`,
          onClick: () => this.rebind(r.info.action),
          onKeyDown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && !this.rebinding) { e.preventDefault(); this.rebind(r.info.action); } },
        },
        h('span', { text: r.title }),
        deviceIcon(r.info.device),
        h('span', { class: 'binding-key' }, h('span', { class: 'key', text: busy ? 'Press a key…' : r.unbound ? 'unbound' : r.info.label })));
        wrap.appendChild(row);
      }
      this.list.appendChild(wrap);
    }
  }

  private rebind(action: SimAction): void {
    if (this.rebinding) return;
    this.rebinding = action;
    this.render(true);
    let p: Promise<BindingInfo | null>;
    try { p = this.d.ctx.host.rebind(action); } catch (e) { p = Promise.reject(e); }
    p.then((res) => {
      if (res) this.d.ctx.toast(`${humanizeAction(action)} → ${res.label}`, 'success');
      else this.d.ctx.toast('Rebind cancelled', 'info');
    }).catch(() => this.d.ctx.toast('Could not rebind that action', 'error'))
      .finally(() => {
        this.rebinding = null;
        this.endedThisTask = true;
        setTimeout(() => { this.endedThisTask = false; }, 0);
        this.reload();
      });
  }

  private resetProfile(id: BindingProfileId): void {
    const now = Date.now();
    const label = BINDING_PROFILES.find((p) => p.id === id)?.label ?? id;
    if (!this.confirm || this.confirm.id !== id || now > this.confirm.until) {
      this.confirm = { id, until: now + CONFIRM_MS };
      for (const [k, b] of this.profileButtons) b.classList.toggle('btn-danger', k === id);
      this.d.ctx.toast(`Click "${label}" again to replace your bindings`, 'warn');
      setTimeout(() => { if (this.confirm?.id === id && Date.now() >= this.confirm.until) { this.confirm = null; this.profileButtons.get(id)?.classList.remove('btn-danger'); } }, CONFIRM_MS + 50);
      return;
    }
    this.confirm = null;
    this.profileButtons.get(id)?.classList.remove('btn-danger');
    try { this.d.ctx.host.resetBindings(id); this.d.ctx.toast(`Bindings reset to ${label}`, 'success'); } catch { this.d.ctx.toast('Reset failed', 'error'); }
    this.reload();
  }
}
