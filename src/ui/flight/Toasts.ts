/** Bottom-centre toast queue fed by 'ui:toast'. At most three visible; the rest wait. */
import type { SimEvents } from '../../core/types';
import { h, icon } from '../dom';

type ToastPayload = SimEvents['ui:toast'];

export class Toasts {
  readonly el: HTMLElement;
  private queue: ToastPayload[] = [];
  private active = 0;
  private readonly maxVisible = 3;

  constructor(layer: HTMLElement) {
    this.el = h('div', { class: 'toasts', role: 'status', aria: { live: 'polite' } });
    layer.appendChild(this.el);
  }

  push(t: ToastPayload): void {
    if (!t || !t.text) return;
    this.queue.push(t);
    this.drain();
  }

  clear(): void { this.queue = []; this.el.replaceChildren(); this.active = 0; }

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
    const remove = () => {
      el.classList.remove('in');
      setTimeout(() => { el.remove(); this.active--; this.drain(); }, 200);
    };
    const timer = setTimeout(remove, dur);
    el.addEventListener('click', () => { clearTimeout(timer); remove(); });
  }
}
