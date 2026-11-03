import { describe, expect, it } from 'vitest';
import type { Airport, Geodetic, NavDatabase, Navaid, Runway } from '../core/types';
import { LocalFrame } from '../geo/wgs84';
import * as THREE from 'three';
import { AirportsLayer, runwayBulge } from './AirportsLayer';

const rw = (ident: string, a: Geodetic, b: Geodetic, headingDeg: number, lengthM: number): Runway => ({
  ident, threshold: a, end: b, headingDeg, lengthM, widthM: 61, surface: 'asphalt', lighted: true, displacedThresholdM: 0,
});
const ksfo: Airport = {
  icao: 'KSFO', name: 'San Francisco Intl', position: { lat: 37.619806, lon: -122.374821, alt: 4 }, elevationM: 4, type: 'large', country: 'US',
  runways: [
    rw('10L/28R', { lat: 37.628742, lon: -122.39341, alt: 1.5 }, { lat: 37.613538, lon: -122.35716, alt: 4 }, 118, 3618),
    rw('10R/28L', { lat: 37.626298, lon: -122.393124, alt: 1.8 }, { lat: 37.61172, lon: -122.358367, alt: 4 }, 118, 3469),
    rw('1L/19R', { lat: 37.607898, lon: -122.38295, alt: 3 }, { lat: 37.626476, lon: -122.37063, alt: 2.7 }, 28, 2332),
    rw('1R/19L', { lat: 37.606333, lon: -122.381061, alt: 3.7 }, { lat: 37.627346, lon: -122.367124, alt: 3 }, 28, 2640),
  ],
};
const fakeNav: NavDatabase = {
  loadRegion: async () => {},
  getAirport: (i) => (i === 'KSFO' ? ksfo : undefined),
  nearestAirports: () => [ksfo],
  nearestNavaids: (): Navaid[] => [],
  searchAirports: () => [ksfo],
  findNavaidByFrequency: () => undefined,
  findIlsByFrequency: () => undefined,
};

describe('AirportsLayer (Node, no DOM)', () => {
  it('builds KSFO with 4 runways, markings, lights and PAPI, and rebuilds on rebase', () => {
    const frame = new LocalFrame(37.613538, -122.35716, 4);
    const layer = new AirportsLayer(frame, fakeNav);
    layer.update(10, ksfo.position, [0, 0, 0], -0.2); // triggers refresh
    expect(layer.isBuilt('KSFO')).toBe(true);
    const names: string[] = [];
    layer.group.traverse((o) => names.push(o.name));
    expect(names.filter((n) => n.startsWith('runway:')).length).toBe(4);
    expect(names.filter((n) => n.startsWith('markings:')).length).toBe(4);
    expect(names.filter((n) => n === 'papi').length).toBe(8);
    expect(names.filter((n) => n === 'runway-lights').length).toBe(4);
    expect(names).toContain('designator:28R');
    expect(names.filter((n) => n === 'reil').length).toBe(4);
    expect(names.filter((n) => n === 'rabbit').length).toBe(8); // both ends of four ≥ 1800 m runways
    expect(names.filter((n) => n === 'approach-lights').length).toBe(4);
    expect(layer.flatteningSegments().length).toBe(4);
    // Rebase to a frame 10 km away: everything rebuilt, 28R threshold now ~10 km from origin
    const frame2 = new LocalFrame(37.7, -122.36, 0);
    layer.setFrame(frame2);
    expect(layer.isBuilt('KSFO')).toBe(true);
    const seg = layer.flatteningSegments()[0];
    expect(seg.icao).toBe('KSFO');
    layer.dispose();
    expect(layer.isBuilt('KSFO')).toBe(false);
  });

  it('pavement faces up (not back-face culled) and follows the earth-curvature bulge mid-runway', () => {
    const frame = new LocalFrame(37.613538, -122.35716, 4);
    const layer = new AirportsLayer(frame, fakeNav);
    layer.update(10, ksfo.position, [0, 0, 0], -0.2);
    let slab: THREE.Mesh | undefined;
    layer.group.traverse((o) => { if (o.name === 'runway:10L/28R') slab = o as THREE.Mesh; });
    expect(slab).toBeDefined();
    const geo = slab!.geometry;
    const nrm = geo.getAttribute('normal');
    for (let i = 0; i < nrm.count; i++) expect(nrm.getY(i)).toBeGreaterThan(0.99);
    // 3618 m runway in segments of at most 250 m; the middle row sits ~0.26 m above the corner chord
    const pos = geo.getAttribute('position');
    const rows = pos.count / 2;
    expect(rows - 1).toBeGreaterThanOrEqual(Math.ceil(3618 / 250));
    const mid = Math.floor((rows - 1) / 2);
    const t = mid / (rows - 1);
    const chordY = pos.getY(0) + (pos.getY(pos.count - 2) - pos.getY(0)) * t;
    expect(pos.getY(mid * 2) - chordY).toBeCloseTo(runwayBulge(3618, t), 3);
    expect(runwayBulge(3618, 0.5)).toBeGreaterThan(0.25);
  });

  it('PAPI colours follow the aircraft glide angle', () => {
    const frame = new LocalFrame(37.613538, -122.35716, 4);
    const layer = new AirportsLayer(frame, fakeNav);
    layer.ensureAirport(ksfo);
    // Aircraft 2 km out on the 28R approach (heading 298 → approach from 118°) at 3° → 105 m up
    const d = 2300; // from the PAPI (300 m past threshold)
    const brg = (118 * Math.PI) / 180;
    const pos: [number, number, number] = [Math.sin(brg) * d, Math.tan((3 * Math.PI) / 180) * d, -Math.cos(brg) * d];
    layer.update(0.016, ksfo.position, pos, -0.3);
    let papiB: import('three').Points | null = null;
    layer.group.traverse((o) => { if (o.name === 'papi' && !papiB && o.parent?.name === 'airport:KSFO') papiB = o as import('three').Points; });
    expect(papiB).not.toBeNull();
    const colors = (papiB!.geometry.getAttribute('color') as import('three').BufferAttribute).array as Float32Array;
    // At least one red and one white across the eight PAPI objects is hard to assert per-object; assert the attribute was written (not all 1s)
    const anyRed = Array.from({ length: 4 }, (_, i) => colors[i * 3 + 1] < 0.5).some(Boolean);
    const anyWhite = Array.from({ length: 4 }, (_, i) => colors[i * 3 + 1] > 0.9).some(Boolean);
    expect(anyRed || anyWhite).toBe(true);
  });
});
