/**
 * Start / shutdown sequencing for the engine sound (docs/research/06 §A2.6), driven by
 * `EngineState.running`, `EngineState.rpm` and `ControlInputs.starter`.
 *
 * ```
 *          starter              running              CATCH_S elapsed
 *   off ───────────► cranking ───────────► catching ─────────────────► running
 *    ▲                  │ starter released    │ !running                  │ !running
 *    │                  ▼                     ▼                           ▼
 *    └──── rpm < STOP_RPM or RUNDOWN_MAX_S ─ rundown ◄──────────────────────┘
 * ```
 *
 * When the starter switch state is unknown (the app never called `setStarter`), cranking is
 * inferred conservatively: a non-running engine spinning up from rest into the cranking band.
 * The FDM's rpm already ramps during start, so the synth needs no other special casing.
 */

/** Phase of the engine sound. */
export type EnginePhase = 'off' | 'cranking' | 'catching' | 'running' | 'rundown';

/** Timing constants of the sequencer, s / rpm. */
export const ENGINE_FSM = {
  /** duration of the cough-and-catch burst after combustion starts, s */
  CATCH_S: 0.6,
  /** maximum rundown time before declaring the engine stopped (windmilling props never reach 0), s */
  RUNDOWN_MAX_S: 8,
  /** rpm below which a running-down engine is considered stopped */
  STOP_RPM: 15,
  /** inferred cranking: rpm band of a starter-driven engine */
  CRANK_MIN_RPM: 40,
  CRANK_MAX_RPM: 450,
  /** inferred cranking: rpm acceleration that marks the starter engaging, rpm/s */
  CRANK_SPINUP_RPM_S: 60,
  /** inferred cranking ends when rpm decays faster than this, rpm/s */
  CRANK_DECAY_RPM_S: -80,
} as const;

/** Small state machine; `update` is allocation-free. */
export class EngineStartFsm {
  private _phase: EnginePhase = 'off';
  private _t = 0;
  private _entered = false;
  private lastRpm = 0;
  private rpmRate = 0;
  private first = true;

  /** Current phase. */
  get phase(): EnginePhase { return this._phase; }
  /** Seconds spent in the current phase. */
  get timeInPhase(): number { return this._t; }
  /** True for exactly one update after a phase change. */
  get justEntered(): boolean { return this._entered; }
  /** Smoothed rpm rate of change, rpm/s. */
  get rpmRateRpmS(): number { return this.rpmRate; }
  /** 0..1 progress through the catch burst (1 outside 'catching'). */
  get catchProgress(): number { return this._phase === 'catching' ? Math.min(1, this._t / ENGINE_FSM.CATCH_S) : 1; }

  /** Force a phase (e.g. on flight reset). */
  reset(phase: EnginePhase = 'off', rpm = 0): void {
    this._phase = phase; this._t = 0; this._entered = true; this.lastRpm = rpm; this.rpmRate = 0; this.first = false;
  }

  /**
   * Advance the sequencer.
   * @param dt frame time, s
   * @param running EngineState.running
   * @param rpm EngineState.rpm
   * @param starter ControlInputs.starter, or null when unknown (inferred from rpm)
   */
  update(dt: number, running: boolean, rpm: number, starter: boolean | null): EnginePhase {
    this._entered = false;
    const r = Number.isFinite(rpm) ? Math.max(0, rpm) : 0;
    if (dt > 0) {
      const inst = (r - this.lastRpm) / dt;
      const k = Math.min(1, dt / 0.1); // 0.1 s low-pass on the rate
      this.rpmRate += (inst - this.rpmRate) * k;
      this._t += dt;
    }
    this.lastRpm = r;
    if (this.first) { // spawning with the engine running must not play a start sequence
      this.first = false;
      if (running) { this.go('running'); return this._phase; }
    }
    const F = ENGINE_FSM;
    const cranking = starter ?? this.inferCranking(r);
    switch (this._phase) {
      case 'off':
        if (running) this.go('catching');
        else if (cranking) this.go('cranking');
        break;
      case 'cranking':
        if (running) this.go('catching');
        else if (!cranking) this.go(r > F.STOP_RPM ? 'rundown' : 'off');
        break;
      case 'catching':
        if (!running) this.go('rundown');
        else if (this._t >= F.CATCH_S) this.go('running');
        break;
      case 'running':
        if (!running) this.go('rundown');
        break;
      case 'rundown':
        if (running) this.go('catching');
        else if (starter === true) this.go('cranking');
        else if (r < F.STOP_RPM || this._t >= F.RUNDOWN_MAX_S) this.go('off');
        break;
    }
    return this._phase;
  }

  private inferCranking(rpm: number): boolean {
    const F = ENGINE_FSM;
    if (rpm < F.CRANK_MIN_RPM || rpm > F.CRANK_MAX_RPM) return false;
    if (this._phase === 'cranking') return this.rpmRate > F.CRANK_DECAY_RPM_S;
    return this._phase === 'off' && this.rpmRate > F.CRANK_SPINUP_RPM_S;
  }

  private go(p: EnginePhase): void {
    if (p === this._phase) return;
    this._phase = p;
    this._t = 0;
    this._entered = true;
  }
}
