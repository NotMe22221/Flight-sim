/**
 * Runs one activity (lesson or bush-trip leg) at a time: asks the ActivityHost to set the
 * flight up, advances steps as their objectives complete, and reports on the EventBus:
 *
 *  - 'activity:started'      once, after the spawn has completed
 *  - 'activity:instruction'  step instructions (once per step), cues (once each), objective
 *                            "done" lines (once each), bounded hints, and the closing debrief line
 *  - 'activity:progress'     whenever an objective's status changes or the step advances
 *                            (never per frame); lists every objective of every step
 *  - 'activity:finished'     once, with the 0..100 score and a summary
 *
 * It listens to 'landing:scored' (landing objectives), 'aircraft:crash' (fails the activity) and
 * 'flight:reset' (a respawn at the activity's start restarts it, any other reset aborts it; the
 * resets caused by the runner's own spawns are ignored). Call update(dt, state, inputs) once per
 * physics step (or per frame) while the simulation runs; it does not allocate except on events.
 */
import type { EventBus } from '../core/events';
import type { AircraftState, ControlInputs, SimEvents, SpawnState } from '../core/types';
import { DEG, FT, KT } from '../core/units';
import { gradeFor, type ActivityDef, type ActivityHost, type ActivityResult, type Cue, type StepDef, type StepResult } from './activityTypes';
import {
  ConditionSet, compileObjective, flatDistanceM, makeObjectiveContext,
  type LandingResult, type Line, type Objective, type ObjectiveContext, type ObjectiveState, type ObjectiveView,
} from './objectives';
import type { ProgressStore } from './progressStore';

export type RunnerPhase = 'idle' | 'starting' | 'running' | 'finished';

export interface ActivityRunnerOptions {
  host: ActivityHost;
  events: EventBus;
  /** records attempts and results (lesson best scores, bush-trip legs) */
  progress?: ProgressStore | null;
  /** minimum seconds between two hints (default 8) */
  hintIntervalS?: number;
  /** the same hint is not repeated within this many seconds (default 20) */
  hintRepeatS?: number;
  /** send hints to host.speak too (default true; instructions and cues are always spoken) */
  speakHints?: boolean;
  /** a 'flight:reset' within this distance of the activity's start restarts it (default 5 km) */
  resetRadiusM?: number;
}

/** One entry of the 'activity:progress' payload (extra fields beyond the SimEvents contract). */
export interface ProgressItem {
  text: string;
  status: ObjectiveState;
  /** index of the step the objective belongs to */
  step: number;
  optional: boolean;
  /** 0..1 at the time of the event */
  progress: number;
}

interface ActiveCue { readonly set: ConditionSet; readonly cue: Cue; fired: boolean }

interface ActiveStep {
  readonly def: StepDef;
  readonly objectives: Objective[];
  readonly views: ObjectiveView[];
  readonly cues: ActiveCue[];
  readonly lastStates: ObjectiveState[];
  activated: boolean;
  time: number;
}

export class ActivityRunner {
  phase: RunnerPhase = 'idle';
  /** the current (or last) activity */
  def: ActivityDef | null = null;
  /** index of the current step (−1 before the first) */
  stepIndex = -1;
  /** debrief of the last finished activity */
  result: ActivityResult | null = null;
  /** the hint currently applicable (what to correct now), for an objectives panel; null when on target */
  liveHint: Line | null = null;
  /** the last hint actually announced */
  lastHint: Line | null = null;

  private readonly host: ActivityHost;
  private readonly events: EventBus;
  private readonly progress: ProgressStore | null;
  private readonly hintIntervalS: number;
  private readonly hintRepeatS: number;
  private readonly speakHints: boolean;
  private readonly resetRadiusM: number;
  private readonly offs: (() => void)[];

  private compiled: (Objective[] | null)[] = [];
  private cur: ActiveStep | null = null;
  private ctx: ObjectiveContext | null = null;
  private token = 0;
  private expectingReset = false;
  private elapsed = 0;
  private landing: LandingResult | null = null;
  private landingSeq = 0;
  private lastLandingScore: number | null = null;
  private lastState: AircraftState | null = null;
  // hint pacing
  private offTarget = 0;
  private sinceHint = 0;
  private coachIdx = 0;

  constructor(opts: ActivityRunnerOptions) {
    this.host = opts.host;
    this.events = opts.events;
    this.progress = opts.progress ?? null;
    this.hintIntervalS = opts.hintIntervalS ?? 8;
    this.hintRepeatS = opts.hintRepeatS ?? 20;
    this.speakHints = opts.speakHints ?? true;
    this.resetRadiusM = opts.resetRadiusM ?? 5000;
    this.offs = [
      this.events.on('landing:scored', (e) => this.onLanding(e)),
      this.events.on('aircraft:crash', (e) => this.onCrash(e.reason)),
      this.events.on('flight:reset', (e) => this.onReset(e.spawn)),
    ];
  }

  /** Unsubscribe from the event bus. */
  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  get running(): boolean { return this.phase === 'running'; }
  /** the current step definition */
  get step(): StepDef | null { return this.cur?.def ?? null; }
  /** live views of the current step's objectives (stable for the duration of a step) */
  get objectives(): readonly ObjectiveView[] { return this.cur?.views ?? []; }
  /** seconds since the activity started */
  get elapsedS(): number { return this.elapsed; }

  /**
   * Set up the flight and begin the first step. Weather is applied before the spawn (runway
   * selection may depend on the wind) and again after it (its layers are AGL at the current field),
   * the time preset and the route after it (sunrise-relative presets depend on the new position).
   * Rejects if the host cannot spawn.
   */
  async start(def: ActivityDef): Promise<void> {
    if (this.phase === 'running') this.finish(false, 'Replaced by another activity', false);
    const token = ++this.token;
    this.def = def;
    this.phase = 'starting';
    this.result = null;
    this.resetRunState();
    const s = def.setup;
    this.expectingReset = true;
    try {
      if (s.weather) this.host.setWeatherPreset(s.weather);
      if (s.spawn === 'runway') {
        await this.host.spawnAtRunway(s.icao, s.runway, { coldAndDark: s.coldAndDark, fuelFraction: s.fuelFraction, parkingBrake: s.parkingBrake });
      } else {
        await this.host.spawnInAir(s.lat, s.lon, s.altFt * FT, s.headingDeg, s.iasKt * KT, { flapsIndex: s.flapsIndex, gammaRad: (s.gammaDeg ?? 0) * DEG });
      }
    } catch (e) {
      if (token === this.token) { this.phase = 'idle'; this.def = null; this.expectingReset = false; }
      throw e;
    }
    if (token !== this.token) return; // aborted or superseded while spawning
    this.expectingReset = false;
    // again after the spawn: preset cloud and wind layers are AGL at the field current when it is applied, which
    // before the spawn was the previous flight's (a leg out of a 250 m field otherwise had its clouds 250 m low)
    if (s.weather) this.host.setWeatherPreset(s.weather);
    if (s.time) this.host.setTimePreset(s.time);
    if (s.route) this.host.loadRoute(s.route);
    this.phase = 'running';
    this.progress?.recordStart(def);
    this.events.emit('activity:started', { id: def.id, title: def.title, kind: def.kind });
    this.beginStep(0);
  }

  /** Start the current activity again from the setup. */
  restart(): Promise<void> {
    return this.def ? this.start(this.def) : Promise.resolve();
  }

  /** Stop the activity: a pending start is cancelled silently, a running one finishes unsuccessfully. */
  abort(reason = 'Aborted'): void {
    if (this.phase === 'starting') {
      this.token++;
      this.phase = 'idle';
      this.def = null;
      this.expectingReset = false;
    } else if (this.phase === 'running') this.finish(false, reason, false);
  }

  /** Reset the current step's objectives and repeat its instruction (the aircraft is not moved). */
  restartStep(): void {
    if (this.phase !== 'running' || this.stepIndex < 0) return;
    this.beginStep(this.stepIndex);
  }

  /** Advance the activity. Call every physics step (or frame) with the latest state and inputs. */
  update(dt: number, state: AircraftState, inputs: ControlInputs): void {
    const cur = this.cur;
    if (this.phase !== 'running' || !cur || !(dt > 0) || !Number.isFinite(dt)) return;
    const ctx = (this.ctx ??= makeObjectiveContext(state, inputs));
    ctx.state = state;
    ctx.inputs = inputs;
    ctx.dt = dt;
    ctx.landing = this.landing;
    ctx.landingSeq = this.landingSeq;
    this.lastState = state;
    this.elapsed += dt;
    cur.time += dt;
    const objs = cur.objectives;
    if (!cur.activated) {
      cur.activated = true;
      for (let i = 0; i < objs.length; i++) objs[i].activate(ctx);
      for (let i = 0; i < cur.cues.length; i++) cur.cues[i].set.activate(ctx);
    }
    for (let i = 0; i < objs.length; i++) objs[i].update(ctx);

    let changed = false;
    for (let i = 0; i < objs.length; i++) {
      const st = objs[i].view.state;
      if (st === cur.lastStates[i]) continue;
      cur.lastStates[i] = st;
      changed = true;
      const done = objs[i].spec.doneLine;
      if (st === 'done' && done) this.say(done, false, true);
    }
    for (let i = 0; i < cur.cues.length; i++) {
      const c = cur.cues[i];
      if (!c.fired && c.set.test(ctx)) { c.fired = true; this.say(c.cue.line, c.cue.important ?? true, true); }
    }

    let failed: Objective | null = null;
    let allDone = true;
    for (let i = 0; i < objs.length; i++) {
      const v = objs[i].view;
      if (v.optional) continue;
      if (v.state === 'failed') { failed = objs[i]; break; }
      if (v.state !== 'done') allDone = false;
    }
    if (failed) {
      if (changed) this.emitProgress();
      this.finish(false, failed.view.note ?? `${failed.view.label}: failed`);
      return;
    }
    if (allDone) { this.completeStep(); return; }
    if (changed) this.emitProgress();
    this.updateHints(dt, cur);
  }

  // ─────────────────────────────── steps ───────────────────────────────

  private resetRunState(): void {
    const def = this.def;
    this.compiled = def ? def.steps.map(() => null) : [];
    this.cur = null;
    this.stepIndex = -1;
    this.elapsed = 0;
    this.landing = null;
    this.lastLandingScore = null;
    this.liveHint = null;
    this.lastHint = null;
  }

  private beginStep(index: number): void {
    const def = this.def;
    if (!def) return;
    const step = def.steps[index];
    if (!step) { this.finish(true, null); return; }
    const objectives = step.objectives.map(compileObjective);
    this.compiled[index] = objectives;
    this.stepIndex = index;
    this.cur = {
      def: step,
      objectives,
      views: objectives.map((o) => o.view),
      cues: (step.cues ?? []).map((cue) => ({ set: new ConditionSet(cue.when), cue, fired: false })),
      // reported as 'active' from the start, so activation is not a change
      lastStates: objectives.map((): ObjectiveState => 'active'),
      activated: false,
      time: 0,
    };
    this.offTarget = 0;
    this.sinceHint = this.hintIntervalS;
    this.coachIdx = 0;
    this.liveHint = null;
    this.lastHint = null;
    this.say(step.instruction, true, true);
    this.emitProgress();
  }

  private completeStep(): void {
    const cur = this.cur;
    const def = this.def;
    if (!cur || !def) return;
    for (const o of cur.objectives) if (!o.finished) o.abandon(o.view.optional ? 'Missed' : 'Not completed');
    if (cur.def.success) this.say(cur.def.success, false, true);
    const next = this.stepIndex + 1;
    if (next < def.steps.length) this.beginStep(next);
    else { this.emitProgress(); this.finish(true, null); }
  }

  // ─────────────────────────────── hints ───────────────────────────────

  private updateHints(dt: number, cur: ActiveStep): void {
    this.sinceHint += dt;
    let hint: Line | null = null;
    if (!cur.def.quiet) {
      // a required objective's hint first, then an optional one's
      for (let pass = 0; pass < 2 && !hint; pass++) {
        for (let i = 0; i < cur.views.length; i++) {
          const v = cur.views[i];
          if (v.state === 'active' && v.hint && v.optional === (pass === 1)) { hint = v.hint; break; }
        }
      }
    }
    this.liveHint = hint;
    if (!hint) { this.offTarget = 0; return; }
    this.offTarget += dt;
    if (this.offTarget < (cur.def.hintDelayS ?? 4) || this.sinceHint < this.hintIntervalS) return;
    const coaching = cur.def.hints;
    const coach = coaching && this.coachIdx < coaching.length ? coaching[this.coachIdx] : null;
    const line = coach ?? hint;
    if (!coach && line === this.lastHint && this.sinceHint < this.hintRepeatS) return;
    if (coach) this.coachIdx++;
    this.lastHint = line;
    this.sinceHint = 0;
    this.offTarget = 0;
    this.say(line, false, this.speakHints);
  }

  // ─────────────────────────────── events ───────────────────────────────

  private say(line: Line, important: boolean, speak: boolean): void {
    const payload: SimEvents['activity:instruction'] = line.speech ? { text: line.text, speech: line.speech, important } : { text: line.text, important };
    this.events.emit('activity:instruction', payload);
    if (speak) this.host.speak?.(line.speech ?? line.text);
  }

  private emitProgress(): void {
    const def = this.def;
    if (!def) return;
    const items: ProgressItem[] = [];
    for (let si = 0; si < def.steps.length; si++) {
      const specs = def.steps[si].objectives;
      const compiled = this.compiled[si];
      for (let oi = 0; oi < specs.length; oi++) {
        const v = compiled ? compiled[oi].view : null;
        const status: ObjectiveState = !v ? 'pending' : v.state === 'pending' ? (si === this.stepIndex ? 'active' : 'pending') : v.state;
        items.push({ text: specs[oi].label, status, step: si, optional: !!specs[oi].optional, progress: v ? v.progress : 0 });
      }
    }
    this.events.emit('activity:progress', { id: def.id, step: this.stepIndex, objectives: items });
  }

  private onLanding(e: SimEvents['landing:scored']): void {
    if (this.phase !== 'running') return;
    const d = e.details;
    this.landing = {
      score: e.score,
      runway: typeof d.runway === 'string' ? d.runway : null,
      touchdownFromThresholdM: typeof d.touchdownFromThresholdM === 'number' ? d.touchdownFromThresholdM : null,
      grade: typeof d.grade === 'string' ? d.grade : null,
    };
    this.landingSeq++;
    this.lastLandingScore = e.score;
  }

  private onCrash(reason: string): void {
    if (this.phase === 'running') this.finish(false, `Crash: ${reason}`);
  }

  private onReset(spawn: SpawnState): void {
    if (this.expectingReset || this.phase !== 'running' || !this.def) return;
    const a = this.anchor(this.def);
    if (a && flatDistanceM(spawn.geo.lat, spawn.geo.lon, a.lat, a.lon) <= this.resetRadiusM) {
      // the pilot restarted the flight: back to the first step with the set-up's conditions (the clock has run on:
      // a dusk leg restarted 20 minutes in would otherwise fly into the night) and its route (a reset clears the plan)
      this.resetRunState();
      const s = this.def.setup;
      if (s.weather) this.host.setWeatherPreset(s.weather);
      if (s.time) this.host.setTimePreset(s.time);
      if (s.route) this.host.loadRoute(s.route);
      this.beginStep(0);
    } else this.finish(false, 'Flight changed', false);
  }

  private anchor(def: ActivityDef): { lat: number; lon: number } | null {
    const s = def.setup;
    return s.spawn === 'air' ? { lat: s.lat, lon: s.lon } : s.anchor ?? null;
  }

  // ─────────────────────────────── debrief ───────────────────────────────

  /**
   * End the activity with a debrief. `sayClosing` false (Retry, another activity, Abort, a flight change: the pilot
   * ended it, not the flying) keeps the closing "Lesson incomplete…" line out of the subtitles and speech.
   */
  private finish(success: boolean, reason: string | null, sayClosing = true): void {
    const def = this.def;
    if (this.phase !== 'running' || !def) return;
    const cur = this.cur;
    if (cur) for (const o of cur.objectives) if (!o.finished) o.abandon(reason ?? 'Not completed');
    const steps: StepResult[] = [];
    let sum = 0, n = 0;
    for (let si = 0; si < def.steps.length; si++) {
      const st = def.steps[si];
      const compiled = this.compiled[si];
      const objectives = st.objectives.map((spec, oi) => {
        const v = compiled ? compiled[oi].view : null;
        return { label: spec.label, state: v ? v.state : 'pending' as ObjectiveState, optional: !!spec.optional, score: v ? v.score : 0, note: v ? v.note : null };
      });
      const stepScore = objectives.length ? objectives.reduce((a, o) => a + o.score, 0) / objectives.length : 1;
      sum += objectives.reduce((a, o) => a + o.score, 0);
      n += objectives.length;
      steps.push({ id: st.id, title: st.title, score: Math.round(stepScore * 100), completed: !!compiled && objectives.every((o) => o.optional || o.state === 'done'), objectives });
    }
    const score = n > 0 ? Math.round((100 * sum) / n) : 100;
    let pass = success;
    let why = reason;
    if (pass && score < (def.passScore ?? 0)) { pass = false; why = `Score ${score} is below the pass mark of ${def.passScore}`; }
    const grade = gradeFor(score, pass);
    const closing = pass ? def.debrief?.pass : def.debrief?.fail;
    const head = pass ? `${def.title} complete: ${grade}, ${score}/100.` : `${def.title} not completed: ${why ?? 'unknown reason'}.`;
    const summary = closing ? `${head} ${closing.text}` : head;
    let fuelKg = 0;
    if (this.lastState) for (const f of this.lastState.fuelKg) fuelKg += f;
    const result: ActivityResult = {
      id: def.id, kind: def.kind, title: def.title, success: pass, score, grade, summary, reason: pass ? null : why,
      durationS: this.elapsed, steps, fuelKg, landingScore: this.lastLandingScore,
    };
    this.result = result;
    this.phase = 'finished';
    this.cur = null;
    this.liveHint = null;
    try { this.progress?.recordResult(def, result); } catch { /* progress is best effort */ }
    if (def.setup.route) this.host.clearRoute?.();
    if (closing && sayClosing) this.say(closing, true, true);
    this.events.emit('activity:finished', { id: def.id, success: pass, score, summary });
  }
}
