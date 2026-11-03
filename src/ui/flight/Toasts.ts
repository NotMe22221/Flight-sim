/**
 * Bottom-centre toast queue fed by 'ui:toast'. At most three visible; the rest wait. A toast whose
 * text is the newest one showing restarts its timer; showing further up, the old copy leaves and the
 * new one goes last (the newest toast states the current state: AP on, off, on again); one already
 * waiting is dropped. Mashing a hotkey never leaves a long tail of stale toasts.
 */
import type { SimEvents } from '../../core/types';
import { h, icon } from '../dom';

type ToastPayload = SimEvents['ui:toast'];

export class Toasts {
  readonly el: HTMLElement;
  private queue: ToastPayload[] = [];
  private active = 0;
  private readonly maxVisible = 3;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** text of each visible toast → its element, restart its timer, remove it */
  private showing = new Map<string, { el: HTMLElement; restart: () => void; remove: () => void }>();

  constructor(layer: HTMLElement) {
    this.el = h('div', { class: 'toasts', role: 'status', aria: { live: 'polite' } });
    layer.appendChild(this.el);
  }

  push(t: ToastPayload): void {
    if (!t || !t.text) return;
    if (this.queue.some((q) => q.text === t.text)) return;
    const shown = this.showing.get(t.text);
    if (shown) {
      if (shown.el === this.el.lastElementChild && this.queue.length === 0) { shown.restart(); return; }
      shown.remove();
    }
    this.queue.push(t);
    this.drain();
  }

  /** Drops everything; pending removal timers are cancelled so `active` cannot go negative later. */
  clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.queue = []; this.el.replaceChildren(); this.active = 0; this.showing.clear();
  }

  private drain(): void {
    while (this.active < this.maxVisible && this.queue.length) {
      const t = this.queue.shift()!;
      this.showOne(t);
    }
  }

  private showOne(t: ToastPayload): void {
    const kind = t.kind ?? 'info';
    const iconName = kind === 'success' ? 'check' : kind === 'warn' ? 'warning' : kind === 'error' ? 'warning' : 'info';
    const el = h('div', { class: `panel toast toast-${kind}` }, icon(iconName), h('span', { text: t.text }));
    this.el.appendChild(el);
    this.active++;
    requestAnimationFrame(() => el.classList.add('in'));
    const dur = Math.max(1200, t.durationMs ?? (kind === 'error' ? 6000 : 3500));
    let removed = false;
    const later = (fn: () => void, ms: number) => { const id = setTimeout(() => { this.timers.delete(id); fn(); }, ms); this.timers.add(id); return id; };
    const remove = () => {
      if (removed) return;
      removed = true;
      if (this.showing.get(t.text)?.el === el) this.showing.delete(t.text);
      el.classList.remove('in');
      later(() => { el.remove(); this.active--; this.drain(); }, 200);
    };
    let timer = later(remove, dur);
    const restart = (): void => { if (removed) return; clearTimeout(timer); this.timers.delete(timer); timer = later(remove, dur); };
    this.showing.set(t.text, { el, restart, remove });
    el.addEventListener('click', () => { clearTimeout(timer); this.timers.delete(timer); remove(); });
  }
}
