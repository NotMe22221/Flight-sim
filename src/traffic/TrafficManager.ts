/**
 * AI pattern traffic at the player's airport: a few aircraft flying touch-and-go circuits on the
 * runway in use (the one most into the wind), sequenced against each other and against the
 * player (extended downwinds, go-arounds when the runway is occupied), drawn with the exterior of
 * the regular aircraft models.
 *
 * Simulated in geodetic coordinates from the runway threshold (pattern.ts), so floating-origin
 * rebases need nothing; each frame positions are re-projected through the current local frame.
 */
import * as THREE from 'three';
import type { AircraftConfig, AircraftState, Airport, ControlInputs, Runway } from '../core/types';
import { defaultControlInputs } from '../core/types';
import { makeAircraftState } from '../core/fakeState';
import { AircraftModel } from '../aircraft3d/AircraftModel';
import { bodyQuatToThree } from '../aircraft3d/frames';
import { C172_PATTERN, CUB_PATTERN, PatternAircraft, type PatternContext, type PatternLeg, type PatternRunway, type TrafficTarget, newTarget, rng } from './pattern';

const D2R = Math.PI / 180;
const FT = 0.3048;

/** The bit of the local frame the manager needs (LocalFrame satisfies it). */
export interface TrafficFrame {
  geodeticToThree(lat: number, lon: number, alt: number): ArrayLike<number>;
}

export interface TrafficOptions {
  c172: AircraftConfig;
  cub: AircraftConfig;
  /** cap on simultaneous aircraft (graphics quality) */
  maxAircraft?: number;
}

interface Ai {
  sim: PatternAircraft;
  model: AircraftModel;
  state: AircraftState;
  inputs: ControlInputs;
  target: TrafficTarget;
  prop: number;
}

/** Runway coordinates (x along from the threshold, y right) of a geodetic point. */
export function toRunwayCoords(r: PatternRunway, lat: number, lon: number): { x: number; y: number } {
  const R = 6378137;
  const n = (lat - r.lat) * D2R * R;
  const e = (lon - r.lon) * D2R * R * Math.cos(r.lat * D2R);
  const H = r.headingDeg * D2R;
  return { x: n * Math.cos(H) + e * Math.sin(H), y: -n * Math.sin(H) + e * Math.cos(H) };
}

/**
 * The runway end to fly the circuit on: the most headwind (wind FROM `windFromDeg`); calm wind or no
 * wind keeps `preferred` (the player's runway) when given. Water and short runways are skipped.
 */
export function chooseRunway(ap: Airport, windFromDeg: number, windKt: number, preferred?: string | null): Runway | null {
  const ok = ap.runways.filter((r) => r.lengthM >= 500 && r.surface !== 'water' && Number.isFinite(r.headingDeg));
  if (!ok.length) return null;
  if (windKt < 3 && preferred) { const p = ok.find((r) => r.ident === preferred); if (p) return p; }
  let best = ok[0], bestHw = -Infinity;
  for (const r of ok) {
    const hw = Math.cos((windFromDeg - r.headingDeg) * D2R) * Math.max(windKt, 0.1) + r.lengthM * 1e-6;
    if (hw > bestHw) { bestHw = hw; best = r; }
  }
  return best;
}

/** How many AI aircraft an airport gets. */
export function trafficCount(ap: Airport): number {
  return ap.type === 'small' ? 2 : ap.type === 'medium' ? 2 : ap.type === 'large' ? 1 : 0;
}

export class TrafficManager {
  readonly group = new THREE.Group();
  private ai: Ai[] = [];
  private readonly targetsOut: TrafficTarget[] = [];
  private airportKey = '';
  private maxAircraft: number;
  private enabled = true;
  private player: { onGround: boolean; lat: number; lon: number; aglM: number; trackDeg: number } | null = null;
  private readonly pos = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly qNB: [number, number, number, number] = [1, 0, 0, 0];
  private rwy: PatternRunway | null = null;

  constructor(private readonly opts: TrafficOptions) {
    this.group.name = 'traffic';
    this.maxAircraft = opts.maxAircraft ?? 2;
  }

  /** AI targets (for maps, the HUD and ATC). Valid until the next update. */
  targets(): readonly TrafficTarget[] { return this.targetsOut; }
  /** The runway end the circuit is flown on, or null. */
  get runway(): PatternRunway | null { return this.rwy; }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
    if (!on) this.clear();
  }

  /** Graphics quality: 0 removes traffic, otherwise caps the aircraft count. */
  setMaxAircraft(n: number): void {
    this.maxAircraft = Math.max(0, Math.floor(n));
    if (this.ai.length > this.maxAircraft) { for (const a of this.ai.splice(this.maxAircraft)) this.disposeAi(a); this.targetsOut.length = this.ai.length; }
  }

  /**
   * (Re)build the circuit for an airport. Rebuilds only when the airport or the runway in use
   * changes. `preferred` is the player's runway ident (kept in calm wind).
   */
  setAirport(ap: Airport | null, windFromDeg: number, windKt: number, preferred?: string | null): void {
    if (!this.enabled || !ap) { this.clear(); this.airportKey = ''; return; }
    const r = chooseRunway(ap, windFromDeg, windKt, preferred);
    const n = Math.min(trafficCount(ap), this.maxAircraft);
    const key = `${ap.icao}:${r?.ident ?? ''}:${n}`;
    if (key === this.airportKey) return;
    this.clear();
    this.airportKey = key;
    if (!r || n <= 0) return;
    const rwy: PatternRunway = {
      lat: r.threshold.lat, lon: r.threshold.lon, elevM: Number.isFinite(r.threshold.alt) ? r.threshold.alt : ap.elevationM,
      endElevM: Number.isFinite(r.end.alt) ? r.end.alt : ap.elevationM,
      headingDeg: r.headingDeg, lengthM: r.lengthM,
      // right traffic for the 'R' parallel of a pair, otherwise left (the default circuit)
      side: /R$/.test(r.ident) ? 'right' : 'left',
    };
    this.rwy = rwy;
    let seed = 0;
    for (const ch of ap.icao) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rand = rng(seed);
    // spread around the circuit, never on the runway at the start (the player may be there)
    const starts: { leg: PatternLeg; along: number }[] = [{ leg: 'downwind', along: 0.35 }, { leg: 'crosswind', along: 0.2 }, { leg: 'upwind', along: 0.6 }];
    for (let i = 0; i < n; i++) {
      const cub = ap.type === 'small' && rand() < 0.5;
      const cfg = cub ? this.opts.cub : this.opts.c172;
      const reg = `N${100 + Math.floor(rand() * 899)}${String.fromCharCode(65 + Math.floor(rand() * 26))}${String.fromCharCode(65 + Math.floor(rand() * 26))}`;
      const sim = new PatternAircraft(`${ap.icao}-${i}`, reg, cub ? 'Super Cub' : 'Cessna 172', cub ? CUB_PATTERN : C172_PATTERN, rwy, starts[i % starts.length]);
      const model = new AircraftModel(cfg, { registration: reg, shadows: false });
      // no spot lights on AI aircraft: each one would change every material's light count (shader
      // recompiles, per-pixel cost); the nav, beacon and strobe halos stay
      model.lights.landingLight.removeFromParent(); model.lights.taxiLight.removeFromParent();
      model.lights.landingLight.target.removeFromParent(); model.lights.taxiLight.target.removeFromParent();
      model.setVisibility(true, false);
      this.group.add(model.root);
      const inputs = defaultControlInputs();
      inputs.lights = { nav: true, beacon: true, strobe: true, landing: true, taxi: false, panel: 0 };
      this.ai.push({ sim, model, state: makeAircraftState(), inputs, target: newTarget(), prop: 0 });
    }
    this.targetsOut.length = 0;
    for (const a of this.ai) this.targetsOut.push(a.target);
  }

  /**
   * Advance the traffic by `simDt` (0 while paused or in replay) and draw it with the current frame.
   * `player` is the player's aircraft (sequencing, go-arounds); `dt` animates propellers and lights.
   */
  update(simDt: number, dt: number, player: AircraftState, frame: TrafficFrame, sunElevationRad: number): void {
    if (!this.ai.length || !this.rwy) return;
    const rwy = this.rwy;
    const pc = toRunwayCoords(rwy, player.geo.lat, player.geo.lon);
    const pTrk = ((player.trackRad / D2R - rwy.headingDeg + 540) % 360) - 180;
    const playerOnRunway = player.onGround && pc.x > -60 && pc.x < rwy.lengthM + 60 && Math.abs(pc.y) < 45;
    // the player on final: airborne, lined up, within 4 km of the threshold and below 1,500 ft
    const playerOnFinal = !player.onGround && pc.x > -4000 && pc.x < 200 && Math.abs(pc.y) < 450 && Math.abs(pTrk) < 35 && player.altitudeAglM < 1500 * FT;
    const ctx: PatternContext = {
      runwayOccupied: (self) => playerOnRunway || this.ai.some((o) => o.sim !== self && o.sim.onRunway),
      sequenceBusy: (self) => playerOnFinal || this.ai.some((o) => o.sim !== self && o.sim.inSequence && o.sim.leg !== 'landing'),
    };
    // fixed sub-steps: the follower is stable at 0.1 s; time compression runs more of them
    let rest = Math.min(simDt, 2);
    while (rest > 1e-6) { const h = Math.min(rest, 0.1); for (const a of this.ai) a.sim.update(h, ctx); rest -= h; }

    for (const a of this.ai) {
      const t = a.sim.target(a.target);
      const p = frame.geodeticToThree(t.lat, t.lon, t.altMslM + this.cgHeight(a));
      this.pos.set(p[0], p[1], p[2]);
      eulerToQNB(t.rollDeg * D2R, t.pitchDeg * D2R, t.headingDeg * D2R, this.qNB);
      bodyQuatToThree(this.qNB, this.q);
      a.model.setPose(this.pos, this.q);
      // the animated parts the model reads from the state
      const s = a.state;
      s.surfaces.flapDeg = t.flapDeg;
      s.engine.rpm = t.leg === 'final' || t.leg === 'landing' || t.leg === 'base' ? 1500 : t.leg === 'downwind' ? 2300 : 2600;
      s.engine.running = true;
      for (const g of s.gear) { g.onGround = t.onGround; g.compressionM = t.gearCompressionM; g.wheelSpeedMs = t.onGround ? t.groundSpeedMs : 0; g.steerRad = 0; }
      a.inputs.lights!.landing = !t.onGround || t.leg === 'takeoff' || t.leg === 'landing';
      a.model.setSunElevation(sunElevationRad);
      a.model.update(s, a.inputs, dt, false);
    }
  }

  /**
   * Height of the CG (the model origin) above the ground at the main wheels in the attitude drawn:
   * a main contact at body (x, z) sits z·cosθ − x·sinθ below the CG (a Cub on its tail wheel is ~11° up).
   */
  private cgHeight(a: Ai): number {
    const cfg = a.sim.type === 'Super Cub' ? this.opts.cub : this.opts.c172;
    const th = a.target.pitchDeg * D2R, c = Math.cos(th), sn = Math.sin(th);
    let h = 0;
    for (const g of cfg.gear) if (g.type === 'wheel' && g.pos[0] > -1) h = Math.max(h, g.pos[2] * c - g.pos[0] * sn);
    return h;
  }

  private clear(): void {
    for (const a of this.ai) this.disposeAi(a);
    this.ai = [];
    this.targetsOut.length = 0;
    this.rwy = null;
  }

  private disposeAi(a: Ai): void { a.model.dispose(); }

  dispose(): void { this.clear(); this.group.removeFromParent(); }
}

/** ZYX Euler (roll φ, pitch θ, true heading ψ; rad) → qNB (NED → body, scalar-first). */
export function eulerToQNB(phi: number, theta: number, psi: number, out: [number, number, number, number]): [number, number, number, number] {
  const cr = Math.cos(phi / 2), sr = Math.sin(phi / 2), cp = Math.cos(theta / 2), sp = Math.sin(theta / 2), cy = Math.cos(psi / 2), sy = Math.sin(psi / 2);
  // q_BN (body → NED) = qz(ψ) qy(θ) qx(φ); qNB is its conjugate
  const w = cr * cp * cy + sr * sp * sy;
  const x = sr * cp * cy - cr * sp * sy;
  const y = cr * sp * cy + sr * cp * sy;
  const z = cr * cp * sy - sr * sp * cy;
  out[0] = w; out[1] = -x; out[2] = -y; out[3] = -z;
  return out;
}
