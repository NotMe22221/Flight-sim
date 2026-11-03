/**
 * Activities › Flight training: one card per lesson (LESSONS in src/activities) with the saved
 * best score / completed badge, a detail card with the lesson plan and Start → host.startLesson.
 */
import type { ScreenContext } from '../Screen';
import { button, clear, h, icon, isNarrowScreen } from '../../dom';
import { LESSONS } from '../../../activities/lessons';
import type { ActivityDef } from '../../../activities/activityTypes';
import { lessonCard, type LessonCardVm } from '../../activityModels';
import { StartGate, errText, type ActivityTabView } from './types';

/** 'Cessna 172S Skyhawk' for a lesson written for 'c172' (catalog ids carry a variant suffix). */
export function aircraftName(ctx: ScreenContext, id: string | undefined): string | null {
  if (!id) return null;
  try {
    const list = ctx.host.aircraftList();
    return (list.find((a) => a.id === id) ?? list.find((a) => a.id.startsWith(id)))?.name ?? null;
  } catch { return null; }
}

export class TrainingTab implements ActivityTabView {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private detail: HTMLElement;
  private selectedId: string | null = null;
  private cards = new Map<string, HTMLElement>();
  private startBtn: HTMLButtonElement | null = null;
  private gate: StartGate;

  constructor(private readonly ctx: ScreenContext) {
    this.gate = new StartGate(ctx);
    this.list = h('div', { class: 'act-list scroll', role: 'listbox', aria: { label: 'Lessons' } });
    this.detail = h('aside', { class: 'panel act-detail split' });
    this.el = h('div', { class: 'screen-body act-body' },
      h('div', { class: 'act-left' },
        h('div', { class: 'act-intro muted', text: 'Learn to fly the Cessna 172 with an instructor: each lesson is a series of steps with live objectives, coaching and a graded debrief.' }),
        this.list),
      this.detail);
  }

  private lessons(): readonly ActivityDef[] { return LESSONS; }
  private card(def: ActivityDef): LessonCardVm { return lessonCard(def, this.ctx.host.activityProgress, this.ctx.settings().units); }

  onShow(): void {
    const all = this.lessons();
    if (!this.selectedId || !all.some((l) => l.id === this.selectedId)) {
      // the first lesson not completed yet, as MSFS suggests the next lesson
      this.selectedId = (all.find((l) => !this.card(l).completed) ?? all[0])?.id ?? null;
    }
    this.gate.reset();
    this.renderList();
    this.renderDetail();
  }

  update(): void { this.gate.update(); }

  focus(): void { (this.startBtn && !this.startBtn.disabled ? this.startBtn : this.cards.get(this.selectedId ?? '') ?? null)?.focus({ preventScroll: true }); }

  private renderList(): void {
    clear(this.list);
    this.cards.clear();
    const all = this.lessons();
    if (!all.length) { this.list.appendChild(h('div', { class: 'empty', text: 'No lessons in this build' })); return; }
    all.forEach((def, i) => {
      const vm = this.card(def);
      const card = h('div', {
        class: `panel act-card lesson-card${vm.completed ? ' completed' : ''}`, role: 'option', tabIndex: 0, aria: { selected: def.id === this.selectedId },
        dataset: { lesson: def.id },
        onClick: () => this.select(def.id),
        onKeyDown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (this.selectedId === def.id) this.start(def); else this.select(def.id); }
          else if (e.key === ' ') { e.preventDefault(); this.select(def.id); }
        },
      },
      h('div', { class: 'row' },
        h('span', { class: 'act-num', text: String(i + 1).padStart(2, '0') }),
        h('span', { class: 'act-title', text: vm.title }),
        h('span', { class: 'spacer' }),
        vm.completed ? h('span', { class: 'badge badge-ok' }, icon('check'), ' Completed') : null),
      h('div', { class: 'act-meta', text: vm.meta }),
      h('div', { class: 'act-desc', text: vm.description }),
      h('div', { class: 'act-best' }, icon('trophy'), vm.status));
      card.classList.toggle('selected', def.id === this.selectedId);
      this.cards.set(def.id, card);
      this.list.appendChild(card);
    });
  }

  private select(id: string): void {
    this.selectedId = id;
    for (const [k, el] of this.cards) { el.classList.toggle('selected', k === id); el.setAttribute('aria-selected', String(k === id)); }
    this.gate.reset();
    this.renderDetail();
    if (isNarrowScreen()) this.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private renderDetail(): void {
    clear(this.detail);
    this.startBtn = null;
    const def = this.lessons().find((l) => l.id === this.selectedId);
    if (!def) { this.detail.appendChild(h('div', { class: 'empty', text: 'Select a lesson' })); return; }
    const vm = this.card(def);
    const canStart = typeof this.ctx.host.startLesson === 'function';
    const plane = aircraftName(this.ctx, def.aircraft);
    this.startBtn = this.gate.add(button('Start', () => this.start(def), { primary: true, big: true, icon: 'play', title: canStart ? `Start ${def.title}` : 'Not available in this build' }), canStart);
    const kv: (HTMLElement | null)[] = [
      h('span', { class: 'kv-k', text: 'Start' }), h('span', { class: 'kv-v', text: vm.start }),
      h('span', { class: 'kv-k', text: 'Weather' }), h('span', { class: 'kv-v', text: vm.weather }),
      h('span', { class: 'kv-k', text: 'Time' }), h('span', { class: 'kv-v', text: vm.time }),
    ];
    if (plane) kv.push(h('span', { class: 'kv-k', text: 'Aircraft' }), h('span', { class: 'kv-v', text: plane }));
    if (vm.duration) kv.push(h('span', { class: 'kv-k', text: 'Duration' }), h('span', { class: 'kv-v', text: vm.duration }));
    if (vm.difficulty) kv.push(h('span', { class: 'kv-k', text: 'Level' }), h('span', { class: 'kv-v', text: vm.difficulty }));
    const body = h('div', { class: 'act-detail-body scroll' },
      h('div', { class: 'row' }, h('span', { class: 'badge badge-accent', text: 'Lesson' }), h('span', { class: 'spacer' }),
        vm.completed ? h('span', { class: 'badge badge-ok' }, icon('check'), ' Completed') : null),
      h('h2', { class: 'act-detail-title', text: vm.title }),
      h('p', { class: 'muted', style: 'margin:0', text: vm.description }),
      h('div', { class: 'section-label', text: 'Briefing' }),
      h('div', { class: 'kv' }, ...kv),
      h('div', { class: 'section-label', text: `Lesson plan · ${vm.steps.length} steps` }),
      h('ol', { class: 'act-steps' }, ...vm.steps.map((t) => h('li', { text: t }))),
      h('div', { class: 'act-best big' }, icon('trophy'), vm.status));
    const foot = h('div', { class: 'act-detail-foot' },
      h('div', { class: 'muted act-note', text: canStart
        ? 'Your instructor talks you through each step. Objectives and live hints appear in flight; Esc pauses (restart a step or abort).'
        : 'Lessons are not available in this build.' }),
      h('div', { class: 'row act-actions' }, this.startBtn));
    this.detail.append(body, foot);
  }

  private start(def: ActivityDef): void {
    const host = this.ctx.host;
    if (typeof host.startLesson !== 'function' || this.gate.starting) return;
    if (this.ctx.startLesson) this.ctx.startLesson(def.id);
    else void host.startLesson(def.id).catch((e: unknown) => this.ctx.toast(`Could not start ${def.title}: ${errText(e)}`, 'error'));
  }
}
