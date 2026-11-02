/**
 * Continuous flight recorder (docs/research/01 §11): the last N seconds of visual state at a
 * fixed rate in a preallocated ring buffer. Playback drives only the visual model and cameras,
 * never the flight model.
 */
import { qSlerp } from '../core/math';
import type { AircraftState, ControlInputs, Quat, Vec3 } from '../core/types';

/** Layout of one frame in the ring buffer (Float64). */
const F = {
  t: 0,
  pos: 1, // 3: NED
  q: 4, // 4: qNB
  elev: 8, ailL: 9, ailR: 10, rudder: 11, flap: 12, trim: 13,
  rpm: 14,
  gear: 15, // 3 compressions
  wheel: 18, // 3 wheel speeds
  lights: 21, // bitmask
  ias: 22, alt: 23, vs: 24, onGround: 25,
} as const;
const STRIDE = 26;

export interface ReplayFrame {
  t: number;
  posNED: Vec3;
  qNB: Quat;
  surfaces: { elevatorRad: number; aileronLeftRad: number; aileronRightRad: number; rudderRad: number; flapDeg: number; trimRad: number };
  rpm: number;
  gearCompression: [number, number, number];
  wheelSpeed: [number, number, number];
  lights: { nav: boolean; beacon: boolean; strobe: boolean; landing: boolean; taxi: boolean };
  iasMs: number;
  altitudeMslM: number;
  verticalSpeedMs: number;
  onGround: boolean;
}

export const emptyReplayFrame = (): ReplayFrame => ({
  t: 0, posNED: [0, 0, 0], qNB: [1, 0, 0, 0],
  surfaces: { elevatorRad: 0, aileronLeftRad: 0, aileronRightRad: 0, rudderRad: 0, flapDeg: 0, trimRad: 0 },
  rpm: 0, gearCompression: [0, 0, 0], wheelSpeed: [0, 0, 0],
  lights: { nav: false, beacon: false, strobe: false, landing: false, taxi: false },
  iasMs: 0, altitudeMslM: 0, verticalSpeedMs: 0, onGround: true,
});

export class ReplayRecorder {
  readonly rateHz: number;
  readonly capacity: number;
  private readonly buf: Float64Array;
  private head = 0; // next write index
  private count = 0;
  private sinceLast = Infinity;
  private readonly qa: Quat = [1, 0, 0, 0];
  private readonly qb: Quat = [1, 0, 0, 0];

  constructor(durationS = 300, rateHz = 30) {
    this.rateHz = rateHz;
    this.capacity = Math.ceil(durationS * rateHz);
    this.buf = new Float64Array(this.capacity * STRIDE);
  }

  get length(): number { return this.count; }
  /** time span covered, s */
  get startTime(): number { return this.count ? this.buf[this.index(0) * STRIDE + F.t] : 0; }
  get endTime(): number { return this.count ? this.buf[this.index(this.count - 1) * STRIDE + F.t] : 0; }
  get durationS(): number { return this.endTime - this.startTime; }
  /** bytes used by the buffer */
  get bytes(): number { return this.buf.byteLength; }

  clear(): void { this.head = 0; this.count = 0; this.sinceLast = Infinity; }

  /** Call every frame (or step); records at most `rateHz` frames per second of sim time. */
  record(dt: number, s: AircraftState, u: ControlInputs): void {
    this.sinceLast += dt;
    if (this.sinceLast < 1 / this.rateHz) return;
    this.sinceLast = 0;
    const o = this.head * STRIDE, b = this.buf;
    b[o + F.t] = s.t;
    b[o + F.pos] = s.posNED[0]; b[o + F.pos + 1] = s.posNED[1]; b[o + F.pos + 2] = s.posNED[2];
    b[o + F.q] = s.qNB[0]; b[o + F.q + 1] = s.qNB[1]; b[o + F.q + 2] = s.qNB[2]; b[o + F.q + 3] = s.qNB[3];
    const sf = s.surfaces;
    b[o + F.elev] = sf.elevatorRad; b[o + F.ailL] = sf.aileronLeftRad; b[o + F.ailR] = sf.aileronRightRad;
    b[o + F.rudder] = sf.rudderRad; b[o + F.flap] = sf.flapDeg; b[o + F.trim] = sf.trimRad;
    b[o + F.rpm] = s.engine.rpm;
    for (let i = 0; i < 3; i++) {
      const g = s.gear[i];
      b[o + F.gear + i] = g ? g.compressionM : 0;
      b[o + F.wheel + i] = g ? g.wheelSpeedMs : 0;
    }
    const L = u.lights;
    b[o + F.lights] = (L.nav ? 1 : 0) | (L.beacon ? 2 : 0) | (L.strobe ? 4 : 0) | (L.landing ? 8 : 0) | (L.taxi ? 16 : 0);
    b[o + F.ias] = s.aero.ias; b[o + F.alt] = s.altitudeMslM; b[o + F.vs] = s.verticalSpeedMs; b[o + F.onGround] = s.onGround ? 1 : 0;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /**
   * Interpolated frame at sim time `t` (clamped to the recorded span). Writes into `out`.
   * Returns false when nothing is recorded.
   */
  sample(t: number, out: ReplayFrame): boolean {
    if (this.count === 0) return false;
    const t0 = this.startTime, t1 = this.endTime;
    const tt = Math.min(Math.max(t, t0), t1);
    // binary search over logical indices
    let lo = 0, hi = this.count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.buf[this.index(mid) * STRIDE + F.t] <= tt) lo = mid; else hi = mid;
    }
    const a = this.index(lo) * STRIDE, bIdx = this.index(hi) * STRIDE, b = this.buf;
    const ta = b[a + F.t], tb = b[bIdx + F.t];
    const k = tb > ta ? (tt - ta) / (tb - ta) : 0;
    const L = (f: number) => b[a + f] + (b[bIdx + f] - b[a + f]) * k;
    out.t = tt;
    out.posNED[0] = L(F.pos); out.posNED[1] = L(F.pos + 1); out.posNED[2] = L(F.pos + 2);
    for (let i = 0; i < 4; i++) { this.qa[i] = b[a + F.q + i]; this.qb[i] = b[bIdx + F.q + i]; }
    qSlerp(this.qa, this.qb, k, out.qNB);
    out.surfaces.elevatorRad = L(F.elev); out.surfaces.aileronLeftRad = L(F.ailL); out.surfaces.aileronRightRad = L(F.ailR);
    out.surfaces.rudderRad = L(F.rudder); out.surfaces.flapDeg = L(F.flap); out.surfaces.trimRad = L(F.trim);
    out.rpm = L(F.rpm);
    for (let i = 0; i < 3; i++) { out.gearCompression[i] = L(F.gear + i); out.wheelSpeed[i] = L(F.wheel + i); }
    const m = b[(k < 0.5 ? a : bIdx) + F.lights];
    out.lights.nav = (m & 1) !== 0; out.lights.beacon = (m & 2) !== 0; out.lights.strobe = (m & 4) !== 0;
    out.lights.landing = (m & 8) !== 0; out.lights.taxi = (m & 16) !== 0;
    out.iasMs = L(F.ias); out.altitudeMslM = L(F.alt); out.verticalSpeedMs = L(F.vs);
    out.onGround = b[(k < 0.5 ? a : bIdx) + F.onGround] > 0.5;
    return true;
  }

  /** Re-express recorded positions after a floating-origin rebase: p' = R(p − t), attitude q' = q ⊗ conj(R). */
  rebase(rotate: (v: Vec3) => Vec3, rotateAttitude: (q: Quat) => Quat): void {
    const v: Vec3 = [0, 0, 0];
    const q: Quat = [1, 0, 0, 0];
    for (let i = 0; i < this.count; i++) {
      const o = this.index(i) * STRIDE;
      v[0] = this.buf[o + F.pos]; v[1] = this.buf[o + F.pos + 1]; v[2] = this.buf[o + F.pos + 2];
      const r = rotate(v);
      this.buf[o + F.pos] = r[0]; this.buf[o + F.pos + 1] = r[1]; this.buf[o + F.pos + 2] = r[2];
      q[0] = this.buf[o + F.q]; q[1] = this.buf[o + F.q + 1]; q[2] = this.buf[o + F.q + 2]; q[3] = this.buf[o + F.q + 3];
      const rq = rotateAttitude(q);
      for (let j = 0; j < 4; j++) this.buf[o + F.q + j] = rq[j];
    }
  }

  private index(logical: number): number {
    const start = this.count < this.capacity ? 0 : this.head;
    return (start + logical) % this.capacity;
  }
}
