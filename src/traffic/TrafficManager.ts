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
import { mergeStatic, type MergedLod } from '../aircraft3d/mergeStatic';
import { reciprocalIdent } from '../nav/airportsData';
import type { TaxiGraph } from '../world/taxiGraph';
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
  /** a ground aircraft: its stand (runway coordinates, heading) and taxi path, for re-parking */
  stand?: { x: number; y: number; trk: number; path: [number, number][] | null; lat: number; lon: number };
  model: AircraftModel;
  state: AircraftState;
  inputs: ControlInputs;
  target: TrafficTarget;
  prop: number;
  /** merged single-mesh-per-material copy shown beyond LOD_FAR_M (~70 → ~15 draw calls) */
  lod: MergedLod;
  far: boolean;
}

/** switch to the merged model beyond this distance from the camera, back inside LOD_NEAR_M */
const LOD_FAR_M = 250;
const LOD_NEAR_M = 200;

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
  return rankRunways(ap, windFromDeg, windKt, preferred)[0] ?? null;
}

/**
 * Every usable runway end (both directions of each runway), best first: the player's runway in calm
 * wind, then the most headwind (longer first on ties). Water and short runways are skipped.
 */
export function rankRunways(ap: Airport, windFromDeg: number, windKt: number, preferred?: string | null): Runway[] {
  // the database lists each runway once (its primary end): both directions are candidates
  const ok = ap.runways
    .filter((r) => r.lengthM >= 500 && r.surface !== 'water' && Number.isFinite(r.headingDeg))
    .flatMap((r) => [r, { ...r, ident: reciprocalIdent(r.ident), threshold: r.end, end: r.threshold, headingDeg: (r.headingDeg + 180) % 360, displacedThresholdM: 0, ils: undefined }]);
  const score = (r: Runway) => (windKt < 3 && preferred && r.ident === preferred ? 1e6 : 0) + Math.cos((windFromDeg - r.headingDeg) * D2R) * Math.max(windKt, 0.1) + r.lengthM * 1e-6;
  return ok.sort((x, y) => score(y) - score(x));
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
  private groundKey = '';
  private graph: TaxiGraph | null = null;
  private rwyWidthM = 45;
  private airport: Airport | null = null;
  private wind = { fromDeg: 0, kt: 0, preferred: null as string | null };
  /** the best-ranked runway end the stands' taxi routes reach (ground traffic), by ident */
  private reachable: string | null = null;
  private reachableFor = '';
  private airportType: Airport['type'] = 'small';
  private seed = 1;
  private reparks = 0;

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
    const m = Math.max(0, Math.floor(n));
    if (m === this.maxAircraft) return;
    this.maxAircraft = m;
    this.clear(); this.airportKey = ''; // rebuilt with the new cap on the next setAirport / setGround
  }

  /**
   * (Re)build the circuit for an airport. Rebuilds only when the airport or the runway in use
   * changes. `preferred` is the player's runway ident (kept in calm wind).
   */
  setAirport(ap: Airport | null, windFromDeg: number, windKt: number, preferred?: string | null): void {
    if (!this.enabled || !ap) { this.clear(); this.airportKey = ''; this.airport = null; return; }
    if (this.airport?.icao !== ap.icao) { this.reachable = null; this.reachableFor = ''; }
    this.airport = ap; this.wind = { fromDeg: windFromDeg, kt: windKt, preferred: preferred ?? null };
    // a runway the ground traffic can reach (setGround) overrides the plain into-wind choice
    const ranked = rankRunways(ap, windFromDeg, windKt, preferred);
    const r = (this.reachable && ranked.find((x) => x.ident === this.reachable)) || ranked[0] || null;
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
    this.rwyWidthM = Number.isFinite(r.widthM) && r.widthM > 0 ? r.widthM : 45;
    this.airportType = ap.type;
    let seed = 0;
    for (const ch of ap.icao) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    this.seed = seed || 1;
    const rand = rng(seed);
    // spread around the circuit, never on the runway at the start (the player may be there)
    const starts: { leg: PatternLeg; along: number }[] = [{ leg: 'downwind', along: 0.35 }, { leg: 'crosswind', along: 0.2 }, { leg: 'upwind', along: 0.6 }];
    for (let i = 0; i < n; i++) {
      const cub = ap.type === 'small' && rand() < 0.5;
      this.ai.push(this.makeAi(`${ap.icao}-${i}`, cub, rand, rwy, starts[i % starts.length]));
    }
    this.targetsOut.length = 0;
    for (const a of this.ai) this.targetsOut.push(a.target);
  }

  private makeAi(id: string, cub: boolean, rand: () => number, rwy: PatternRunway, start: { leg: PatternLeg; along: number }): Ai {
    const cfg = cub ? this.opts.cub : this.opts.c172;
    const reg = `N${100 + Math.floor(rand() * 899)}${String.fromCharCode(65 + Math.floor(rand() * 26))}${String.fromCharCode(65 + Math.floor(rand() * 26))}`;
    const sim = new PatternAircraft(id, reg, cub ? 'Super Cub' : 'Cessna 172', cub ? CUB_PATTERN : C172_PATTERN, rwy, start);
    const model = new AircraftModel(cfg, { registration: reg, shadows: false });
    // no spot lights on AI aircraft: each one would change every material's light count (shader
    // recompiles, per-pixel cost); the nav, beacon and strobe halos stay
    model.lights.landingLight.removeFromParent(); model.lights.taxiLight.removeFromParent();
    model.lights.landingLight.target.removeFromParent(); model.lights.taxiLight.target.removeFromParent();
    model.setVisibility(true, false);
    const lod = mergeStatic(model.root);
    lod.group.visible = false;
    model.root.add(lod.group);
    this.group.add(model.root);
    const inputs = defaultControlInputs();
    inputs.lights = { nav: true, beacon: true, strobe: true, landing: true, taxi: false, panel: 0 };
    return { sim, model, state: makeAircraftState(), inputs, target: newTarget(), prop: 0, lod, far: false };
  }

  /**
   * Ground traffic from the airport's OSM stands and taxiways: aircraft parked at stands, one or two
   * of which start up, taxi to the hold-short point of the runway in use, wait for the runway, take
   * off and depart (then, well clear, reappear at their stand for a later departure). Stands within
   * 80 m of `avoid` (the player) stay free. Rebuilt only when the inputs change.
   */
  setGround(graph: TaxiGraph | null, stands: readonly { lat: number; lon: number; headingDeg: number }[], avoid: { lat: number; lon: number } | null): void {
    // the circuit must be on a runway the stands can taxi to: the best-ranked one with a route
    const ap = this.airport;
    const rkey = ap && graph && stands.length ? `${ap.icao}:${graph.nodes.length}:${stands.length}:${this.wind.fromDeg}:${this.wind.kt}` : '';
    if (rkey !== this.reachableFor) {
      this.reachableFor = rkey;
      let best: string | null = null;
      if (ap && graph && stands.length) {
        const probes = Array.from({ length: Math.min(12, stands.length) }, (_, i) => stands[Math.floor((i * stands.length) / Math.min(12, stands.length))]);
        for (const r of rankRunways(ap, this.wind.fromDeg, this.wind.kt, this.wind.preferred)) {
          const hs = graph.holdShort({ threshold: r.threshold, end: r.end, widthM: r.widthM });
          if (hs && probes.some((pr) => graph.route(pr.lat, pr.lon, hs))) { best = r.ident; break; }
        }
      }
      if (best !== this.reachable) {
        this.reachable = best;
        if (ap) { this.airportKey = ''; this.setAirport(ap, this.wind.fromDeg, this.wind.kt, this.wind.preferred); }
      }
    }
    const rwy = this.rwy;
    const key = rwy && graph ? `${this.airportKey}:${graph.nodes.length}:${stands.length}` : '';
    if (key === this.groundKey) return;
    this.groundKey = key;
    for (const a of this.ai.filter((x) => x.stand)) this.disposeAi(a);
    this.ai = this.ai.filter((x) => !x.stand);
    this.graph = graph;
    if (rwy && graph && this.enabled && this.maxAircraft > 1) {
      const end = destination(rwy.lat, rwy.lon, rwy.headingDeg, rwy.lengthM);
      const hs = graph.holdShort({ threshold: { lat: rwy.lat, lon: rwy.lon }, end, widthM: this.rwyWidthM });
      const rand = rng(this.seed ^ 0x9e3779b9);
      const free = stands.filter((st) => !avoid || greatCircleish(st.lat, st.lon, avoid.lat, avoid.lon) > 80);
      const nParked = Math.min(free.length, this.airportType === 'small' ? 2 : 4);
      const nDepart = this.airportType === 'small' ? 1 : 2;
      // departures from stands whose taxi route reaches the runway's hold-short point, the rest static
      const routeOf = (st: { lat: number; lon: number }) => {
        const r = hs ? graph.route(st.lat, st.lon, hs) : null;
        return r ? r.geo.map((g) => { const q = toRunwayCoords(rwy, g.lat, g.lon); return [q.x, q.y] as [number, number]; }) : null;
      };
      const chosen: { st: { lat: number; lon: number; headingDeg: number }; path: [number, number][] | null }[] = [];
      for (let k = 0; k < free.length && chosen.length < nDepart; k++) {
        const st = free[Math.floor((k * 7919) % free.length)];
        if (chosen.some((c) => c.st === st)) continue;
        const path = routeOf(st);
        if (path) chosen.push({ st, path });
        if (k > 40) break;
      }
      for (let i = 0; chosen.length < nParked + chosen.filter((c) => c.path).length && i < free.length; i++) {
        const st = free[Math.floor((i * free.length) / nParked) % free.length];
        if (!chosen.some((c) => c.st === st)) chosen.push({ st, path: null });
        if (i > nParked * 3) break;
      }
      let departing = 0;
      chosen.forEach(({ st, path }, i) => {
        const c = toRunwayCoords(rwy, st.lat, st.lon);
        if (path) departing++;
        const ai = this.makeAi(`G${i}`, this.airportType === 'small' && rand() < 0.5, rand, rwy, { leg: 'downwind', along: 0 });
        const trk = st.headingDeg - rwy.headingDeg;
        ai.stand = { x: c.x, y: c.y, trk, path, lat: st.lat, lon: st.lon };
        ai.sim.departs = !!path;
        ai.sim.parkAt(c.x, c.y, trk, path, path ? 15 + (departing - 1) * 90 + rand() * 20 : Infinity);
        // the second departure starts inbound instead: an arrival early in the session
        if (path && departing === 2) this.sendInbound(ai, 4500);
        this.ai.push(ai);
      });
    }
    this.targetsOut.length = 0;
    for (const a of this.ai) this.targetsOut.push(a.target);
  }

  /**
   * The AI aircraft immediately ahead of a player position in the landing sequence of the circuit
   * runway, as ATC words it ({ type: 'Cessna' | 'Piper Cub', leg }), or null. On final the player
   * follows an aircraft closer to the threshold on final or rolling out; in the circuit (downwind,
   * base) the last aircraft already on base or final.
   */
  aheadOf(lat: number, lon: number): { type: string; leg: string } | null {
    const rwy = this.rwy;
    if (!rwy) return null;
    const pc = toRunwayCoords(rwy, lat, lon);
    const onFinal = pc.x > -4000 && pc.x < 200 && Math.abs(pc.y) < 450;
    let best: PatternAircraft | null = null;
    for (const a of this.ai) {
      const s = a.sim;
      if (!s.inSequence || (s.onGround && s.leg !== 'landing')) continue;
      if (onFinal && !(s.x > pc.x && (s.leg === 'final' || s.leg === 'landing'))) continue;
      // the immediate one ahead: the furthest from the threshold (smallest x; base counts as before final)
      const key = (q: PatternAircraft) => (q.leg === 'base' ? -1e6 : q.x);
      if (!best || key(s) < key(best)) best = s;
    }
    if (!best) return null;
    return { type: best.type.startsWith('Cessna') ? 'Cessna' : best.type.includes('Cub') ? 'Piper Cub' : best.type, leg: best.leg === 'landing' ? 'final' : best.leg };
  }

  /** Put a ground aircraft on a straight-in final that ends at its stand (false without a taxi-in route). */
  private sendInbound(a: Ai, distM: number): boolean {
    const rwy = this.rwy, g = this.graph, st = a.stand;
    if (!rwy || !g || !st || !st.path) return false;
    const exitX = Math.min(rwy.lengthM * 0.6, a.sim.circuit.touchdownX + 600);
    const ex = destination(rwy.lat, rwy.lon, rwy.headingDeg, exitX);
    const r = g.routeBetween(ex.lat, ex.lon, st.lat, st.lon);
    if (!r) return false;
    const inPath = r.geo.map((p) => { const q = toRunwayCoords(rwy, p.lat, p.lon); return [q.x, q.y] as [number, number]; });
    inPath[0] = [exitX, 0];
    a.sim.arrive(inPath, st.trk, st.path, 120 + ((this.reparks++ * 97) % 180), distM);
    return true;
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
      // stop on the ground for the player or another aircraft within 50 m ahead (±40° of the track)
      blockedAhead: (self) => {
        const ahead = (x: number, y: number, r: number) => {
          const dx = x - self.x, dy = y - self.y, d = Math.hypot(dx, dy);
          return d > 1 && d < r && Math.abs(wrap180(Math.atan2(dy, dx) / D2R - self.trk)) < 40;
        };
        return (player.onGround && ahead(pc.x, pc.y, 60)) || this.ai.some((o) => o.sim !== self && o.sim.onGround && ahead(o.sim.x, o.sim.y, 45));
      },
    };
    // fixed sub-steps: the follower is stable at 0.1 s; time compression runs more of them
    let rest = Math.min(simDt, 2);
    while (rest > 1e-6) { const h = Math.min(rest, 0.1); for (const a of this.ai) a.sim.update(h, ctx); rest -= h; }

    for (const a of this.ai) {
      if (a.stand && a.sim.departed) {
        // gone: come back later as an arrival that lands and taxis in to the same stand
        if (!this.sendInbound(a, 6500)) a.sim.parkAt(a.stand.x, a.stand.y, a.stand.trk, a.stand.path, 120 + ((this.reparks++ * 97) % 180));
      }
      const t = a.sim.target(a.target);
      const p = frame.geodeticToThree(t.lat, t.lon, t.altMslM + this.cgHeight(a));
      this.pos.set(p[0], p[1], p[2]);
      eulerToQNB(t.rollDeg * D2R, t.pitchDeg * D2R, t.headingDeg * D2R, this.qNB);
      bodyQuatToThree(this.qNB, this.q);
      a.model.setPose(this.pos, this.q);
      // distant: the merged model (the light halos stay on the full one)
      if (this.camera) {
        const d = this.pos.distanceTo(this.camera);
        const far = a.far ? d > LOD_NEAR_M : d > LOD_FAR_M;
        if (far !== a.far) { a.far = far; a.lod.group.visible = far; for (const m of a.lod.sources) m.visible = !far; }
      }
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
    this.groundKey = '';
    for (const a of this.ai) this.disposeAi(a);
    this.ai = [];
    this.targetsOut.length = 0;
    this.rwy = null;
  }

  private disposeAi(a: Ai): void { a.lod.dispose(); a.model.dispose(); }

  private camera: THREE.Vector3 | null = null;
  /** Render-frame camera position (for the distant level of detail). */
  setCamera(pos: THREE.Vector3): void { this.camera = pos; }

  /** How many AI aircraft currently show the merged distant model (for tests and the perf probe). */
  get farCount(): number { return this.ai.filter((a) => a.far).length; }

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

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
/** Ground distance (m) between two nearby points. */
function greatCircleish(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const ky = 6378137 * D2R, kx = ky * Math.cos(lat1 * D2R);
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * ky);
}
/** The point `dist` metres from (lat, lon) along a true heading (flat earth, fine for a runway). */
function destination(lat: number, lon: number, hdgDeg: number, dist: number): { lat: number; lon: number } {
  const ky = 6378137 * D2R, kx = ky * Math.cos(lat * D2R), h = hdgDeg * D2R;
  return { lat: lat + (Math.cos(h) * dist) / ky, lon: lon + (Math.sin(h) * dist) / kx };
}
