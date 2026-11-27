import { describe, expect, it } from 'vitest';
import { defaultControlInputs, type ControlInputs } from '../core/types';
import { DEG, FT, KT } from '../core/units';
import { A320 } from '../fdm/aircraft/a320';
import { Fdm } from '../fdm/fdm';
import { DT, KSFO, makeEnv } from '../fdm/testing';
import { FlyByWire } from './fbw';

const env = makeEnv();

function trimmed(altFt: number, kcas: number): { f: Fdm; base: ControlInputs; fbw: FlyByWire } {
  const f = new Fdm(A320, { seed: 9 });
  f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: altFt * FT }, headingRad: 0, speedMs: kcas * KT * 1.2, onGround: false, engineRunning: true }, env);
  f.setGearDown(false);
  const u0 = defaultControlInputs(); u0.gearDown = false;
  f.snapControls(u0);
  if (!f.trim(kcas * KT, 0, env)) throw new Error('trim');
  const tr = f.trimResult!;
  const base = { ...u0, parkingBrake: false, throttle: tr.throttle, pitchTrim: tr.pitchTrim, pitch: 0, magnetos: 3 as const, mixture: 1 };
  const fbw = new FlyByWire({ vmoKt: 350, alphaProtRad: 0.2, alphaFloorRad: 0.23 });
  fbw.reset(tr.pitchStick, true);
  return { f, base, fbw };
}

/** Fly `seconds` with the pilot's stick from `pilot(t)` through the law. */
function fly(c: ReturnType<typeof trimmed>, seconds: number, pilot: (t: number, u: ControlInputs) => void, each?: (t: number) => void): void {
  const u = { ...c.base };
  for (let t = 0; t < seconds; t += DT) {
    u.pitch = 0; u.roll = 0; u.yaw = 0;
    pilot(t, u);
    c.fbw.apply(u, c.f.state, DT);
    c.f.step(DT, u, env);
    each?.(t);
  }
}

describe('fly-by-wire normal law (A320)', () => {
  it('hands off: holds altitude (± 150 ft) and wings level for a minute', () => {
    const c = trimmed(10_000, 250);
    const alt0 = c.f.state.altitudeMslM;
    let maxDev = 0, maxBank = 0;
    fly(c, 60, () => {}, () => { maxDev = Math.max(maxDev, Math.abs(c.f.state.altitudeMslM - alt0)); maxBank = Math.max(maxBank, Math.abs(c.f.state.euler[0])); });
    expect(maxDev / FT).toBeLessThan(150);
    expect(maxBank / DEG).toBeLessThan(3);
  });

  it('roll: half stick rolls at ≈ 7.5 °/s; released at ≈ 20° the bank is held, and the turn keeps its altitude', () => {
    const c = trimmed(10_000, 250);
    const alt0 = c.f.state.altitudeMslM;
    fly(c, 2.7, (_t, u) => { u.roll = 0.5; });
    const b0 = c.f.state.euler[0] / DEG;
    expect(b0).toBeGreaterThan(14); expect(b0).toBeLessThan(26);
    fly(c, 20, () => {});
    expect(Math.abs(c.f.state.euler[0] / DEG - b0)).toBeLessThan(4);
    expect(Math.abs(c.f.state.altitudeMslM - alt0) / FT).toBeLessThan(250);
  });

  it('pitch: 1/3 stick back pulls ≈ 1.5 g; full stick forward does not go past −15° pitch', () => {
    const c = trimmed(10_000, 250);
    let maxNz = 0;
    fly(c, 3, (_t, u) => { u.pitch = 1 / 3; }, () => { maxNz = Math.max(maxNz, c.f.state.loadFactor[2]); });
    expect(maxNz).toBeGreaterThan(1.3); expect(maxNz).toBeLessThan(1.75);
    const d = trimmed(10_000, 250);
    let minPitch = 0;
    fly(d, 15, (_t, u) => { u.pitch = -1; }, () => { minPitch = Math.min(minPitch, d.f.state.euler[1]); });
    expect(minPitch / DEG).toBeGreaterThan(-18);
  });
});

describe('autothrust (A320)', () => {
  it('SPEED: accelerates from 250 to 280 kt and holds it within ± 5 kt; slows back to 250', async () => {
    const { AutoThrust } = await import('./autothrust');
    const c = trimmed(10_000, 250);
    const at = new AutoThrust();
    at.engage(true, c.base.throttle);
    const ap = { engaged: false, vertical: 'PIT', iasTargetMs: 280 * KT, altitudeTargetM: 0 } as unknown as import('../core/types').AutopilotState;
    const u = { ...c.base };
    const flyAt = (seconds: number, each?: () => void) => {
      for (let t = 0; t < seconds; t += DT) {
        u.pitch = 0; u.roll = 0; u.yaw = 0;
        const thr = at.update(DT, c.f.state, ap, c.fbw.alphaFloor, false);
        if (thr !== null) u.throttle = thr;
        c.fbw.apply(u, c.f.state, DT);
        c.f.step(DT, u, env);
        each?.();
      }
    };
    flyAt(120);
    let worst = 0;
    flyAt(60, () => { worst = Math.max(worst, Math.abs(c.f.state.aero.ias / KT - 280)); });
    expect(worst).toBeLessThan(5);
    ap.iasTargetMs = 250 * KT;
    flyAt(150);
    expect(Math.abs(c.f.state.aero.ias / KT - 250)).toBeLessThan(6);
  });
});
