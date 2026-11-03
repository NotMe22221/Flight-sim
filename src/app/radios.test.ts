import { describe, expect, it } from 'vitest';
import type { Geodetic } from '../core/types';
import { countingLoader } from '../nav/__tests__/fsLoader';
import { findRunwayEnd } from '../nav/airportsData';
import { NavDb } from '../nav/NavDatabase';
import { RadioStack } from './radios';

const KSFO: Geodetic = { lat: 37.619806, lon: -122.374821, alt: 4 };
/** 8 nm east-southeast of KSFO on the extended centreline of 28R, 2500 ft */
const FINAL: Geodetic = { lat: 37.57, lon: -122.22, alt: 760 };

describe('RadioStack auto-course', () => {
  it('sets NAV1 OBS to the localizer front course (magnetic) when an ILS is tuned, once', async () => {
    const db = new NavDb(countingLoader());
    await db.loadRegion(KSFO, 30);
    const end28R = findRunwayEnd(db.getAirport('KSFO')!, '28R')!.end;
    const khz = end28R.ils!.frequencyKHz;
    const radios = new RadioStack(db);
    radios.tuneNav(0, khz);
    const magVar = 12.8;
    radios.update(0.016, FINAL, magVar);
    const course = db.findIlsEntry(khz, FINAL)!.geometry.courseDeg;
    expect(radios.tuning[0].obsDeg).toBe(Math.round((((course - magVar) % 360) + 360) % 360));
    expect(radios.tuning[0].obsDeg).toBeGreaterThan(280);
    expect(radios.tuning[0].obsDeg).toBeLessThan(290);
    // the pilot can still turn the course afterwards: re-lookups of the same ILS leave it alone
    radios.handleAction('obs1Inc');
    const set = radios.tuning[0].obsDeg;
    for (let i = 0; i < 5; i++) radios.update(0.6, FINAL, magVar);
    expect(radios.tuning[0].obsDeg).toBe(set);
  });

  it('leaves the OBS alone for a VOR', async () => {
    const db = new NavDb(countingLoader());
    await db.loadRegion(KSFO, 30);
    const radios = new RadioStack(db);
    radios.tuning[0].obsDeg = 123;
    radios.tuneNav(0, 116_800); // OAK VORTAC
    radios.update(0.016, KSFO, 12.8);
    expect(radios.tuning[0].obsDeg).toBe(123);
  });
});
