import { it } from 'vitest';
import type { Navaid } from '../core/types';
import { wrap360, wrapPi } from '../core/math';
import { DEG, FT, NM } from '../core/units';
import { destinationPoint } from '../geo/wgs84';
import { computeVorRadio, type NavRadioStateEx } from '../nav';
import { ZohSim } from './reviewHarness';

it('vor legs', () => {
  for (const scaleMax of [1, 3]) {
    for (const [leg, distNm] of [['to', 25], ['from', 8], ['to', 40]] as const) {
      const sim = new ZohSim(3000 * FT, 100, 90, 2);
      (sim.ap.config.gains as unknown as Record<string, number>).vorScaleMax = scaleMax;
      const mv = wrapPi(sim.ac.headingTrueRad - sim.ac.headingMagRad) / DEG;
      const p0 = { lat: sim.ac.geo.lat, lon: sim.ac.geo.lon, alt: 4 };
      const onCourse = destinationPoint(p0, 0, 2 * NM, 4);
      const station: Navaid = { id: 'TST', type: 'VOR-DME', name: 'T', frequencyKHz: 113900, magneticVariationDeg: mv, rangeNm: 130,
        position: leg === 'to' ? destinationPoint(onCourse, 90, distNm * NM, 4) : destinationPoint(onCourse, 270, distNm * NM, 4) };
      const tuning = { activeKHz: 113900, standbyKHz: 113900, obsDeg: wrap360(90 - mv) };
      const rx = sim.nav1 as NavRadioStateEx;
      sim.pilotHook = (s) => { computeVorRadio(s.ac.geo, mv, station, tuning, rx); };
      sim.ap.engage(true); sim.ap.setLateral('NAV');
      let line = `scaleMax ${scaleMax} ${leg} ${distNm} nm:`, next = 0, maxOver = 0, crossed = false;
      sim.run(400, (s) => {
        if (rx.cdi > 0.02) crossed = true;
        if (crossed) maxOver = Math.max(maxOver, rx.cdi);
        if (s.t >= next) { next += 60; line += ` [${s.t.toFixed(0)}s cdi ${rx.cdi.toFixed(3)} dme ${rx.dmeNm.toFixed(1)} trk ${(s.ac.trackRad / DEG).toFixed(1)}]`; }
      });
      console.log(`${line} overshoot ${maxOver.toFixed(3)}`);
    }
  }
});
