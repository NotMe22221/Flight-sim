/**
 * Activities › Career (MSFS 2024-style, simplified): wallet, reputation and location; the licence ladder
 * with check-rides; and the job board at the pilot's airport. Fly → host.startCareerJob(id); check-ride →
 * host.startCareerExam(licence). The board loads the region around the pilot first (async).
 */
import type { ScreenContext } from '../Screen';
import type { CareerJobView, CareerView } from '../../UiHost';
import { Txt, button, clear, h, icon } from '../../dom';
import type { IconName } from '../../icons';
import { StartGate, errText, type ActivityTabView } from './types';

const TYPE_ICON: Record<string, IconName> = { practice: 'school', cargo: 'weight', passengers: 'plane', survey: 'eye', sar: 'target', medevac: 'warning' };
const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

export class CareerTab implements ActivityTabView {
  readonly el: HTMLElement;
  private header: HTMLElement;
  private ladder: HTMLElement;
  private board: HTMLElement;
  private history: HTMLElement;
  private gate: StartGate;
  private status = new Txt(h('div', { class: 'muted', style: 'font-size:.85em' }), '');
  private loadSeq = 0;
  private confirmReset = 0;

  constructor(private readonly ctx: ScreenContext) {
    this.gate = new StartGate(ctx);
    this.header = h('div', { class: 'career-header' });
    this.ladder = h('div', { class: 'career-ladder' });
    this.board = h('div', { class: 'career-board' });
    this.history = h('div', { class: 'career-history' });
    this.el = h('div', { class: 'screen-body career-body scroll' },
      this.header,
      h('div', { class: 'section-label', text: 'Job board' }), this.board, this.status.el,
      h('div', { class: 'section-label', text: 'Licences' }), this.ladder,
      h('div', { class: 'section-label', text: 'Recent jobs' }), this.history,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, button('Reset career', () => this.reset(), { cls: 'btn-sm', icon: 'restart', title: 'Start over as a student pilot at Palo Alto' })));
  }

  onShow(): void { this.render(); }
  update(): void { this.gate.update(); }
  focus(): void { (this.board.querySelector('button:not([disabled])') as HTMLButtonElement | null)?.focus({ preventScroll: true }); }

  private view(): CareerView | null {
    try { return this.ctx.host.career?.() ?? null; } catch { return null; }
  }

  private render(): void {
    const v = this.view();
    clear(this.header); clear(this.ladder); clear(this.history);
    this.gate.reset();
    if (!v) { this.header.appendChild(h('div', { class: 'empty', text: 'Career mode is not available in this build.' })); return; }
    const rank = [...v.ladder].reverse().find((l) => l.held)?.title ?? 'Student pilot';
    this.header.append(
      h('div', { class: 'career-stat' }, h('span', { class: 'kv-k', text: 'Balance' }), h('span', { class: 'career-big', text: money(v.money) })),
      h('div', { class: 'career-stat' }, h('span', { class: 'kv-k', text: 'Reputation' }), h('span', { class: 'career-big', text: `${Math.round(v.reputation)} / 100` })),
      h('div', { class: 'career-stat' }, h('span', { class: 'kv-k', text: 'Licence' }), h('span', { class: 'career-big', text: rank })),
      h('div', { class: 'career-stat' }, h('span', { class: 'kv-k', text: 'Location' }), h('span', { class: 'career-big', text: v.location.icao }), h('span', { class: 'muted', text: v.location.name })),
      h('div', { class: 'career-stat' }, h('span', { class: 'kv-k', text: 'Jobs · hours' }), h('span', { class: 'career-big', text: `${v.jobsDone} · ${v.logbookHours.toFixed(1)} h` })));
    for (const l of v.ladder) {
      const canExam = !l.held && l.exam && l.missing.length === 0 && typeof this.ctx.host.startCareerExam === 'function';
      const card = h('div', { class: `panel career-licence${l.held ? ' held' : ''}` },
        h('div', { class: 'row' }, icon(l.held ? 'circleCheck' : l.missing.length ? 'lock' : 'circle'), h('span', { class: 'act-title', text: l.title })),
        h('div', { class: 'act-meta', text: `Unlocks: ${l.unlocks}` }),
        ...(l.held ? [] : (l.missing.length ? l.missing : l.needs).map((n) => h('div', { class: 'muted career-need', text: `• ${n}` }))));
      if (canExam) card.appendChild(this.gate.add(button('Take the check-ride', () => this.exam(l.id), { primary: true, icon: 'play', cls: 'btn-sm' }), true));
      this.ladder.appendChild(card);
    }
    if (!v.history.length) this.history.appendChild(h('div', { class: 'muted', text: 'No jobs flown yet.' }));
    for (const j of v.history) this.history.appendChild(h('div', { class: 'career-row' }, h('span', { text: `${j.type}: ${j.from} → ${j.to}` }), h('span', { class: j.success ? 'career-pay' : 'career-fail', text: j.success ? `+${money(j.pay)}` : 'failed' })));
    void this.loadBoard();
  }

  private async loadBoard(): Promise<void> {
    const seq = ++this.loadSeq;
    clear(this.board);
    this.board.appendChild(h('div', { class: 'muted', text: 'Loading jobs near you…' }));
    let jobs: CareerJobView[] = [];
    try { jobs = (await this.ctx.host.careerJobs?.()) ?? []; } catch (e) { if (seq === this.loadSeq) this.status.set(`Could not load jobs: ${errText(e)}`); }
    if (seq !== this.loadSeq) return;
    clear(this.board);
    if (!jobs.length) { this.board.appendChild(h('div', { class: 'muted', text: 'No jobs here right now.' })); return; }
    for (const j of jobs) {
      const fly = this.gate.add(button('Fly', () => this.fly(j), { primary: !j.locked, icon: 'play', cls: 'btn-sm', title: j.locked ?? `Start: ${j.title}` }), !j.locked && typeof this.ctx.host.startCareerJob === 'function');
      this.board.appendChild(h('div', { class: `panel career-job${j.locked ? ' locked' : ''}` },
        icon(TYPE_ICON[j.type] ?? 'plane'),
        h('div', { class: 'career-job-main' },
          h('div', { class: 'row' }, h('span', { class: 'act-title', text: j.title }), h('span', { class: 'badge', text: j.typeLabel })),
          h('div', { class: 'act-meta', text: `${j.from} → ${j.to} · ${j.distanceNm} nm${j.payloadKg ? ` · ${j.payloadKg} kg` : ''}${j.timeLimitMin ? ` · ${j.timeLimitMin} min limit` : ''}` }),
          h('div', { class: 'muted career-need', text: j.locked ?? j.brief })),
        h('span', { class: 'career-pay', text: money(j.pay) }),
        fly));
    }
    this.status.set('Pay: 60 % on completion, the rest by how well you fly. A failed job costs reputation.');
  }

  private fly(j: CareerJobView): void {
    if (j.locked || this.gate.starting) return;
    if (this.ctx.startCareerJob) this.ctx.startCareerJob(j.id);
    else void this.ctx.host.startCareerJob?.(j.id).catch((e: unknown) => this.ctx.toast(`Could not start the job: ${errText(e)}`, 'error'));
  }

  private exam(id: string): void {
    if (this.gate.starting) return;
    if (this.ctx.startCareerExam) this.ctx.startCareerExam(id);
    else void this.ctx.host.startCareerExam?.(id).catch((e: unknown) => this.ctx.toast(`Could not start the check-ride: ${errText(e)}`, 'error'));
  }

  private reset(): void {
    const now = Date.now();
    if (now > this.confirmReset) { this.confirmReset = now + 3000; this.ctx.toast('Click "Reset career" again to start over', 'warn'); return; }
    this.confirmReset = 0;
    this.ctx.host.resetCareer?.();
    this.render();
  }
}
