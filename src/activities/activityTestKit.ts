/**
 * TEST-ONLY helpers for src/activities tests (imported by *.test.ts files only; uses node:fs):
 * synthetic AircraftStates, a kinematic "scripted aircraft" to fly lessons through, a recording
 * ActivityHost, an event recorder, and a loader for the airports in public/data.
 */
import { readFileSync, readdirSync } from 'node:fs';
import type { EventBus } from '../core/events';
import { makeAircraftState } from '../core/fakeState';
import { defaultControlInputs, type AircraftState, type Airport, type ControlInputs, type SimEvents } from '../core/types';
import { DEG, FPM, FT, G0, KT, RAD } from '../core/units';
import { destinationPoint } from '../geo/wgs84';
import { decodeAirport, type CompactAirport } from '../nav/airportsData';
import type { ActivityHost, AirSpawnOptions, RunwaySpawnOptions, TimePreset } from './activityTypes';
import type { ActivityRunner } from './ActivityRunner';

/** Synthetic state in aviation units (everything else from makeAircraftState). */
export interface FlyParams {
  lat?: number; lon?: number;
  altFt?: number; aglFt?: number;
  hdgDeg?: number; magHdgDeg?: number;
  iasKt?: number; gsKt?: number;
  vsFpm?: number; bankDeg?: number; pitchDeg?: number;
  onGround?: boolean; flapDeg?: number; t?: number;
}

export function flyState(p: FlyParams = {}): AircraftState {
  const s = makeAircraftState();
  const alt = (p.altFt ?? 3000) * FT;
  const hdg = p.hdgDeg ?? 90;
  const ias = (p.iasKt ?? 100) * KT;
  const gs = (p.gsKt ?? p.iasKt ?? 100) * KT;
  s.t = p.t ?? 0;
  s.geo = { lat: p.lat ?? 37.5, lon: p.lon ?? -122.6, alt };
  s.altitudeMslM = alt;
  s.altitudeIndicatedM = alt;
  s.altitudeAglM = p.aglFt !== undefined ? p.aglFt * FT : alt;
  s.headingTrueRad = hdg * DEG;
  s.headingMagRad = (p.magHdgDeg ?? hdg) * DEG;
  s.trackRad = hdg * DEG;
  s.euler = [(p.bankDeg ?? 0) * DEG, (p.pitchDeg ?? 0) * DEG, hdg * DEG];
  s.verticalSpeedMs = (p.vsFpm ?? 0) * FPM;
  s.groundSpeedMs = gs;
  s.velNED = [Math.cos(hdg * DEG) * gs, Math.sin(hdg * DEG) * gs, -s.verticalSpeedMs];
  s.aero.ias = ias; s.aero.cas = ias; s.aero.tas = ias;
  s.onGround = p.onGround ?? false;
  s.surfaces.flapDeg = p.flapDeg ?? 0;
  s.engine.running = true;
  return s;
}

export const inputsWith = (over: Partial<ControlInputs> = {}): ControlInputs => ({ ...defaultControlInputs(), parkingBrake: false, ...over });

/** Point-mass kinematics good enough to fly scripted lessons: coordinated turns, climbs, a ground roll. */
export class ScriptedAircraft {
  lat: number; lon: number;
  altFt: number;
  groundFt: number;
  hdgTrue: number;
  /** magnetic declination, deg east (mag = true − decl) */
  decl: number;
  iasKt: number;
  vsFpm = 0;
  bankDeg = 0;
  pitchDeg = 0;
  onGround: boolean;
  flapDeg = 0;
  /** lateral drift on the ground, m/s (+ right of the heading) */
  driftMs = 0;
  /** extra body load factor for this frame (touchdown spikes) */
  nz = 1;
  t = 0;
  readonly inputs: ControlInputs = inputsWith();

  constructor(init: { lat: number; lon: number; altFt: number; groundFt?: number; hdgTrue: number; decl?: number; iasKt: number; onGround?: boolean; flapDeg?: number }) {
    this.lat = init.lat; this.lon = init.lon; this.altFt = init.altFt; this.groundFt = init.groundFt ?? 0;
    this.hdgTrue = init.hdgTrue; this.decl = init.decl ?? 0; this.iasKt = init.iasKt; this.onGround = init.onGround ?? false;
    this.flapDeg = init.flapDeg ?? 0;
  }

  get magHdg(): number { return ((this.hdgTrue - this.decl) % 360 + 360) % 360; }
  get aglFt(): number { return this.altFt - this.groundFt; }

  step(dt: number): void {
    const v = this.iasKt * KT;
    if (!this.onGround && v > 1) this.hdgTrue = ((this.hdgTrue + (G0 * Math.tan(this.bankDeg * DEG) / v) * RAD * dt) % 360 + 360) % 360;
    let p = destinationPoint({ lat: this.lat, lon: this.lon, alt: 0 }, this.hdgTrue, v * dt);
    if (this.driftMs !== 0) p = destinationPoint(p, this.hdgTrue + 90, this.driftMs * dt);
    this.lat = p.lat; this.lon = p.lon;
    if (this.onGround) this.altFt = this.groundFt;
    else this.altFt += (this.vsFpm / 60) * dt;
    this.t += dt;
  }

  state(): AircraftState {
    const s = flyState({
      lat: this.lat, lon: this.lon, altFt: this.altFt, aglFt: this.aglFt, hdgDeg: this.hdgTrue, magHdgDeg: this.magHdg,
      iasKt: this.iasKt, vsFpm: this.onGround ? 0 : this.vsFpm, bankDeg: this.bankDeg, pitchDeg: this.pitchDeg,
      onGround: this.onGround, flapDeg: this.flapDeg, t: this.t,
    });
    s.loadFactor = [0, 0, this.nz];
    if (this.driftMs !== 0) {
      const r = (this.hdgTrue + 90) * DEG;
      s.velNED[0] += Math.cos(r) * this.driftMs; s.velNED[1] += Math.sin(r) * this.driftMs;
    }
    return s;
  }

  /** Simple autopilot: proportional vertical speed and bank toward the targets. */
  steer(t: { altFt?: number; magHdgDeg?: number; maxVsFpm?: number; maxBankDeg?: number }): void {
    if (t.altFt !== undefined) {
      const m = t.maxVsFpm ?? 700;
      this.vsFpm = Math.max(-m, Math.min(m, (t.altFt - this.altFt) * 4));
    }
    if (t.magHdgDeg !== undefined) {
      const d = ((t.magHdgDeg - this.magHdg) % 360 + 540) % 360 - 180;
      const m = t.maxBankDeg ?? 15;
      this.bankDeg = Math.max(-m, Math.min(m, d * 1.5));
    }
  }
}

/** Run the runner with a policy until it stops running or `maxS` elapses. Returns the seconds flown. */
export function drive(runner: ActivityRunner, ac: ScriptedAircraft, policy: (ac: ScriptedAircraft, stepId: string) => void, maxS = 1800, dt = 0.1): number {
  let t = 0;
  while (runner.phase === 'running' && t < maxS) {
    policy(ac, runner.step?.id ?? '');
    ac.step(dt);
    runner.update(dt, ac.state(), ac.inputs);
    t += dt;
  }
  return t;
}

/** An ActivityHost that records every call. `onSpawn` runs inside the spawn (e.g. to emit 'flight:reset'). */
export class FakeHost implements ActivityHost {
  readonly calls: string[] = [];
  readonly spoken: string[] = [];
  lastAirSpawn: { lat: number; lon: number; altM: number; headingDeg: number; iasMs: number; opts?: AirSpawnOptions } | null = null;
  lastRunwaySpawn: { icao: string; runway: string; opts?: RunwaySpawnOptions } | null = null;
  lastRoute: unknown[] | null = null;
  constructor(private readonly onSpawn?: () => void | Promise<void>) {}
  async spawnAtRunway(icao: string, runway: string, opts?: RunwaySpawnOptions): Promise<void> {
    this.calls.push(`spawnAtRunway ${icao} ${runway}`);
    this.lastRunwaySpawn = { icao, runway, opts };
    await this.onSpawn?.();
  }
  async spawnInAir(lat: number, lon: number, altM: number, headingDeg: number, iasMs: number, opts?: AirSpawnOptions): Promise<void> {
    this.calls.push('spawnInAir');
    this.lastAirSpawn = { lat, lon, altM, headingDeg, iasMs, opts };
    await this.onSpawn?.();
  }
  setWeatherPreset(id: string): void { this.calls.push(`weather ${id}`); }
  setTimePreset(p: TimePreset): void { this.calls.push(`time ${p}`); }
  loadRoute(w: unknown[]): void { this.calls.push(`route ${w.length}`); this.lastRoute = w; }
  clearRoute(): void { this.calls.push('clearRoute'); }
  speak(text: string): void { this.spoken.push(text); }
}

type ActivityEventName = 'activity:started' | 'activity:instruction' | 'activity:progress' | 'activity:finished';
export interface RecordedEvent<K extends ActivityEventName = ActivityEventName> { name: K; payload: SimEvents[K] }

/** Records the four activity events in order. */
export function recordActivityEvents(events: EventBus): { log: RecordedEvent[]; of<K extends ActivityEventName>(name: K): SimEvents[K][] } {
  const log: RecordedEvent[] = [];
  const names: ActivityEventName[] = ['activity:started', 'activity:instruction', 'activity:progress', 'activity:finished'];
  for (const n of names) events.on(n, (p) => log.push({ name: n, payload: p } as RecordedEvent));
  return {
    log,
    of: <K extends ActivityEventName>(name: K) => log.filter((e) => e.name === name).map((e) => e.payload as SimEvents[K]),
  };
}

let cache: CompactAirport[] | null = null;
/** Every airport record in public/data (large/medium file plus all small shards). */
export function loadCompactAirports(): CompactAirport[] {
  if (cache) return cache;
  const load = (f: string) => (JSON.parse(readFileSync(f, 'utf8')) as { airports: CompactAirport[] }).airports;
  cache = [...load('public/data/airports.json'), ...readdirSync('public/data/small').flatMap((f) => load(`public/data/small/${f}`))];
  return cache;
}

export function compactAirport(icao: string): CompactAirport | undefined { return loadCompactAirports().find((a) => a.i === icao); }

/** A decoded `Airport` from public/data (what NavDatabase serves at runtime). */
export function dataAirport(icao: string): Airport {
  const a = compactAirport(icao);
  if (!a) throw new Error(`${icao} not in public/data`);
  return decodeAirport(a);
}
