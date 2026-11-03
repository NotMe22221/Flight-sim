/** Splash: title, cycling tips, progress from 'terrain:progress', click to start (audio unlock). */
import { Screen } from './Screen';
import { h, icon } from '../dom';
import { LOADING_TIPS, randomTip } from '../data/tips';

export type LoadingMode = 'boot' | 'flight';

export class LoadingScreen extends Screen {
  private bar: HTMLElement;
  private text: HTMLElement;
  private tip: HTMLElement;
  private cta: HTMLElement;
  private sub: HTMLElement;
  private tipTimer: ReturnType<typeof setInterval> | null = null;
  private mode: LoadingMode = 'boot';
  private started = false;
  private progress = 0;
  private currentTip = LOADING_TIPS[0];
  /** Fired on the first click/keypress of the boot screen: the integrator wires audio.resume() here. */
  onStart: (() => void) | null = null;
  /** Fired when the boot screen is dismissed (after onStart). */
  onDismiss: (() => void) | null = null;

  constructor() {
    super('loading');
    this.bar = h('div', { class: 'progress-bar' });
    this.text = h('div', { class: 'progress-text', text: 'Loading…' });
    this.tip = h('p', { class: 'loading-tip', text: this.currentTip });
    this.sub = h('div', { class: 'loading-sub', text: 'Browser flight simulator' });
    this.cta = h('div', { class: 'click-to-start hidden' }, icon('play'), ' Click or press any key to start');
    this.el.append(
      h('div', { class: 'row', style: 'gap:14px;align-items:center' }, icon('plane'), h('h1', { class: 'loading-title', text: 'Flight Sim' })),
      this.sub,
      h('div', { class: 'progress', role: 'progressbar', aria: { valuemin: '0', valuemax: '100', valuenow: '0' } }, this.bar),
      this.text, this.tip, this.cta,
    );
    this.el.addEventListener('click', () => this.tryStart());
    this.el.tabIndex = -1;
  }

  setMode(mode: LoadingMode): void {
    this.mode = mode;
    this.sub.textContent = mode === 'boot' ? 'Browser flight simulator' : 'Preparing your flight';
    if (mode === 'flight') { this.cta.classList.add('hidden'); this.text.textContent = 'Loading terrain…'; }
    else this.cta.classList.toggle('hidden', this.started);
  }

  /** 0..1 */
  setProgress(ready: number): void {
    this.progress = Math.max(0, Math.min(1, ready));
    const pct = Math.round(this.progress * 100);
    this.bar.style.width = `${pct}%`;
    this.bar.parentElement?.setAttribute('aria-valuenow', String(pct));
    this.text.textContent = this.progress >= 0.999 ? (this.mode === 'boot' ? 'Ready' : 'Ready to fly') : `Loading terrain ${pct}%`;
  }

  /** Key press on the boot screen also starts. */
  override onKey(e: KeyboardEvent): boolean {
    if (this.mode === 'boot' && !e.repeat) { this.tryStart(); return true; }
    return false;
  }

  private tryStart(): void {
    if (this.mode !== 'boot' || this.started) return;
    this.started = true;
    this.cta.classList.add('hidden');
    try { this.onStart?.(); } catch (e) { console.error('[ui] onStart threw', e); }
    this.onDismiss?.();
  }

  protected override onShow(): void {
    if (this.mode === 'boot' && !this.started) this.cta.classList.remove('hidden');
    this.rotateTip();
    this.tipTimer = setInterval(() => this.rotateTip(), 6000);
    this.el.focus();
  }
  protected override onHide(): void { if (this.tipTimer) { clearInterval(this.tipTimer); this.tipTimer = null; } }

  private rotateTip(): void {
    this.tip.classList.add('fade');
    setTimeout(() => { this.currentTip = randomTip(this.currentTip); this.tip.textContent = this.currentTip; this.tip.classList.remove('fade'); }, 300);
  }
}
