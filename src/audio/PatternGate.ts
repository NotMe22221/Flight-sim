/**
 * Look-ahead scheduler that keys a gain AudioParam on and off following a repeating rhythm
 * (Morse-like marker-beacon keying, overspeed clacker). Edges are scheduled with
 * `setTargetAtTime` a little ahead of the audio clock, so the rhythm stays sample-accurate even
 * when the render loop stutters. Allocation-free per update.
 */

/** A rhythm as alternating durations [on, off, on, off, …] in seconds (even length). */
export type GatePattern = ReadonlyArray<number>;

/** Keys `gain` with a {@link GatePattern}. */
export class PatternGate {
  private pattern: GatePattern | null = null;
  private idx = 0;
  private nextT = 0;
  private level = 1;
  private _edges = 0;

  /**
   * @param gain the gain param to key (intrinsic value should be 0)
   * @param edgeTau time constant of each on/off edge (avoids clicks), s
   * @param lookaheadS how far ahead of the audio clock edges are scheduled, s
   */
  constructor(private readonly gain: AudioParam, private readonly edgeTau = 0.002, private readonly lookaheadS = 0.12) {}

  /** True while a pattern is playing. */
  get active(): boolean { return this.pattern !== null; }
  /** Total edges scheduled so far (test / debug counter). */
  get edges(): number { return this._edges; }

  /** Start (or restart) a pattern at time `now` with peak gain `level`. */
  start(pattern: GatePattern, now: number, level = 1): void {
    if (pattern.length < 2 || pattern.length % 2 !== 0) throw new RangeError('PatternGate: pattern must be [on, off, …] pairs');
    this.stop(now);
    this.pattern = pattern;
    this.level = level;
    this.idx = 0;
    this.nextT = now + 0.005;
    this.update(now);
  }

  /** Stop: cancel edges not yet reached and fade out. */
  stop(now: number): void {
    if (!this.pattern) return;
    this.pattern = null;
    this.gain.cancelScheduledValues(now);
    this.gain.setTargetAtTime(0, now, this.edgeTau);
  }

  /** Schedule every edge up to `now + lookahead`. Call once per frame. */
  update(now: number): void {
    const p = this.pattern;
    if (!p) return;
    if (this.nextT < now) { // fell behind (tab in background): resync without a burst of edges
      this.nextT = now + 0.005;
      this.idx = 0;
    }
    const horizon = now + this.lookaheadS;
    while (this.nextT <= horizon) {
      const on = this.idx % 2 === 0;
      this.gain.setTargetAtTime(on ? this.level : 0, this.nextT, this.edgeTau);
      this._edges++;
      this.nextT += Math.max(0.001, p[this.idx]);
      this.idx = (this.idx + 1) % p.length;
    }
  }
}
