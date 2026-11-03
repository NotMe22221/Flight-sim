/**
 * In-flight objectives (MSFS activity panel), the body of the 'objectives' FloatingPanel: activity
 * title, the current step ("Step 2 of 7 · Climb 500 ft"), its objectives with status icons
 * (optional ones dimmed) and thin progress bars, and the live "what to correct now" hint.
 *
 * Rows are rebuilt only on 'activity:progress' (status changes, step changes). Between events
 * update() reads the runner's live objective views (progress, state) and liveHint and writes the
 * DOM only when a displayed value changes (progress in whole percent, at most 10 Hz).
 */
import type { ObjectiveView } from '../../activities/objectives';
import type { UiHost } from '../UiHost';
import { Cls, Txt, clear, h, icon } from '../dom';
import { ICONS } from '../icons';
import { STATUS_ICON, objectivesVm, progressPct, type ObjStatus, type ProgressPayload } from '../activityModels';

const LIVE_INTERVAL_MS = 100;
/** a live hint that just cleared stays up this long (no flicker at the tolerance edge) */
const HINT_HOLD_MS = 1000;

interface RowRefs { li: HTMLElement; mark: HTMLElement; bar: HTMLElement; status: ObjStatus; pct: number }

export class ObjectivesPanel {
  readonly el: HTMLElement;
  private kind: Txt;
  private title: Txt;
  private stepLabel: Txt;
  private stepTitle: Txt;
  private overall: HTMLElement;
  private overallPct = -1;
  private list: HTMLElement;
  private next: Txt;
  private hintBox: HTMLElement;
  private hintText: Txt;
  private hintOn: Cls;
  private outcome: HTMLElement;
  private rows: RowRefs[] = [];
  private step = -1;
  private activityId: string | null = null;
  private finished = false;
  private lastLive = -Infinity;
  private hintShown = '';
  private hintClearedAt = 0;

  constructor(parent: HTMLElement, private readonly host: UiHost) {
    this.kind = new Txt(h('span', { class: 'badge badge-accent obj-kind' }), 'Lesson');
    this.title = new Txt(h('div', { class: 'obj-title' }), '');
    this.stepLabel = new Txt(h('span', { class: 'obj-step-label' }), '');
    this.stepTitle = new Txt(h('span', { class: 'obj-step-title' }), '');
    this.overall = h('span');
    this.list = h('ul', { class: 'obj-list', aria: { label: 'Objectives' } });
    this.next = new Txt(h('div', { class: 'obj-next' }), '');
    this.hintText = new Txt(h('span'), '');
    this.hintBox = h('div', { class: 'obj-hint', role: 'status', aria: { live: 'polite' } }, icon('warning'), this.hintText.el);
    this.hintOn = new Cls(this.hintBox, 'visible');
    this.outcome = h('div', { class: 'obj-outcome' });
    this.el = h('div', { class: 'obj-panel' },
      h('div', { class: 'obj-head' }, this.kind.el, this.title.el),
      h('div', { class: 'obj-step' }, this.stepLabel.el, this.stepTitle.el),
      h('div', { class: 'act-bar obj-overall', aria: { hidden: true } }, this.overall),
      this.list, this.hintBox, this.next.el, this.outcome);
    parent.appendChild(this.el);
    this.idle();
  }

  /** The activity whose objectives are shown (null: none since the last reset). */
  get currentId(): string | null { return this.activityId; }

  /** 'activity:started' */
  begin(p: { id: string; title: string; kind: string }): void {
    this.activityId = p.id;
    this.finished = false;
    this.kind.set(p.kind === 'bushTrip' ? 'Bush trip' : 'Lesson');
    this.title.set(p.title);
    this.stepLabel.set('Getting ready');
    this.stepTitle.set('');
    this.next.set('');
    this.outcome.className = 'obj-outcome';
    this.outcome.textContent = '';
    this.setHint('', 0, true);
    this.setRows([]);
    this.setOverall(0);
    this.el.classList.remove('idle', 'finished');
  }

  /** 'activity:progress': the current step's rows (rebuilt). */
  setProgress(p: ProgressPayload): void {
    if (this.activityId !== null && p.id !== this.activityId) return;
    if (this.activityId === null) this.activityId = p.id;
    const def = this.runnerDef(p.id);
    const vm = objectivesVm(p, def);
    this.step = vm.step;
    this.stepLabel.set(vm.stepLabel);
    this.stepTitle.set(vm.stepTitle);
    this.next.set(this.finished ? '' : vm.next ?? '');
    this.setOverall(vm.totalCount ? vm.doneCount / vm.totalCount : 0);
    this.setRows(vm.rows);
  }

  /** 'activity:finished' */
  finish(p: { id: string; success: boolean; score?: number }): void {
    if (this.activityId !== null && p.id !== this.activityId) return;
    this.finished = true;
    this.el.classList.add('finished');
    this.setHint('', 0, true);
    this.next.set('');
    this.outcome.className = `obj-outcome ${p.success ? 'ok' : 'err'}`;
    this.outcome.textContent = p.success ? `Complete${typeof p.score === 'number' ? ` · ${Math.round(p.score)}/100` : ''}` : 'Not completed';
  }

  /** No activity (new free flight, aborted). */
  idle(): void {
    this.activityId = null;
    this.finished = false;
    this.step = -1;
    this.kind.set('Activity');
    this.title.set('No activity running');
    this.stepLabel.set('');
    this.stepTitle.set('');
    this.next.set('Start a lesson or a bush trip from Activities.');
    this.outcome.className = 'obj-outcome';
    this.outcome.textContent = '';
    this.setRows([]);
    this.setOverall(0);
    this.setHint('', 0, true);
    this.el.classList.add('idle');
    this.el.classList.remove('finished');
  }

  /** Per frame while the panel is visible: live progress bars, row states and the hint. */
  update(nowMs: number): void {
    const r = this.host.activityRunner;
    if (!r || this.finished || this.activityId === null) return;
    let hint = '';
    try { hint = r.phase === 'running' && r.def?.id === this.activityId ? r.liveHint?.text ?? '' : ''; } catch { hint = ''; }
    this.setHint(hint, nowMs, false);
    if (nowMs - this.lastLive < LIVE_INTERVAL_MS) return;
    this.lastLive = nowMs;
    let views: readonly ObjectiveView[];
    try {
      if (r.phase !== 'running' || r.stepIndex !== this.step || r.def?.id !== this.activityId) return;
      views = r.objectives;
    } catch { return; }
    if (views.length !== this.rows.length) return;
    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      // the runner reports a pending objective of the current step as active (emitProgress)
      const st: ObjStatus = v.state === 'pending' ? 'active' : v.state;
      this.applyRow(this.rows[i], st, st === 'done' ? 100 : progressPct(v.progress));
    }
  }

  private runnerDef(id: string) {
    try { const d = this.host.activityRunner?.def; return d && d.id === id ? d : null; } catch { return null; }
  }

  private setRows(rows: ReturnType<typeof objectivesVm>['rows']): void {
    clear(this.list);
    this.rows = rows.map((r) => {
      const mark = h('span', { class: 'obj-mark' });
      const bar = h('span');
      const li = h('li', { class: `obj-row${r.optional ? ' optional' : ''}` },
        mark,
        h('div', { class: 'obj-body' },
          h('div', { class: 'obj-text' }, h('span', { text: r.text }), r.optional ? h('span', { class: 'obj-opt', text: 'Optional' }) : null),
          h('div', { class: 'act-bar obj-bar', aria: { hidden: true } }, bar)));
      const refs: RowRefs = { li, mark, bar, status: 'pending', pct: -1 };
      this.applyRow(refs, r.status, progressPct(r.progress), true);
      this.list.appendChild(li);
      return refs;
    });
    if (!rows.length && !this.el.classList.contains('idle')) this.list.appendChild(h('li', { class: 'obj-empty muted', text: 'Waiting for the first step…' }));
  }

  private applyRow(r: RowRefs, status: ObjStatus, pct: number, force = false): void {
    if (force || status !== r.status) {
      r.status = status;
      r.li.dataset.status = status;
      r.mark.innerHTML = ICONS[STATUS_ICON[status]];
    }
    if (force || pct !== r.pct) { r.pct = pct; r.bar.style.width = `${pct}%`; }
  }

  private setOverall(f: number): void {
    const pct = progressPct(f);
    if (pct === this.overallPct) return;
    this.overallPct = pct;
    this.overall.style.width = `${pct}%`;
  }

  private setHint(text: string, nowMs: number, immediate: boolean): void {
    if (text) {
      this.hintClearedAt = 0;
      if (text !== this.hintShown) { this.hintShown = text; this.hintText.set(text); }
      this.hintOn.set(true);
      return;
    }
    if (!this.hintShown) return;
    if (immediate) { this.hintShown = ''; this.hintOn.set(false); this.hintClearedAt = 0; return; }
    if (!this.hintClearedAt) { this.hintClearedAt = nowMs || 1; return; }
    if (nowMs - this.hintClearedAt >= HINT_HOLD_MS) { this.hintShown = ''; this.hintOn.set(false); this.hintClearedAt = 0; }
  }
}
