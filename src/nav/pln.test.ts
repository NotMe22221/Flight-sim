import { describe, expect, it } from 'vitest';
import type { Waypoint } from '../core/types';
import { formatDms, parseDms, parsePln, parseWorldPosition, toPln } from './pln';

/** A plan as Little Navmap / MSFS write it (abridged). */
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<SimBase.Document Type="AceXML" version="1,0">
    <Descr>AceXML Document</Descr>
    <FlightPlan.FlightPlan>
        <Title>KSFO to KHAF</Title>
        <FPType>VFR</FPType>
        <CruisingAlt>3500</CruisingAlt>
        <DepartureID>KSFO</DepartureID>
        <ATCWaypoint id="KSFO">
            <ATCWaypointType>Airport</ATCWaypointType>
            <WorldPosition>N37° 37' 8.00",W122° 22' 30.00",+000013.00</WorldPosition>
            <ICAO><ICAOIdent>KSFO</ICAOIdent></ICAO>
        </ATCWaypoint>
        <ATCWaypoint id="SFO">
            <ATCWaypointType>VOR</ATCWaypointType>
            <WorldPosition>N37° 37' 9.49",W122° 22' 26.49",+003500.00</WorldPosition>
            <ICAO><ICAORegion>K2</ICAORegion><ICAOIdent>SFO</ICAOIdent></ICAO>
        </ATCWaypoint>
        <ATCWaypoint id="WPT1">
            <ATCWaypointType>User</ATCWaypointType>
            <WorldPosition>S0° 30' 0.00",E10° 0' 0.00",+002000.00</WorldPosition>
        </ATCWaypoint>
        <ATCWaypoint id="KHAF">
            <ATCWaypointType>Airport</ATCWaypointType>
            <WorldPosition>N37° 30' 49.00",W122° 30' 4.00",+000066.00</WorldPosition>
            <ICAO><ICAOIdent>KHAF</ICAOIdent></ICAO>
        </ATCWaypoint>
    </FlightPlan.FlightPlan>
</SimBase.Document>`;

describe('pln', () => {
  it('parses degrees-minutes-seconds and world positions', () => {
    expect(parseDms(`N37° 37' 8.00"`)).toBeCloseTo(37 + 37 / 60 + 8 / 3600, 8);
    expect(parseDms(`W122° 22' 30.00"`)).toBeCloseTo(-(122 + 22 / 60 + 30 / 3600), 8);
    expect(parseDms('S0 30 0')).toBeCloseTo(-0.5, 8);
    const p = parseWorldPosition(`N37° 37' 8.00",W122° 22' 30.00",+000013.00`)!;
    expect(p.altM).toBeCloseTo(13 * 0.3048, 6);
    expect(parseWorldPosition('garbage')).toBeNull();
  });

  it('imports waypoints with types, positions and en-route altitudes', () => {
    const plan = parsePln(SAMPLE);
    expect(plan.title).toBe('KSFO to KHAF');
    expect(plan.cruiseAltM).toBeCloseTo(3500 * 0.3048, 3);
    expect(plan.waypoints.map((w) => [w.id, w.type])).toEqual([['KSFO', 'airport'], ['SFO', 'navaid'], ['WPT1', 'user'], ['KHAF', 'airport']]);
    expect(plan.waypoints[1].altConstraintM).toBeCloseTo(3500 * 0.3048, 3);
    expect(plan.waypoints[0].altConstraintM).toBeUndefined();
    expect(plan.waypoints[2].position.lat).toBeCloseTo(-0.5, 8);
    expect(plan.waypoints[2].position.lon).toBeCloseTo(10, 8);
    expect(() => parsePln('<xml/>')).toThrow();
  });

  it('exports a plan that imports back the same', () => {
    const wps: Waypoint[] = [
      { id: 'KSFO', type: 'airport', position: { lat: 37.6188, lon: -122.375, alt: 4 } },
      { id: 'A&B', type: 'user', position: { lat: 37.7, lon: -122.2, alt: 0 }, altConstraintM: 1066.8 },
      { id: 'KOAK', type: 'airport', position: { lat: 37.7213, lon: -122.2208, alt: 3 } },
    ];
    const back = parsePln(toPln(wps, { cruiseAltM: 1066.8 }));
    expect(back.title).toBe('KSFO to KOAK');
    expect(back.waypoints.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(back.waypoints[i].id).toBe(wps[i].id);
      expect(back.waypoints[i].type).toBe(wps[i].type);
      expect(back.waypoints[i].position.lat).toBeCloseTo(wps[i].position.lat, 5);
      expect(back.waypoints[i].position.lon).toBeCloseTo(wps[i].position.lon, 5);
    }
    expect(back.waypoints[1].altConstraintM).toBeCloseTo(1066.8, 1);
    expect(parsePln(toPln(wps)).cruiseAltM).toBeCloseTo(1066.8, 0); // highest en-route altitude
    expect(parsePln(toPln([wps[0], wps[2]])).cruiseAltM).toBeCloseTo(3500 * 0.3048, 0);
    expect(formatDms(59.99999999, true)).toBe(`N60° 0' 0.00"`);
  });
});
