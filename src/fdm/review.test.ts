/**
 * Regression tests from the adversarial review of the flight model. Each block pins a defect
 * that the original suite missed (trim convergence, touchdown loads, crash detection, rebase,
 * serialisation, NaN handling).
 */
import { describe, expect, it } from 'vitest';
import { qMul } from '../core/math';
import { defaultControlInputs, type ControlInputs, type Environment, type Quat } from '../core/types';
import { FPM, KT } from '../core/units';
import { makeRebase } from '../world/rebase';
import type { Fdm } from './fdm';
import { AeroModel, newAeroOutput } from './aero';
import { C172S } from './aircraft/c172';
import { flatEnvironment } from './testEnv';
import { DT, KSFO, airborne, frameKSFO, levelWings, makeEnv, makeFdm, run } from './testing';

const MTOW = 1156;
const DEG = Math.PI / 180;
const W = MTOW * 9.80665;

/** White-box view of the private state the tests need to set up exact initial conditions. */
interface Internals {
  y: Float64Array;
  k1: Float64Array;
  flapDeg: number;
  deriv(s: Float64Array, out: Float64Array): void;
  sampleEnvironment(): void;
  gear: { anchored: Uint8Array; anchorN: Float64Array; anchorE: Float64Array };
  gearOut: { contactN: Float64Array; contactE: Float64Array; wheelsOnGround: number };
  crashReason: string;
  env: Environment;
  frame: unknown;
}
const inner = (f: Fdm): Internals => f as unknown as Internals;

// ───────────────────────────── trim ─────────────────────────────

describe('trim: convergence and failure reporting (55–140 KCAS, γ ±5°, flaps 0–30, 0–3000 m)', () => {
  it('converges to < 1e-3 wherever the throttle is not saturated, and reports power-limited points as failures at full/idle throttle', () => {
    const env = makeEnv({ groundAltM: -800 }); // free air down to sea level
    const bad: string[] = [];
    let feasible = 0;
    for (const alt of [0, 1500, 3000]) for (const flaps of [0, 3]) for (const gdeg of [-5, 0, 5]) for (const kc of [55, 70, 90, 110, 140]) {
      if (flaps === 3 && kc > 85) continue;
      const f = makeFdm(MTOW);
      f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt }, headingRad: 0, speedMs: kc * KT, onGround: false, engineRunning: true }, env);
      inner(f).flapDeg = [0, 10, 20, 30][flaps];
      const ok = f.trim(kc * KT, gdeg * DEG, env);
      const t = f.trimResult!;
      const tag = `${alt} m, flaps ${flaps}, γ ${gdeg}°, ${kc} KCAS: ok=${ok} thr=${t.throttle.toFixed(3)} res=${t.residual.toExponential(1)}`;
      if (ok) {
        feasible++;
        if (!(t.residual < 1e-3)) bad.push(`not converged — ${tag}`);
      } else {
        // a failure must be a genuine power limit: throttle pinned at a stop, lift and pitch balanced
        if (t.throttle !== 1 && t.throttle !== 0) bad.push(`failure with unsaturated throttle — ${tag}`);
        const k = new Float64Array(15);
        inner(f).deriv(inner(f).y, k);
        if (Math.abs(k[5]) > 0.01 || Math.abs(k[11]) > 0.01) bad.push(`failure leaves ẇ ${k[5].toFixed(3)} q̇ ${k[11].toFixed(3)} — ${tag}`);
      }
    }
    expect(bad).toEqual([]);
    expect(feasible).toBeGreaterThanOrEqual(36); // the rest are power-limited (e.g. 140 KCAS level at SL, 5° climbs above 1500 m)
  });

  it('standard flight conditions all trim', () => {
    const env = makeEnv({ groundAltM: -800 });
    for (const [alt, kc, gdeg] of [[0, 60, 0], [0, 74, 5], [0, 120, 0], [1500, 100, -5], [3000, 90, 0], [0, 140, -5]]) {
      const f = makeFdm(MTOW);
      f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt }, headingRad: 0, speedMs: kc * KT, onGround: false, engineRunning: true }, env);
      expect(f.trim(kc * KT, gdeg * DEG, env), `${alt} m ${kc} KCAS γ ${gdeg}`).toBe(true);
      expect(f.trimResult!.residual).toBeLessThan(1e-3);
    }
  });
});

// ───────────────────────────── touchdown loads and crash detection ─────────────────────────────

/**
 * Trimmed 54 KCAS (≈ 1.1 Vso) final with full flaps on the glide path that gives `fpm` of sink, moved
 * down so the lowest wheel is 2 cm above the runway: nose ≈ 3–5° up, lift ≈ weight at contact.
 */
function landing(fpm: number, opts: { rollDeg?: number; pitchDeg?: number; extraSinkFpm?: number } = {}) {
  const env = makeEnv();
  const f = makeFdm(MTOW);
  const kc = 54;
  f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: 300 }, headingRad: 0, speedMs: kc * KT, onGround: false, engineRunning: true }, env);
  const I = inner(f);
  I.flapDeg = 30;
  const tas = f.state.aero.tas || kc * KT;
  const gamma = -Math.asin(Math.min(0.5, (fpm * FPM) / tas));
  f.trim(kc * KT, gamma, env);
  const tr = f.trimResult!;
  const y = I.y;
  if (opts.pitchDeg !== undefined || opts.rollDeg) {
    // re-attitude (keeping the NED velocity): θ = pitchDeg, φ = rollDeg
    const q: Quat = [y[6], y[7], y[8], y[9]];
    const vN = [0, 0, 0] as [number, number, number];
    const [w, x, yy, z] = q; // rotate body velocity to NED
    const vb = [y[3], y[4], y[5]];
    const r = (a: number, b: number, c: number) => [
      a * (1 - 2 * (yy * yy + z * z)) + b * 2 * (x * yy - w * z) + c * 2 * (x * z + w * yy),
      a * 2 * (x * yy + w * z) + b * (1 - 2 * (x * x + z * z)) + c * 2 * (yy * z - w * x),
      a * 2 * (x * z - w * yy) + b * 2 * (yy * z + w * x) + c * (1 - 2 * (x * x + yy * yy)),
    ];
    const n = r(vb[0], vb[1], vb[2]); vN[0] = n[0]; vN[1] = n[1]; vN[2] = n[2];
    if (opts.extraSinkFpm) vN[2] += opts.extraSinkFpm * FPM;
    const th = (opts.pitchDeg ?? (Math.asin(Math.max(-1, Math.min(1, 2 * (w * yy - z * x)))) / DEG)) * DEG;
    const ph = (opts.rollDeg ?? 0) * DEG;
    const qn: Quat = qMul([Math.cos(th / 2), 0, Math.sin(th / 2), 0], [Math.cos(ph / 2), Math.sin(ph / 2), 0, 0]);
    y[6] = qn[0]; y[7] = qn[1]; y[8] = qn[2]; y[9] = qn[3];
    // NED → body with the new attitude (transpose of the rotation above)
    const [w2, x2, y2, z2] = qn;
    const m = (a: number, b: number, c: number) => [
      a * (1 - 2 * (y2 * y2 + z2 * z2)) + b * 2 * (x2 * y2 + w2 * z2) + c * 2 * (x2 * z2 - w2 * y2),
      a * 2 * (x2 * y2 - w2 * z2) + b * (1 - 2 * (x2 * x2 + z2 * z2)) + c * 2 * (y2 * z2 + w2 * x2),
      a * 2 * (x2 * z2 + w2 * y2) + b * 2 * (y2 * z2 - w2 * x2) + c * (1 - 2 * (x2 * x2 + y2 * y2)),
    ];
    const b = m(vN[0], vN[1], vN[2]); y[3] = b[0]; y[4] = b[1]; y[5] = b[2];
  } else if (opts.extraSinkFpm) {
    y[5] += opts.extraSinkFpm * FPM; // small-angle: body z ≈ down
  }
  y[10] = y[11] = y[12] = 0;
  // lower until the first wheel touches, then back off 2 cm
  y[2] = -I.env.groundHeight(y[0], y[1]) - 3;
  I.sampleEnvironment(); I.deriv(y, I.k1);
  for (let k = 0; k < 2000 && I.gearOut.wheelsOnGround === 0; k++) { y[2] += 0.002; I.deriv(y, I.k1); }
  y[2] -= 0.02;
  const u = defaultControlInputs();
  u.parkingBrake = false; u.magnetos = 3; u.mixture = 1; u.flapsIndex = 3;
  u.throttle = tr.throttle; u.pitchTrim = tr.pitchTrim; u.pitch = tr.pitchStick;
  let nz = 0, wheelMax = [0, 0, 0];
  run(f, env, u, 1.5, () => {
    if (f.state.crashed) return;
    nz = Math.max(nz, f.state.loadFactor[2]);
    wheelMax = wheelMax.map((v, i) => Math.max(v, f.state.gear[i].normalForceN / W));
  });
  return { nz, wheelMax, crashed: f.state.crashed, reason: I.crashReason };
}

describe('gear: touchdown loads and crash detection', () => {
  // FAR 23.473/23.725: the 172's gear is designed to absorb the limit descent velocity
  // 4.4·(W/S)^¼ = 8.6 ft/s (516 fpm) at a limit gear load factor of ≈ 3 (lift ≈ 2/3 W in the
  // test). A 200 fpm arrival is an ordinary landing; 600 fpm is firm but must not break anything.
  it('a normal 200 fpm landing stays below 2.4 g at the CG', () => {
    const r = landing(200);
    expect(r.crashed).toBe(false);
    expect(r.nz).toBeLessThan(2.4);
  });

  it('a firm 600 fpm landing, wings level or on one wheel, does not crash; each main stays near the limit load', () => {
    const a = landing(600);
    expect(a.crashed, a.reason).toBe(false);
    // limit gear factor ≈ 3 shared by two mains at 516 fpm → ≈ 1.5 W each; scaled to 600 fpm ≈ 1.75
    expect(Math.max(a.wheelMax[1], a.wheelMax[2])).toBeLessThan(1.75);
    expect(a.nz).toBeLessThan(6);
    const b = landing(600, { rollDeg: 5 });
    expect(b.crashed, b.reason).toBe(false);
    expect(Math.max(b.wheelMax[1], b.wheelMax[2])).toBeLessThan(2);
  });

  it('a 1200 fpm arrival collapses the gear', () => {
    const r = landing(600, { extraSinkFpm: 600 });
    expect(r.crashed).toBe(true);
    expect(r.reason).toMatch(/gear collapse|propeller strike/);
  });

  it('a hard nose-first arrival strikes the propeller; maximum braking does not', () => {
    const r = landing(600, { pitchDeg: -2, extraSinkFpm: 300 });
    expect(r.crashed).toBe(true);
    expect(r.reason).toMatch(/propeller strike|nose gear collapse/);

    const env = makeEnv();
    const f = makeFdm(MTOW);
    f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: true }, env);
    inner(f).y[3] = 25; // ≈ 49 kt
    const u = defaultControlInputs();
    u.parkingBrake = false; u.brakeLeft = 1; u.brakeRight = 1; u.magnetos = 3; u.mixture = 1;
    run(f, env, u, 12); // stops at ≈ 7.5 s, then the airframe rocks back onto the nose strut
    expect(f.state.crashed).toBe(false);
    expect(f.state.groundSpeedMs).toBeLessThan(0.05);
  });
});

// ───────────────────────────── floating-origin rebase ─────────────────────────────

describe('rebase', () => {
  /** Parked with the brake set 21 km from the origin, rebased exactly as World.maybeRebase does. */
  function parkedFar() {
    const env = flatEnvironment(frameKSFO.info, { groundAltM: KSFO.elev });
    const g = frameKSFO.nedToGeodetic(20500, 5000, 0);
    const f = makeFdm(MTOW);
    f.reset({ geo: { lat: g.lat, lon: g.lon, alt: g.alt }, headingRad: 1, speedMs: 0, onGround: true, engineRunning: true }, env);
    const u = defaultControlInputs();
    u.parkingBrake = true; u.magnetos = 3; u.mixture = 1; u.throttle = 0.2;
    run(f, env, u, 2);
    const pos = f.state.posNED.slice() as [number, number, number];
    const t = makeRebase(frameKSFO, pos);
    const groundMsl = frameKSFO.nedToGeodetic(pos[0], pos[1], -env.groundHeight(pos[0], pos[1])).alt;
    const env2 = flatEnvironment(t.newFrame.info, { groundAltM: groundMsl });
    return { f, u, t, env2, geo: { ...f.state.geo } };
  }

  it('updates the published AircraftState immediately (the app copies it into the interpolation buffer)', () => {
    const { f, t } = parkedFar();
    const y = inner(f).y;
    const velBefore = f.state.velNED.slice();
    const hdgBefore = f.state.headingTrueRad;
    f.rebase(t.rotation, t.translationNED);
    expect(f.state.posNED[0]).toBeCloseTo(y[0], 9);
    expect(f.state.posNED[1]).toBeCloseTo(y[1], 9);
    expect(f.state.posNED[2]).toBeCloseTo(y[2], 9);
    expect(Math.hypot(f.state.posNED[0], f.state.posNED[1])).toBeLessThan(5);
    // attitude output is the conjugate of the integrated body→NED quaternion
    expect(f.state.qNB[0]).toBeCloseTo(y[6], 12);
    expect(f.state.qNB[1]).toBeCloseTo(-y[7], 12);
    // heading changes only by the meridian convergence (< 1°), speed magnitude is unchanged
    expect(Math.abs(f.state.headingTrueRad - hdgBefore)).toBeLessThan(1 * DEG);
    expect(Math.hypot(...f.state.velNED)).toBeCloseTo(Math.hypot(...velBefore), 9);
  });

  it('keeps brake anchors under the wheels: no lurch, anchors stay engaged', () => {
    const { f, u, t, env2, geo } = parkedFar();
    const I = inner(f);
    const anchoredBefore = Array.from(I.gear.anchored);
    expect(anchoredBefore.filter((a) => a).length).toBeGreaterThanOrEqual(2);
    // anchor spring deflection (anchor − wheel contact) before and after: the rebase must not change it
    const offsets = () => anchoredBefore.map((a, i) => (a ? Math.hypot(I.gear.anchorN[i] - I.gearOut.contactN[i], I.gear.anchorE[i] - I.gearOut.contactE[i]) : 0));
    I.deriv(I.y, I.k1);
    const before = offsets();
    f.rebase(t.rotation, t.translationNED);
    I.frame = null; I.env = env2; I.sampleEnvironment(); I.deriv(I.y, I.k1);
    const after = offsets();
    for (let i = 0; i < anchoredBefore.length; i++) expect(Math.abs(after[i] - before[i]), `wheel ${i}: ${before[i]} → ${after[i]} m`).toBeLessThan(0.001);
    // (the flat test ground of the old frame is tilted 3.3 mrad against the new frame's level ground,
    // so the airframe re-settles by a few millimetres; the anchors must hold throughout)
    let vMax = 0, released = false;
    run(f, env2, u, 2, () => {
      vMax = Math.max(vMax, Math.hypot(...f.state.velBody));
      for (let i = 0; i < anchoredBefore.length; i++) if (anchoredBefore[i] && !I.gear.anchored[i]) released = true;
    });
    expect(released).toBe(false);
    expect(vMax).toBeLessThan(0.03);
    expect(Math.abs(f.state.geo.lat - geo.lat) * 111_000).toBeLessThan(0.01);
  });
});

// ───────────────────────────── serialisation ─────────────────────────────

describe('serialise / deserialise', () => {
  it('restores into a FRESH instance bit-exactly (airborne in turbulence)', () => {
    const env = makeEnv({ turbulence: { w20Kt: 20, intensity: 3, seed: 9 } });
    const a = makeFdm(MTOW, 11);
    const u = airborne(a, env, 800, 95);
    run(a, env, u, 5);
    const snap = a.serialize();
    const b = makeFdm(MTOW, 11); // never reset: no environment yet
    b.deserialize(snap);
    run(a, env, u, 5);
    run(b, env, u, 5);
    expect(b.serialize()).toBe(a.serialize());
  });

  it('restores into a FRESH instance bit-exactly (taxiing with nose-wheel steering)', () => {
    const env = makeEnv();
    const a = makeFdm(MTOW, 11);
    a.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 1, speedMs: 0, onGround: true, engineRunning: true }, env);
    const u = defaultControlInputs();
    u.parkingBrake = false; u.throttle = 0.5; u.magnetos = 3; u.mixture = 1; u.yaw = 0.3;
    run(a, env, u, 8);
    const snap = a.serialize();
    const b = makeFdm(MTOW, 11);
    b.deserialize(snap);
    expect(b.state.groundSpeedMs).toBeCloseTo(a.state.groundSpeedMs, 12);
    run(a, env, u, 5);
    run(b, env, u, 5);
    expect(b.serialize()).toBe(a.serialize());
  });
});

// ───────────────────────────── NaN guards ─────────────────────────────

describe('robustness to bad inputs', () => {
  it('a non-finite control input does not destroy the aircraft', () => {
    const env = makeEnv();
    const f = makeFdm(MTOW);
    const u = airborne(f, env, 1000, 100);
    const bad: ControlInputs = { ...u, pitch: NaN, roll: Infinity, throttle: NaN, yaw: -Infinity, pitchTrim: NaN, brakeLeft: NaN, flapsIndex: NaN };
    run(f, env, bad, 1);
    expect(f.state.crashed).toBe(false);
    run(f, env, u, 5, () => levelWings(f, u));
    expect(f.state.crashed).toBe(false);
    for (const v of [...f.state.posNED, ...f.state.velBody, ...f.state.rates, f.state.aero.alphaDot, f.state.engine.rpm]) expect(Number.isFinite(v)).toBe(true);
  });

  it('a zero or negative time step is a no-op, not a NaN', () => {
    const env = makeEnv();
    const f = makeFdm(MTOW);
    const u = airborne(f, env, 1000, 100);
    run(f, env, u, 1);
    const before = f.serialize();
    f.step(0, u, env);
    f.step(-DT, u, env);
    f.step(NaN, u, env);
    expect(f.serialize()).toBe(before);
    run(f, env, u, 1);
    expect(f.state.crashed).toBe(false);
    expect(Number.isFinite(f.state.aero.alphaDot)).toBe(true);
  });
});

// ───────────────────────────── stall warning ─────────────────────────────

describe('stall warning', () => {
  /**
   * Quasi-static 1 g: the highest trimmed speed (power-off-ish 5° glide) at which the warning is
   * on, and the 1 g stall speed from the lift ratio to the CL peak at the same elevator and flaps.
   */
  function margins(flapDeg: number) {
    const env = makeEnv();
    const trimmed = (kc: number) => {
      const f = makeFdm(MTOW);
      f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: 1500 }, headingRad: 0, speedMs: kc * KT, onGround: false, engineRunning: true }, env);
      inner(f).flapDeg = flapDeg;
      f.trim(kc * KT, -5 * DEG, env);
      return f;
    };
    let lo = 40, hi = 90;
    for (let i = 0; i < 20; i++) { const mid = 0.5 * (lo + hi); if (trimmed(mid).state.warnings.stall) lo = mid; else hi = mid; }
    const f = trimmed(lo);
    const tr = f.trimResult!;
    const m = new AeroModel(C172S), o = newAeroOutput();
    const cl = (alpha: number) => m.compute({ alpha, beta: 0, V: 30, rho: 1.2, qbar: 540, qbarUW: 540, qbarTail: 540, qbarInduced: 0, propSense: 1, p: 0, q: 0, r: 0, alphaDot: 0, de: tr.elevatorRad, da: 0, dr: 0, flapDeg, hOverB: Infinity, hyst: 0 }, o).CL;
    let clMax = 0;
    for (let a = 0.15; a < 0.4; a += 0.001) clMax = Math.max(clMax, cl(a));
    const vStall = lo * Math.sqrt(cl(tr.alphaRad) / clMax);
    return { warn: lo, stall: vStall };
  }

  it('sounds 5–10 kt above the 1 g stall, flaps up and flaps 30 (172S POH: "5 to 10 knots above the stall")', () => {
    for (const flaps of [0, 30]) {
      const { warn, stall } = margins(flaps);
      expect(stall, `flaps ${flaps}: 1 g stall`).toBeGreaterThan(flaps ? 44 : 49);
      expect(stall).toBeLessThan(flaps ? 52 : 57);
      expect(warn - stall, `flaps ${flaps}: warning ${warn.toFixed(1)} KCAS, stall ${stall.toFixed(1)} KCAS`).toBeGreaterThanOrEqual(5);
      expect(warn - stall).toBeLessThanOrEqual(10);
    }
  });
});
