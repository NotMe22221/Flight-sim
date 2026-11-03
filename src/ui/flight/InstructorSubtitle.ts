/**
 * Instructor / co-pilot subtitles for activities: a strip at the bottom centre, above the HUD's
 * controls strip, showing each 'activity:instruction' line for ~6 s (9 s when important, longer for
 * long lines). Bursts are queued (SubtitleQueue); paused time and time off the flight view do not
 * count, so the first instruction is still readable when the loading screen goes away.
 */
import { Cls, Txt, h } from '../dom';
import { speakerFor, subtitleDurationMs } from '../activityModels';
import { SubtitleQueue, type SubtitleLine } from '../subtitleQueue';

export class InstructorSubtitle {
  readonly el: HTMLElement;
  private readonly queue = new SubtitleQueue();
  private readonly from: Txt;
  private readonly text: Txt;
  private readonly visible: Cls;
  private readonly important: Cls;
  private shown: SubtitleLine | null = null;
  private speaker = speakerFor('lesson');

  constructor(layer: HTMLElement) {
    this.from = new Txt(h('span', { class: 'from' }), '');
    this.text = new Txt(h('span', { class: 'text' }), '');
    this.el = h('div', { class: 'panel instructor-subtitle', role: 'status', aria: { live: 'polite' } }, this.from.el, this.text.el);
    this.visible = new Cls(this.el, 'visible');
    this.important = new Cls(this.el, 'important');
    layer.appendChild(this.el);
  }

  /** Who is talking: 'Instructor' for lessons, 'Co-pilot' for bush trips. */
  setKind(kind: string | null | undefined): void { this.speaker = speakerFor(kind); }

  push(text: string, important = false): void {
    const t = typeof text === 'string' ? text.trim() : '';
    if (t) this.queue.push({ text: t, speaker: this.speaker, important, durationMs: subtitleDurationMs(t, important) });
  }

  /** Per frame in the flight view. */
  update(nowMs: number, paused: boolean): void {
    const line = this.queue.update(nowMs, paused);
    if (line === this.shown) return;
    this.shown = line;
    if (line) { this.from.set(line.speaker); this.text.set(line.text); this.important.set(line.important); }
    this.visible.set(!!line);
  }

  clear(): void { this.queue.clear(); this.shown = null; this.visible.set(false); }
}
