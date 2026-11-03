/** Interactive C172 checklist with per-section progress and auto-completion from the sim state. */
import type { SimSnapshot } from '../../core/types';
import { Cls, button, h, icon, select, toggle } from '../dom';
import { C172_CHECKLISTS, type ChecklistSection } from '../data/c172Checklists';
import { evalAutoCheck } from './checklistAuto';

interface ItemView { el: HTMLElement; done: Cls; autoOk: Cls; current: Cls; auto?: string; checked: boolean }

export class Checklist {
  readonly el: HTMLElement;
  private sectionIdx = 0;
  private items: ItemView[] = [];
  private list: HTMLElement;
  private sectionSelect: HTMLSelectElement;
  private progress: HTMLElement;
  private autoComplete = true;
  private lastAutoEval = 0;
  private state = new Map<string, boolean[]>(); // section id → checked

  constructor(container: HTMLElement, private readonly sections: ChecklistSection[] = C172_CHECKLISTS) {
    this.sectionSelect = select(sections.map((s) => ({ value: s.id, label: s.title })), sections[0].id, (id) => this.goTo(sections.findIndex((s) => s.id === id)), 'select-sm');
    this.list = h('div', { class: 'cl-items scroll' });
    this.progress = h('span', { class: 'muted tnum' });
    const auto = toggle('Auto-complete', this.autoComplete, (v) => { this.autoComplete = v; });
    auto.el.classList.add('cl-auto-toggle');
    auto.el.style.cssText = 'border:0;padding:0;gap:8px';
    this.el = h('div', { class: 'checklist' },
      h('div', { class: 'cl-nav' },
        button('', () => this.goTo(this.sectionIdx - 1), { icon: 'back', cls: 'btn-icon btn-sm', title: 'Previous checklist' }),
        this.sectionSelect,
        button('', () => this.goTo(this.sectionIdx + 1), { icon: 'chevronRight', cls: 'btn-icon btn-sm', title: 'Next checklist' })),
      this.list,
      h('div', { class: 'cl-footer' }, this.progress, h('span', { class: 'spacer' }), auto.el,
        button('Reset', () => this.resetSection(), { cls: 'btn-sm' }),
        button('Next', () => this.goTo(this.sectionIdx + 1), { cls: 'btn-sm', icon: 'chevronRight' })));
    container.appendChild(this.el);
    this.render();
  }

  get section(): ChecklistSection { return this.sections[this.sectionIdx]; }

  goTo(i: number): void {
    this.sectionIdx = Math.max(0, Math.min(this.sections.length - 1, i));
    this.sectionSelect.value = this.section.id;
    this.render();
  }

  resetSection(): void { this.state.set(this.section.id, this.section.items.map(() => false)); this.render(); }

  /** New flight: every section unchecked, back to the first one. */
  resetAll(): void { this.state.clear(); this.goTo(0); }

  private render(): void {
    const s = this.section;
    const checked = this.state.get(s.id) ?? s.items.map(() => false);
    this.state.set(s.id, checked);
    this.items = [];
    this.list.replaceChildren();
    s.items.forEach((it, idx) => {
      const check = h('span', { class: 'cl-check' }, icon('check'));
      const el = h('div', { class: 'cl-item', role: 'checkbox', tabIndex: 0, aria: { checked: checked[idx] } },
        check,
        h('span', { class: 'cl-text' }, h('span', { text: it.text }), h('span', { class: 'cl-resp', text: it.response })),
        h('span', { class: 'cl-auto', text: it.auto ? 'AUTO' : '' }),
        it.note ? h('span', { class: 'cl-note', text: it.note }) : null);
      const view: ItemView = { el, done: new Cls(el, 'done'), autoOk: new Cls(el, 'auto-ok'), current: new Cls(el, 'current'), auto: it.auto, checked: checked[idx] };
      const flip = () => { view.checked = !view.checked; checked[idx] = view.checked; el.setAttribute('aria-checked', String(view.checked)); this.refresh(); };
      el.addEventListener('click', flip);
      el.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
      this.items.push(view);
      this.list.appendChild(el);
    });
    this.refresh();
  }

  private refresh(): void {
    let done = 0, firstOpen = -1;
    this.items.forEach((v, i) => { v.done.set(v.checked); if (v.checked) done++; else if (firstOpen < 0) firstOpen = i; });
    this.items.forEach((v, i) => v.current.set(i === firstOpen));
    this.progress.textContent = `${done}/${this.items.length}`;
    if (done === this.items.length && this.items.length) this.progress.textContent += ' ✓';
  }

  /** Called every frame while visible; auto-evaluation throttled to 4 Hz. */
  update(s: SimSnapshot, nowMs: number): void {
    if (nowMs - this.lastAutoEval < 250) return;
    this.lastAutoEval = nowMs;
    let changed = false;
    const checked = this.state.get(this.section.id)!;
    this.items.forEach((v, i) => {
      if (!v.auto) return;
      const ok = evalAutoCheck(v.auto as never, s);
      v.autoOk.set(ok);
      if (ok && this.autoComplete && !v.checked) { v.checked = true; checked[i] = true; v.el.setAttribute('aria-checked', 'true'); changed = true; }
    });
    if (changed) this.refresh();
  }
}
