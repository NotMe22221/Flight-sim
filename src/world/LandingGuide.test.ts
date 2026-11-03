import { describe, expect, it } from 'vitest';
import type { Airport, Runway } from '../core/types';
import { aimPointM, relativeToRunway, runwayEnds } from '../activities/runwayFrame';
import { LocalFrame, destinationPoint, greatCircleDistance } from '../geo/wgs84';
import { GATE_DISTANCES_M, GLIDE_DEG, LandingGuide, gateCentre, selectApproachEnd } from './LandingGuide';

const rw = (ident: string, a: [number, number, number], b: [number, number, number], headingDeg: number, lengthM: number): Runway => ({
  ident, threshold: { lat: a[0], lon: a[1], alt: a[2] }, end: { lat: b[0], lon: b[1], alt: b[2] }, headingDeg, lengthM, widthM: 61,
  surface: 'asphalt', lighted: true, displacedThresholdM: 0,
});
const KSFO: Airport = {
  icao: 'KSFO', name: 'San Francisco Intl', position: { lat: 37.619806, lon: -122.374821, alt: 4 }, elevationM: 4, type: 'large', country: 'US',
  runways: [
    rw('10L/28R', [37.628742, -122.39341, 1.5], [37.613538, -122.35716, 4], 118, 3618),
    rw('1R/19L', [37.606333, -122.381061, 3.7], [37.627346, -122.367124, 3], 28, 2640),
  ],
};
const end28R = runwayEnds(KSFO, KSFO.runways[0])[1];
const D2R = Math.PI / 180;

/** A point on the extended centreline of 28R, `nm` before the threshold, at `altM`. */
const onFinal = (nm: number, altM: number, crossM = 0) => {
  const p = destinationPoint(end28R.threshold, end28R.headingDeg + 180, nm * 1852);
  const q = destinationPoint(p, end28R.headingDeg + 90, crossM);
  return { lat: q.lat, lon: q.lon, alt: altM };
};

describe('selectApproachEnd', () => {
  it('picks 28R for an aircraft on a 5 nm final tracking 298°', () => {
    const e = selectApproachEnd(onFinal(5, 500), 298, [KSFO]);
    expect(e?.ident).toBe('28R');
  });
  it('ignores runways behind the aircraft, crossing tracks, a wide offset and too much height', () => {
    expect(selectApproachEnd(onFinal(5, 500), 118, [KSFO])).toBeNull(); // flying away
    expect(selectApproachEnd(onFinal(5, 500), 210, [KSFO])).toBeNull(); // crossing
    expect(selectApproachEnd(onFinal(5, 500, 6000), 298, [KSFO])).toBeNull(); // 6 km abeam
    expect(selectApproachEnd(onFinal(5, 2500), 298, [KSFO])).toBeNull(); // 8000 ft overhead
    expect(selectApproachEnd(onFinal(12, 600), 298, [KSFO])).toBeNull(); // beyond 16 km
  });
});

describe('gateCentre', () => {
  it('stands on the 3° glidepath, on the extended centreline, before the aim point', () => {
    for (const d of [250, 2000, 7700]) {
      const g = gateCentre(end28R, d);
      const rel = relativeToRunway(g, end28R);
      // relativeToRunway is flat-earth: allow 0.05 % of the distance
      expect(Math.abs(rel.alongM - (aimPointM(end28R.lengthM) - d))).toBeLessThan(0.5 + 0.0005 * d);
      expect(Math.abs(rel.crossM)).toBeLessThan(1 + 0.0006 * d); // great circle vs flat-earth frame
      expect(g.alt - end28R.threshold.alt).toBeCloseTo(d * Math.tan(GLIDE_DEG * D2R), 3);
    }
  });
});

describe('LandingGuide', () => {
  const frame = new LocalFrame(37.613538, -122.35716, 0);

  it('shows gates ahead of the aircraft only, and hides when disabled or on the ground', () => {
    const guide = new LandingGuide();
    const pos = onFinal(2, 200);
    guide.update(0.1, true, pos, 298, false, [KSFO], frame);
    expect(guide.group.visible).toBe(true);
    expect(guide.end?.ident).toBe('28R');
    const mesh = guide.group.children[0] as import('three').InstancedMesh;
    const flown = greatCircleDistance(pos, gateCentre(end28R, 0));
    let shown = 0;
    const m = new (mesh.instanceMatrix.array.constructor as Float32ArrayConstructor)(16);
    for (let i = 0; i < GATE_DISTANCES_M.length; i++) {
      for (let k = 0; k < 16; k++) m[k] = mesh.instanceMatrix.array[i * 16 + k];
      const visible = m[0] !== 0 || m[5] !== 0 || m[10] !== 0;
      if (visible) { shown++; expect(GATE_DISTANCES_M[i]).toBeLessThan(flown); }
    }
    expect(shown).toBeGreaterThan(3);
    expect(shown).toBeLessThan(GATE_DISTANCES_M.length);
    guide.update(0.1, false, pos, 298, false, [KSFO], frame);
    expect(guide.group.visible).toBe(false);
    guide.update(0.1, true, pos, 298, true, [KSFO], frame);
    expect(guide.group.visible).toBe(false);
    guide.dispose();
  });
});
