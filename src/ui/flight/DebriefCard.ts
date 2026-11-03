/**
 * Activity debrief (MSFS end-of-lesson card) from the runner's result: outcome, score and grade,
 * summary, time, landing score and fuel, every step with its objectives and notes, and the actions
 * Retry · Next leg (bush trips, when unlocked) · Close. The pure content lives in activityModels.
 */
import { button, h, icon, trapFocus, clear } from '../dom';
import type { DebriefVm } from '../activityModels';

export interface DebriefActions {
  retry?: () => void;
  nextLeg?: (tripId: string, legIndex: number) => void;
  /** re-open the landing report of the activity's landing */
  landingDetails?: () => void;
  /** the card closed: `byAction` when one of the action buttons (Retry, Next leg, Landing report) took over */
  onClose?: (byAction: boolean) => void;
}

export class DebriefCard {
  readonly el: HTMLElement;
  private card: HTMLElement;
  private actions: DebriefActions = {};

  constructor(layer: HTMLElement) {
    this.card = h('div', { class: 'panel debrief', role: 'dialog', aria: { label: 'Debrief' } });
    trapFocus(this.card);
    this.el = h('div', { class: 'modal-backdrop debrief-backdrop' }, this.card);
    layer.appendChild(this.el);
  }

  get visible(): boolean { return this.el.classList.contains('visible'); }

  show(vm: DebriefVm, a: DebriefActions): void {
    this.actions = a;
    clear(this.card);
    this.card.classList.toggle('fail', !vm.success);
    const kv: HTMLElement[] = [h('span', { class: 'kv-k', text: 'Time' }), h('span', { class: 'kv-v', text: vm.duration })];
    if (vm.landing) kv.push(h('span', { class: 'kv-k', text: 'Landing' }), h('span', { class: 'kv-v', text: vm.landing.text }));
    const steps = h('div', { class: 'debrief-steps scroll' },
      ...vm.steps.map((s) => h('div', { class: `debrief-step${s.completed ? ' completed' : ''}` },
        h('div', { class: 'debrief-step-head' },
          h('span', { class: 'debrief-step-title', text: s.title }),
          h('span', { class: 'spacer' }),
          h('span', { class: 'debrief-step-score tnum', text: s.completed ? `${s.score}` : '—' })),
        h('ul', { class: 'debrief-objs' }, ...s.objectives.map((o) => h('li', { class: `debrief-obj ${o.cls}${o.optional ? ' optional' : ''}` },
          icon(o.icon),
          h('span', { class: 'debrief-obj-label', text: o.label }),
          o.note ? h('span', { class: 'debrief-obj-note', text: o.note }) : null))))));
    const buttons: HTMLButtonElement[] = [];
    if (a.landingDetails && vm.landing) buttons.push(button('Landing report', () => { const f = a.landingDetails; this.hide(true); f?.(); }, { icon: 'trophy', cls: 'btn-ghost' }));
    if (a.retry) buttons.push(button('Retry', () => { const f = a.retry; this.hide(true); f?.(); }, { icon: 'restart' }));
    const next = vm.nextLeg;
    if (next && a.nextLeg) buttons.push(button(next.label, () => { const f = a.nextLeg; this.hide(true); f?.(next.tripId, next.legIndex); }, { icon: 'play', primary: vm.success }));
    const close = button('Close', () => this.hide(), { primary: !(next && a.nextLeg && vm.success) });
    buttons.push(close);
    this.card.append(
      h('div', { class: 'row debrief-top' }, icon(vm.success ? 'trophy' : 'flag'),
        h('span', { class: 'section-label', style: 'margin:0;border:0;flex:1', text: `Debrief · ${vm.kindLabel}` })),
      h('h2', { class: 'debrief-title', text: vm.title }),
      h('div', { class: `debrief-headline ${vm.success ? 'ok' : 'err'}`, text: vm.headline }),
      h('div', { class: 'debrief-score' },
        h('span', { class: 'debrief-score-v tnum', text: String(vm.score) }), h('span', { class: 'debrief-score-of', text: '/100' }),
        h('span', { class: 'debrief-grade', text: vm.grade })),
      ...(vm.reason ? [h('div', { class: 'debrief-reason' }, icon('warning'), h('span', { text: vm.reason }))] : []),
      h('p', { class: 'debrief-summary muted', text: vm.summary }),
      h('div', { class: 'kv debrief-kv' }, ...kv),
      h('div', { class: 'section-label', text: 'Objectives' }),
      steps,
      h('div', { class: 'row debrief-actions' }, ...buttons));
    this.el.classList.add('visible');
    (this.card.querySelector<HTMLButtonElement>('.debrief-actions .btn-primary') ?? close).focus();
  }

  /** Closes the card; onClose runs either way (the owner re-evaluates keyboard capture). */
  hide(byAction = false): void {
    if (!this.visible) return;
    this.el.classList.remove('visible');
    const cb = this.actions.onClose;
    this.actions = {};
    cb?.(byAction);
  }
}
