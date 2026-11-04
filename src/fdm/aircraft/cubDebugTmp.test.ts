import { appendFileSync } from 'node:fs';
import { it } from 'vitest';
import { FT } from '../../core/units';
import { Fdm } from '../fdm';
import { DT, airborne, makeEnv, run } from '../testing';
import { PA18_150 } from './cub';
import { C172S } from './c172';
const OUT = '/tmp/claude-0/-home-user-Flight-sim/7bee71d5-9f1f-55ef-9ffc-73df5cf9c113/scratchpad/cub-review/dbg.txt';
it('debug spin', () => {
  for (const [label, cfg, load, power] of [['cub solo', PA18_150, [77, 0, 0], 0], ['cub gross', PA18_150, [112, 111, 22.7], 0], ['cub solo power', PA18_150, [77, 0, 0], 1], ['c172', C172S, [77, 0, 0, 0, 0, 0], 0]] as [string, typeof C172S, number[], number][]) {
    const env = makeEnv();
    const f = new Fdm(cfg, { seed: 1 });
    f.setFuelFraction(1); f.setLoad(load.slice(0, cfg.mass.stations.length));
    const u = airborne(f, env, 1500, cfg.limits.Vs1Kt * 1.3);
    const D = 180 / Math.PI;
    // entry: idle (or power), stick full aft, full right rudder at the break; hold 3 s past the break then 2 more turns
    u.throttle = power; let t = 0, turns = 0, lastH = f.state.headingTrueRad, phase = 0, tRec = 0, hRec = 0, turnsRec = 0, tStop = NaN, minAlt = 1e9; const rows: string[] = [];
    run(f, env, u, 60, () => {
      t += DT; const s = f.state;
      let dh = s.headingTrueRad - lastH; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI; lastH = s.headingTrueRad;
      if (phase === 0) { u.pitch = Math.min(1, t / 4); u.roll = 0; u.yaw = s.aero.stalled ? 1 : 0; turns += dh / (2 * Math.PI); if (turns > 2) { phase = 1; tRec = t; hRec = s.altitudeMslM; } }
      else if (phase === 1) { u.throttle = 0; u.roll = 0; u.yaw = -1; u.pitch = -0.5; turnsRec += dh / (2 * Math.PI); if (Math.abs(s.rates[2]) < 10 / D && t - tRec > 0.5) { phase = 2; tStop = t - tRec; } }
      else { u.yaw = Math.max(-1, Math.min(1, 10 * s.aero.beta)); u.roll = Math.max(-1, Math.min(1, -2 * s.euler[0])); u.pitch = s.loadFactor[2] < 3 ? 0.6 : 0.2; minAlt = Math.min(minAlt, s.altitudeMslM); if (s.euler[1] > 0 && s.verticalSpeedMs > -1) phase = 3; }
      if (Math.abs(t - Math.round(t)) < DT / 2) rows.push(`${label} t=${t.toFixed(0)} ph=${phase} ias=${(s.aero.ias / 0.5144).toFixed(0)} pitch=${(s.euler[1] * D).toFixed(0)} roll=${(s.euler[0] * D).toFixed(0)} r=${(s.rates[2] * D).toFixed(0)} p=${(s.rates[0] * D).toFixed(0)} alpha=${(s.aero.alpha * D).toFixed(0)} vs=${(s.verticalSpeedMs / 0.00508).toFixed(0)} alt=${(s.altitudeMslM / FT).toFixed(0)} turns=${turns.toFixed(1)}`);
    });
    appendFileSync(OUT, rows.filter((_, i) => i % 2 === 0).join('\n') + `\n${label}: rotation stopped ${tStop.toFixed(1)} s after PARE (${(turnsRec).toFixed(2)} turns), altitude from recovery start to bottom ${((hRec - minAlt) / FT).toFixed(0)} ft, final phase ${phase}, crashed ${f.state.crashed}\n\n`);
  }
});
