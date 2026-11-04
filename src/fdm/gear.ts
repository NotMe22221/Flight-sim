/**
 * Ground contact: per-wheel spring/damper struts with Pacejka side force, rolling and brake
 * friction, nose-wheel steering, brake anchoring (static friction) and structural contact
 * points (docs/research/02 §5).
 *
 * Stability measures from §5.6: compression rate clamped to δ/dt, tanh-saturated Coulomb
 * friction, the lateral slip angle computed with a 1 m/s floor on rolling speed, and a stiff
 * spring-damper "anchor" holding braked wheels at rest so a parked aircraft never creeps.
 *
 * Steering: `GearInputs.steerRad` is the turn command (+ = turn right); a steerable wheel behind
 * the CG (a tail wheel) is turned the opposite way. A wheel with `casters` and a `swivel` spec
 * breaks out of its steering lock when the tyre side force exceeds the breakout force and then
 * castors freely (it rolls along its contact-point velocity, no side force) until it swivels back
 * within the relock angle of the steering angle. Brakes may be torque-limited (`brakeMu`).
 */
import { qConj, qRotate } from '../core/math';
import type { Environment, GearSpec, Quat, Vec3 } from '../core/types';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;
/** ground speed of the contact point above which a castering wheel aligns with its motion, m/s */
const CASTER_ALIGN_SPEED = 0.3;
/** a swivelling wheel breaks out only when its tyre is dragged this far past the steering stop, deg */
const SWIVEL_STOP_MARGIN_DEG = 3;
const V_EPS = 0.3;
const ANCHOR_K = 60_000;
const ANCHOR_C = 9_000;
const ANCHOR_SPEED = 0.08;
const BRAKE_ANCHOR = 0.3;
/**
 * Wheel load (× aircraft weight) that collapses a leg. A 600 fpm arrival peaks at ≈ 1.3 W per
 * main and ≈ 1.8 W on the nose leg as it slams down; ≈ 1000–1100 fpm reaches 3 W.
 */
const WHEEL_COLLAPSE_W = 3;

export interface GearInputs {
  brakeLeft: number;
  brakeRight: number;
  /** steering command, rad (+ = turn right; a wheel behind the CG is turned the other way) */
  steerRad: number;
}

export interface GearOutput {
  /** body force and moment about the CG */
  F: Float64Array;
  M: Float64Array;
  compression: Float64Array;
  normalForce: Float64Array;
  /** rolling speed along the wheel heading, m/s */
  rollSpeed: Float64Array;
  /** sideways speed, m/s */
  sideSpeed: Float64Array;
  contactN: Float64Array;
  contactE: Float64Array;
  inContact: Uint8Array;
  anchorSaturated: Uint8Array;
  /** wheel heading relative to body x in the evaluated state, rad (+ = wheel turned right) */
  wheelAngle: Float64Array;
  /** tyre side force magnitude, N (swivel breakout) */
  sideForce: Float64Array;
  /** count of wheel (not structure) contacts touching the ground */
  wheelsOnGround: number;
  /** non-empty when a structural limit was exceeded */
  crash: string;
}

export function pacejka(slipDeg: number, B: number, C: number, D: number, E: number): number {
  const bs = B * slipDeg;
  return D * Math.sin(C * Math.atan(bs - E * (bs - Math.atan(bs))));
}

export class GearModel {
  readonly count: number;
  /** indices of wheel-type contacts, in config order */
  readonly wheelIndices: number[];
  readonly anchored: Uint8Array;
  readonly anchorN: Float64Array;
  readonly anchorE: Float64Array;
  /** 1 while a swivelling wheel is unlocked and castering freely */
  readonly castering: Uint8Array;
  /** heading of a castering wheel relative to body x, rad (held while it is too slow to align) */
  readonly casterAngle: Float64Array;
  /** +1 for steerable wheels ahead of the empty CG, −1 behind it, 0 for fixed wheels */
  private readonly steerSign: Float64Array;
  private readonly r: Vec3 = [0, 0, 0];
  private readonly d: Vec3 = [0, 0, 0];
  private readonly vb: Vec3 = [0, 0, 0];
  private readonly vn: Vec3 = [0, 0, 0];
  private readonly n: Vec3 = [0, 0, -1];
  private readonly fwd: Vec3 = [1, 0, 0];
  private readonly fw: Vec3 = [0, 0, 0];
  private readonly t: Vec3 = [0, 0, 0];
  private readonly s: Vec3 = [0, 0, 0];
  private readonly fN: Vec3 = [0, 0, 0];
  private readonly fB: Vec3 = [0, 0, 0];
  private readonly qnb: Quat = [1, 0, 0, 0];

  constructor(readonly specs: GearSpec[]) {
    this.count = specs.length;
    this.wheelIndices = specs.map((g, i) => (g.type === 'wheel' ? i : -1)).filter((i) => i >= 0);
    this.anchored = new Uint8Array(this.count);
    this.anchorN = new Float64Array(this.count);
    this.anchorE = new Float64Array(this.count);
    this.castering = new Uint8Array(this.count);
    this.casterAngle = new Float64Array(this.count);
    this.steerSign = Float64Array.from(specs, (g) => (g.type === 'wheel' && g.maxSteerDeg > 0 ? (g.pos[0] < 0 ? -1 : 1) : 0));
  }

  newOutput(): GearOutput {
    const n = this.count;
    return {
      F: new Float64Array(3), M: new Float64Array(3), compression: new Float64Array(n), normalForce: new Float64Array(n),
      rollSpeed: new Float64Array(n), sideSpeed: new Float64Array(n), contactN: new Float64Array(n), contactE: new Float64Array(n),
      inContact: new Uint8Array(n), anchorSaturated: new Uint8Array(n), wheelAngle: new Float64Array(n), sideForce: new Float64Array(n), wheelsOnGround: 0, crash: '',
    };
  }

  /**
   * @param pos CG position NED
   * @param qbn body→NED orientation
   * @param v body-axis inertial velocity
   * @param w body rates
   * @param cg current CG relative to the empty CG (body)
   * @param mass current mass, kg (for crash load limits)
   */
  evaluate(pos: ArrayLike<number>, qbn: Quat, v: ArrayLike<number>, w: ArrayLike<number>, cg: Vec3, mass: number, env: Environment, ctl: GearInputs, dt: number, out: GearOutput): GearOutput {
    const F = out.F, M = out.M;
    F[0] = F[1] = F[2] = 0;
    M[0] = M[1] = M[2] = 0;
    out.wheelsOnGround = 0;
    out.crash = '';
    qConj(qbn, this.qnb);
    const weight = mass * 9.80665;
    const surfaceRoll = env.surface === 'grass' ? 2.5 : env.surface === 'unknown' ? 1.5 : 1;
    const surfaceBrake = env.surface === 'grass' ? 0.6 : 1;

    for (let i = 0; i < this.count; i++) {
      const g = this.specs[i];
      out.inContact[i] = 0;
      out.compression[i] = 0;
      out.normalForce[i] = 0;
      out.anchorSaturated[i] = 0;
      out.sideForce[i] = 0;
      // steering: the turn command, mirrored for a wheel behind the CG; a castering wheel keeps its swivel angle
      const sgn = this.steerSign[i];
      const steer = this.castering[i] ? this.casterAngle[i] : sgn !== 0 ? sgn * ctl.steerRad : 0;
      out.wheelAngle[i] = steer;
      const r = this.r;
      r[0] = g.pos[0] - cg[0]; r[1] = g.pos[1] - cg[1]; r[2] = g.pos[2] - cg[2];
      qRotate(qbn, r, this.d);
      const pN = pos[0] + this.d[0], pE = pos[1] + this.d[1], pD = pos[2] + this.d[2];
      out.contactN[i] = pN;
      out.contactE[i] = pE;
      const hG = env.groundHeight(pN, pE);
      const depth = hG + pD; // ground "up" minus point "up"
      // contact-point velocity (body → NED)
      const vb = this.vb;
      vb[0] = v[0] + (w[1] * r[2] - w[2] * r[1]);
      vb[1] = v[1] + (w[2] * r[0] - w[0] * r[2]);
      vb[2] = v[2] + (w[0] * r[1] - w[1] * r[0]);
      qRotate(qbn, vb, this.vn);
      if (depth <= 0) {
        out.rollSpeed[i] = 0;
        out.sideSpeed[i] = 0;
        continue;
      }
      const nrm = env.groundNormal(pN, pE, this.n);
      const vn = this.vn;
      const vDotN = vn[0] * nrm[0] + vn[1] * nrm[1] + vn[2] * nrm[2];
      // penetration measured along the normal
      const delta = depth * -nrm[2];
      let vComp = -vDotN;
      const lim = delta / dt;
      if (vComp > lim) vComp = lim; else if (vComp < -lim) vComp = -lim;
      let Fn = g.k * delta + (vComp >= 0 ? g.cComp : g.cRebound) * vComp;
      if (Fn < 0) Fn = 0;
      out.inContact[i] = 1;
      out.compression[i] = delta;
      out.normalForce[i] = Fn;
      if (g.type === 'wheel') out.wheelsOnGround++;

      // wheel heading projected on the ground plane
      const t = this.t;
      let aligned = false;
      if (this.castering[i]) {
        // free castering: the wheel trails its contact-point velocity (ground-plane part)
        const gx = vn[0] - vDotN * nrm[0], gy = vn[1] - vDotN * nrm[1], gz = vn[2] - vDotN * nrm[2];
        const gsp = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (gsp > CASTER_ALIGN_SPEED) {
          t[0] = gx / gsp; t[1] = gy / gsp; t[2] = gz / gsp;
          const tb = qRotate(this.qnb, t, this.fB);
          out.wheelAngle[i] = Math.atan2(tb[1], tb[0]);
          aligned = true;
        }
      }
      if (!aligned) {
        this.fwd[0] = Math.cos(steer); this.fwd[1] = Math.sin(steer); this.fwd[2] = 0;
        qRotate(qbn, this.fwd, this.fw);
        const fDotN = this.fw[0] * nrm[0] + this.fw[1] * nrm[1] + this.fw[2] * nrm[2];
        t[0] = this.fw[0] - fDotN * nrm[0]; t[1] = this.fw[1] - fDotN * nrm[1]; t[2] = this.fw[2] - fDotN * nrm[2];
        const tl = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]) || 1; // not Math.hypot: its varargs can allocate
        t[0] /= tl; t[1] /= tl; t[2] /= tl;
      }
      // right = down × t, with down = −n
      const s = this.s;
      s[0] = -nrm[1] * t[2] + nrm[2] * t[1];
      s[1] = -nrm[2] * t[0] + nrm[0] * t[2];
      s[2] = -nrm[0] * t[1] + nrm[1] * t[0];
      const vLong = vn[0] * t[0] + vn[1] * t[1] + vn[2] * t[2];
      const vLat = vn[0] * s[0] + vn[1] * s[1] + vn[2] * s[2];
      out.rollSpeed[i] = vLong;
      out.sideSpeed[i] = vLat;

      let fLong: number, fLat: number;
      const fMax = g.muStatic * surfaceBrake * Fn;
      if (this.anchored[i]) {
        const dN = pN - this.anchorN[i], dE = pE - this.anchorE[i];
        const dLong = dN * t[0] + dE * t[1];
        const dLat = dN * s[0] + dE * s[1];
        fLong = -ANCHOR_K * dLong - ANCHOR_C * vLong;
        fLat = -ANCHOR_K * dLat - ANCHOR_C * vLat;
        const mag = Math.sqrt(fLong * fLong + fLat * fLat);
        if (mag > fMax) { fLong *= fMax / mag; fLat *= fMax / mag; out.anchorSaturated[i] = 1; }
        // a torque-limited brake cannot hold more than its own friction along the wheel
        if (g.brakeMu !== undefined) {
          const lim = g.brakeMu * surfaceBrake * Fn;
          if (fLong > lim || fLong < -lim) { fLong = fLong > 0 ? lim : -lim; out.anchorSaturated[i] = 1; }
        }
      } else if (g.type === 'structure') {
        const sp = Math.sqrt(vLong * vLong + vLat * vLat);
        const k = sp > 1e-6 ? (g.muDynamic * Fn * Math.tanh(sp / V_EPS)) / sp : 0;
        fLong = -k * vLong;
        fLat = -k * vLat;
      } else {
        const brake = g.brakeGroup === 'left' ? ctl.brakeLeft : g.brakeGroup === 'right' ? ctl.brakeRight : g.brakeGroup === 'both' ? Math.max(ctl.brakeLeft, ctl.brakeRight) : 0;
        const muRoll = g.muRolling * surfaceRoll;
        const muLong = muRoll + brake * ((g.brakeMu ?? g.muStatic) * surfaceBrake - muRoll);
        fLong = -muLong * Fn * Math.tanh(vLong / V_EPS);
        const slipDeg = Math.atan2(vLat, Math.max(Math.abs(vLong), 1)) * R2D;
        // a castering wheel swivels instead of carrying side force, also while it is too slow to
        // have trailed into line (it would otherwise skid like a brake at its last swivel angle)
        fLat = this.castering[i] ? 0 : -pacejka(slipDeg, g.pacejka.B, g.pacejka.C, g.muStatic * surfaceBrake, g.pacejka.E) * Fn;
        const mag = Math.sqrt(fLong * fLong + fLat * fLat);
        if (mag > fMax) { fLong *= fMax / mag; fLat *= fMax / mag; }
      }
      out.sideForce[i] = fLat < 0 ? -fLat : fLat;

      const fN = this.fN;
      fN[0] = Fn * nrm[0] + fLong * t[0] + fLat * s[0];
      fN[1] = Fn * nrm[1] + fLong * t[1] + fLat * s[1];
      fN[2] = Fn * nrm[2] + fLong * t[2] + fLat * s[2];
      const fb = qRotate(this.qnb, fN, this.fB);
      F[0] += fb[0]; F[1] += fb[1]; F[2] += fb[2];
      // moment arm at the compressed contact point
      const rz = r[2] - delta;
      M[0] += r[1] * fb[2] - rz * fb[1];
      M[1] += rz * fb[0] - r[0] * fb[2];
      M[2] += r[0] * fb[1] - r[1] * fb[0];

      if (g.type === 'structure') {
        if (g.name === 'Propeller') out.crash = out.crash || 'propeller strike';
        else if (Fn > 3 * weight || delta > 0.3) out.crash = out.crash || `${g.name.toLowerCase()} impact`;
      } else if (delta > 0.4 || Fn > WHEEL_COLLAPSE_W * weight) {
        out.crash = out.crash || `${g.name.toLowerCase()} gear collapse`;
      }
    }
    return out;
  }

  /** Engage/release brake anchors once per step from the latest evaluation. */
  updateAnchors(out: GearOutput, ctl: { brakeLeft: number; brakeRight: number }): void {
    for (let i = 0; i < this.count; i++) {
      const g = this.specs[i];
      const brake = g.brakeGroup === 'left' ? ctl.brakeLeft : g.brakeGroup === 'right' ? ctl.brakeRight : g.brakeGroup === 'both' ? Math.max(ctl.brakeLeft, ctl.brakeRight) : 0;
      const braked = g.type === 'wheel' && brake >= BRAKE_ANCHOR;
      if (this.anchored[i]) {
        if (!braked || !out.inContact[i] || out.anchorSaturated[i]) this.anchored[i] = 0;
      } else if (braked && out.inContact[i] && out.rollSpeed[i] * out.rollSpeed[i] + out.sideSpeed[i] * out.sideSpeed[i] < ANCHOR_SPEED * ANCHOR_SPEED) {
        this.anchored[i] = 1;
        this.anchorN[i] = out.contactN[i];
        this.anchorE[i] = out.contactE[i];
      }
    }
  }

  releaseAnchors(): void { this.anchored.fill(0); }

  /**
   * Swivel lock state of castering wheels, once per step from the latest evaluation: break out when
   * the side force exceeds the breakout force; relock once rolling forward within the relock angle
   * of the steering angle (or when the wheel leaves the ground: the springs centre it).
   */
  updateSwivel(out: GearOutput, steerRad: number): void {
    for (let i = 0; i < this.count; i++) {
      const g = this.specs[i], sw = g.swivel;
      if (!sw || !g.casters || g.type !== 'wheel') continue;
      if (!out.inContact[i]) { this.castering[i] = 0; continue; }
      if (!this.castering[i]) {
        // The steering springs carry the side force of ordinary steering (a pedal reversal makes a
        // large but brief slip angle): the lock only breaks out when the tyre is also being dragged
        // outside the steering arc, i.e. its contact point moves at more than the steering limit
        // from the aircraft's axis (a brake pivot, the tail swinging out in a ground loop).
        const travel = out.wheelAngle[i] + Math.atan2(out.sideSpeed[i], out.rollSpeed[i]);
        const outside = Math.abs(Math.atan2(Math.sin(travel), Math.cos(travel))) > (g.maxSteerDeg + SWIVEL_STOP_MARGIN_DEG) * D2R;
        if (out.sideForce[i] > sw.breakoutN && outside) { this.castering[i] = 1; this.casterAngle[i] = out.wheelAngle[i]; }
        continue;
      }
      this.casterAngle[i] = out.wheelAngle[i];
      const cmd = this.steerSign[i] * steerRad;
      let d = out.wheelAngle[i] - cmd;
      if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
      if (out.rollSpeed[i] > CASTER_ALIGN_SPEED && Math.abs(d) < sw.relockDeg * D2R) this.castering[i] = 0;
    }
  }

  resetSwivel(): void { this.castering.fill(0); this.casterAngle.fill(0); }

  /** Re-express anchor points after a floating-origin rebase (horizontal components only). */
  rebaseAnchors(map: (index: number, n: number, e: number) => [number, number]): void {
    for (let i = 0; i < this.count; i++) {
      if (!this.anchored[i]) continue;
      const [n, e] = map(i, this.anchorN[i], this.anchorE[i]);
      this.anchorN[i] = n;
      this.anchorE[i] = e;
    }
  }
}
