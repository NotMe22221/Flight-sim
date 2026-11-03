/**
 * Instructor subtitles in flight: lines from 'activity:instruction' arrive in bursts (an objective's
 * "done" line, the step's success line and the next instruction in the same frame). Each line is
 * shown for its own duration; a waiting line replaces the current one once that has been readable
 * for `minShowMs`. Pure (the caller passes the clock), so it is unit-tested in Node.
 */
export interface SubtitleLine { text: string; speaker: string; important: boolean; durationMs: number }

/** Frame gaps longer than this are time spent off the flight view (menus, loading): not counted. */
export const SUBTITLE_MAX_STEP_MS = 250;

export class SubtitleQueue {
  private cur: SubtitleLine | null = null;
  private shownMs = 0;
  private readonly waiting: SubtitleLine[] = [];
  private last = Number.NaN;

  constructor(private readonly minShowMs = 2500, private readonly maxWaiting = 3) {}

  /** The line on screen, if any. */
  get current(): SubtitleLine | null { return this.cur; }
  get pending(): number { return this.waiting.length; }

  push(line: SubtitleLine): void {
    if (!line.text) return;
    // the same line again (a repeated hint): keep it up for its full time
    if (this.cur && this.cur.text === line.text) { this.cur = { ...line, important: line.important || this.cur.important }; this.shownMs = 0; return; }
    if (this.waiting.some((w) => w.text === line.text)) return;
    this.waiting.push(line);
    while (this.waiting.length > this.maxWaiting) {
      const i = this.waiting.findIndex((w) => !w.important);
      this.waiting.splice(i >= 0 ? i : 0, 1);
    }
  }

  /** Advance the clock; returns the line to show (null: hide). Paused time does not count. */
  update(nowMs: number, paused = false): SubtitleLine | null {
    const dt = Number.isFinite(this.last) && Number.isFinite(nowMs) ? Math.min(SUBTITLE_MAX_STEP_MS, Math.max(0, nowMs - this.last)) : 0;
    this.last = nowMs;
    if (this.cur && !paused) this.shownMs += dt;
    if (this.cur && (this.shownMs >= this.cur.durationMs || (this.waiting.length > 0 && this.shownMs >= this.minShowMs))) this.cur = null;
    if (!this.cur && this.waiting.length > 0) { this.cur = this.waiting.shift()!; this.shownMs = 0; }
    return this.cur;
  }

  clear(): void { this.cur = null; this.waiting.length = 0; this.shownMs = 0; }
}
