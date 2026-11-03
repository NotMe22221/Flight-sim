import { it } from 'vitest';
import { wrapPi } from '../core/math';
import { DEG, FT, NM } from '../core/units';
import { destinationPoint } from '../geo/wgs84';
import { computeIlsRadio, type IlsGeometry } from '../nav';
import { ZohSim } from './reviewHarness';

const buildIls = (sim: ZohSim, courseDeg: number, offsetRightNm: number, distNm: number): IlsGeometry => {
  const p0 = { lat: sim.ac.geo.lat, lon: sim.ac.geo.lon, alt: 4 };
  const q = destinationPoint(p0, courseDeg - 90, offsetRightNm * NM, 4);
  const thr = destinationPoint(q, courseDeg, distNm * NM, 4);
  const loc = destinationPoint(thr, courseDeg, 3000, 4);
  const gsRef = destinationPoint(thr, courseDeg, 300, 4);
  return {
    airport: 'TEST', runway: '28', ident: 'ITST', frequencyKHz: 110300, courseDeg, threshold: thr, locAntenna: loc,
    locFullScaleDeg: Math.atan(106.7 / 3000) / DEG, gsAntenna: gsRef, gsReference: gsRef, glideslopeDeg: 3,
    markers: { outer: thr, middle: thr, inner: thr }, synthetic: true,
  };
};

it('APR with the real nav receiver', () => {
  for (const [label, obsMode, sub] of [['obs=LOC course', 'loc', 2], ['obs=LOC course 30Hz', 'loc', 4], ['obs=0 (app default)', 'zero', 2]] as const) {
    const sim = new ZohSim(2000 * FT, 90, 250, sub);
    const ils = buildIls(sim, 280, 1, 8);
    const magvar = wrapPi(sim.ac.headingTrueRad - sim.ac.headingMagRad) / DEG;
    const tuning = { activeKHz: 110300, standbyKHz: 110300, obsDeg: obsMode === 'loc' ? (((280 - magvar) % 360) + 360) % 360 : 0 };
    const upd = () => computeIlsRadio(sim.ac.geo, magvar, ils, tuning, sim.nav1 as never);
    upd();
    const origFrame = sim.frame.bind(sim);
    sim.frame = () => { upd(); origFrame(); };
    sim.ap.setAltitudeTarget(2000 * FT);
    sim.ap.engage(true);
    sim.ap.setVertical('ALT');
    sim.ap.setHeadingBug(Math.round(sim.ac.headingMagRad / DEG));
    sim.ap.setLateral('HDG');
    sim.ap.setLateral('APR');
    let locT = -1, gsT = -1, maxGs = 0, maxCdi = 0, maxBank = 0;
    sim.run(400, (s) => {
      if (locT < 0 && s.s.lateral === 'APR') locT = s.t;
      if (gsT < 0 && s.s.vertical === 'GS') gsT = s.t;
      maxBank = Math.max(maxBank, Math.abs(s.ac.euler[0]) / DEG);
      if (gsT > 0 && s.t > gsT + 30 && s.nav1.dmeNm > 1.2) { maxGs = Math.max(maxGs, Math.abs(s.nav1.gsDeviation * 2)); maxCdi = Math.max(maxCdi, Math.abs(s.nav1.cdi)); }
      if (s.nav1.dmeNm < 1.0 && s.nav1.valid) return true;
    });
    console.log(`${label}: magvar ${magvar.toFixed(1)} obs ${tuning.obsDeg.toFixed(1)} locT ${locT.toFixed(1)} gsT ${gsT.toFixed(1)} maxGsDots ${maxGs.toFixed(3)} maxCdi ${maxCdi.toFixed(3)} maxBank ${maxBank.toFixed(1)} end dme ${sim.nav1.dmeNm.toFixed(2)} cdi ${sim.nav1.cdi.toFixed(2)} valid ${sim.nav1.valid} hdgTrue ${(sim.ac.headingTrueRad / DEG).toFixed(0)} t ${sim.t.toFixed(0)} lat ${sim.s.lateral} vert ${sim.s.vertical} alt ${(sim.ac.altitudeIndicatedM / FT).toFixed(0)}`);
  }
});
