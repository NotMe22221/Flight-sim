import { it } from 'vitest';
import { defaultControlInputs } from '../core/types';
import { DEG, FPM, FT, KT } from '../core/units';
import { GfcAutopilot } from './Autopilot';
import { TestPlant, makeNavRadioState } from './testPlant';

const nav = { nav1: makeNavRadioState(), nav2: makeNavRadioState(), plan: null };

it('traces', () => {
  for (const V of [70, 100, 160]) {
    const plant = new TestPlant({ speedMs: V * KT, altitudeM: 3000 * FT, headingRad: 0 });
    const ap = new GfcAutopilot();
    const u = defaultControlInputs(); u.throttle = plant.levelThrottle();
    ap.engage(true); ap.setHeadingBug(180); ap.setLateral('HDG');
    let maxBank = 0; const rows: string[] = [];
    for (let i = 0; i < 120 * 40; i++) {
      ap.update(1 / 120, plant.state, nav); plant.step(1 / 120, ap.apply(u));
      maxBank = Math.max(maxBank, Math.abs(plant.state.euler[0] / DEG));
      if (i % 120 === 0) rows.push(`${(i / 120).toFixed(0)}s hdg=${(plant.state.headingMagRad / DEG).toFixed(1)} roll=${(plant.state.euler[0] / DEG).toFixed(2)} cmd=${(ap.rollCommandRad / DEG).toFixed(2)} ail=${ap.state.outRoll.toFixed(3)}`);
    }
    console.log(`HDG V=${V} maxBank=${maxBank.toFixed(2)}\n` + rows.slice(0, 12).join('\n'));
  }
  // FLC
  {
    const plant = new TestPlant({ speedMs: 90 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    const ap = new GfcAutopilot();
    const u = defaultControlInputs(); u.throttle = 1;
    ap.setAltitudeTarget(12000 * FT); ap.engage(true); ap.setIasTarget(90 * KT); ap.setVertical('FLC');
    const rows: string[] = [];
    for (let i = 0; i < 120 * 120; i++) {
      ap.update(1 / 120, plant.state, nav); plant.step(1 / 120, ap.apply(u));
      if (i % 240 === 0) rows.push(`${(i / 120).toFixed(0)}s ias=${(plant.state.aero.ias / KT).toFixed(2)} vs=${(plant.state.verticalSpeedMs / FPM).toFixed(0)} pitch=${(plant.state.euler[1] / DEG).toFixed(2)} cmd=${(ap.pitchCommandRad / DEG).toFixed(2)} elev=${ap.state.outPitch.toFixed(3)} trim=${ap.state.trimCommand.toFixed(3)}`);
    }
    console.log('FLC\n' + rows.join('\n'));
  }
});
