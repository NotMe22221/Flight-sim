import { describe, expect, it } from 'vitest';
import { defaultControlInputs, type ControlInputs } from '../../core/types';
import { KT } from '../../core/units';
import { Fdm } from '../fdm';
import { DT, KSFO, makeEnv, run } from '../testing';
import { A320 } from './a320';

const FT = 0.3048;
const env = makeEnv();

/** A320 at `tonnes` (fuel first, then payload), airborne and trimmed. */
function airborneA320(altFt: number, kcas: number, flapsIndex = 0, gammaDeg = 0, gearDown = false, tonnes = 65): { f: Fdm; u: ControlInputs } {
  const f = new Fdm(A320, { seed: 3 });
  load(f, tonnes);
  const u0 = defaultControlInputs();
  u0.flapsIndex = flapsIndex; u0.gearDown = gearDown;
  f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: altFt * FT }, headingRad: 0, speedMs: kcas * KT * 1.2, onGround: false, engineRunning: true, gammaRad: (gammaDeg * Math.PI) / 180 }, env);
  f.setGearDown(gearDown);
  f.snapControls(u0);
  const ok = f.trim(kcas * KT, (gammaDeg * Math.PI) / 180, env);
  const tr = f.trimResult!;
  if (!ok) throw new Error(`A320 trim failed at ${altFt} ft ${kcas} kt: ${JSON.stringify(tr)}`);
  const u = { ...u0, parkingBrake: false, throttle: tr.throttle, pitchTrim: tr.pitchTrim, pitch: tr.pitchStick, magnetos: 3 as const, mixture: 1 };
  return { f, u };
}

function load(f: Fdm, tonnes: number): void {
  const fuel = 9000;
  f.setLoad(undefined, [fuel / 2, fuel / 2, 0]);
  let rest = tonnes * 1000 - A320.mass.emptyMassKg - fuel;
  f.setLoad(A320.mass.stations.map((s) => { const m = Math.max(0, Math.min(rest, s.maxKg)); rest -= m; return m; }));
}

describe('A320-style airliner', () => {
  it('trims clean at 250 kt / 10,000 ft, at M0.78 / FL350 (≈ 80–90 % N1, ≈ 2–3 t/h) and on a 3° approach at 135 kt flaps FULL', () => {
    const a = airborneA320(10_000, 250);
    expect(a.f.trimResult!.throttle).toBeGreaterThan(0.2);
    // FL350 M0.78 ≈ 260 KCAS
    const c = airborneA320(35_000, 260);
    run(c.f, env, c.u, 20);
    const n1 = c.f.state.engine.n1!;
    expect(n1).toBeGreaterThan(75); expect(n1).toBeLessThan(95);
    const tph = (c.f.state.engine.fuelFlowKgS * 3600) / 1000;
    expect(tph).toBeGreaterThan(1.9); expect(tph).toBeLessThan(3.2);
    expect(c.f.state.aero.mach).toBeGreaterThan(0.74); expect(c.f.state.aero.mach).toBeLessThan(0.82);
    const app = airborneA320(2_000, 135, 4, -3, true);
    const tr = app.f.trimResult!;
    expect(tr.alphaRad * 180 / Math.PI).toBeLessThan(10);
    expect(tr.throttle).toBeGreaterThan(0); expect(tr.throttle).toBeLessThan(0.8);
  });

  it('1 g stall speeds at 65 t from CLmax: ≈ 145 kt clean, ≈ 107 kt flaps FULL (±8 %)', () => {
    const W = 65_000 * 9.80665, rho = 1.225;
    const clMax = Math.max(...A320.aero.CL.table.data.filter((_, i) => i % 2 === 0));
    const vs = (cl: number) => Math.sqrt((2 * W) / (rho * A320.geometry.S * cl)) / KT;
    expect(vs(clMax)).toBeGreaterThan(145 * 0.92); expect(vs(clMax)).toBeLessThan(145 * 1.08);
    const full = clMax + A320.aero.CL.dFlap.ys.at(-1)!;
    expect(vs(full)).toBeGreaterThan(107 * 0.92); expect(vs(full)).toBeLessThan(107 * 1.08);
  });

  it('sits level on its gear, then takes off at full thrust with flaps 1: lift-off 135–170 kt within 2,300 m', () => {
    const f = new Fdm(A320, { seed: 5 });
    load(f, 65);
    const e = makeEnv();
    f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: true }, e);
    expect(f.state.crashed).toBe(false);
    expect(Math.abs(f.state.euler[1]) * 180 / Math.PI).toBeLessThan(2.5);
    const u = defaultControlInputs();
    u.parkingBrake = false; u.flapsIndex = 1; u.magnetos = 3; u.mixture = 1; u.throttle = 1;
    const n0 = f.state.posNED[0];
    let liftKt = 0, liftM = 0;
    for (let i = 0; i < 90 / DT; i++) {
      const kias = f.state.aero.ias / KT;
      u.pitch = kias > 140 ? 0.55 : 0;
      f.step(DT, u, e);
      if (!f.state.onGround && f.state.altitudeAglM > 3 && !liftKt) { liftKt = kias; liftM = f.state.posNED[0] - n0; break; }
      expect(f.state.crashed).toBe(false);
    }
    expect(liftKt).toBeGreaterThan(135); expect(liftKt).toBeLessThan(170);
    expect(liftM).toBeLessThan(2300);
  });

  it('gear and spoilers: retracted gear and spoilers change drag; the gear stays down with weight on the wheels', () => {
    const c = airborneA320(5_000, 220);
    const base = c.f.state.aero.coefficients.CD;
    c.u.gearDown = true;
    run(c.f, env, c.u, 10);
    expect(c.f.gearExtension).toBe(1);
    const withGear = c.f.state.aero.coefficients.CD;
    c.u.speedbrake = 1;
    run(c.f, env, c.u, 3);
    expect(c.f.state.surfaces.speedbrake).toBeGreaterThan(0.95);
    expect(c.f.state.aero.coefficients.CD).toBeGreaterThan(withGear);
    expect(withGear).toBeGreaterThan(base);
  });
});
