# src/geo — geodesy, tiles, sun/moon and magnetic variation

Pure TypeScript, no Three.js, everything runs in Node. SI units (metres, radians unless a name
says `Deg`). Frames follow docs/DESIGN.md: physics **NED** at a floating origin, render frame
**x = East, y = Up, z = South** (`(x3, y3, z3) = (E, −D, −N)`).

| File | What it does |
|---|---|
| `wgs84.ts` | WGS84 ellipsoid: geodetic ↔ ECEF, `LocalFrame` (NED and Three.js coordinates from one rotation, rebase rotation), NED ↔ Three.js vector permutation, spherical great-circle helpers, horizon distance/dip |
| `mercator.ts` | Web-Mercator (EPSG:3857) slippy-tile maths: lon/lat ↔ fractional tile, tile bounds, metres per pixel, wrap/clamp |
| `solar.ts` | Sun position (NOAA / Meeus, ≈ 0.01°), moon position and phase (suncalc-style, ≈ 1°), `dirFromAzEl` → render-frame unit vector, `sunEvents` |
| `magvar.ts` | World Magnetic Model 2025: declination/inclination/field vector, `MagVarCache` |
| `__fixtures__/` | `wmm2025.json` (NOAA coefficients, public domain) and the 20 official WMM2025 test values |

## API

```ts
import { LocalFrame, geodeticToEcef, ecefToGeodetic, nedToThree, greatCircleDistance, initialBearingDeg, destinationPoint } from './wgs84';
const f = new LocalFrame(37.613538, -122.35716, 4);       // floating origin
f.geodeticToNED(lat, lon, alt, out);                       // exact, includes curvature; out = [N, E, D]
f.nedToGeodetic(n, e, d, outGeo);                          // allocation-free with `out` (used per physics step)
f.geodeticToThree(lat, lon, alt, out); f.threeToGeodetic(x, y, z, outGeo);
f.rotationNEDTo(newFrame);                                 // row-major 3×3 for rebasing
greatCircleDistance(a, b); initialBearingDeg(a, b); destinationPoint(a, brgDeg, distM); // sphere R = 6 371 km

import { lonLatToTile, tileToLonLat, tileBounds, metersPerPixel } from './mercator';
import { sunPosition, moonPosition, dirFromAzEl, sunEvents } from './solar';
const s = sunPosition(utcMs, lat, lon);   // { elevation, apparentElevation, azimuth (deg, clockwise from TRUE NORTH), declination, eotMin }
dirFromAzEl(s.azimuth, s.apparentElevation, out); // unit vector in the Three.js frame: east → +x, up → +y, south → +z

import { magneticDeclinationDeg, magneticField, MagVarCache, decimalYear } from './magvar';
magneticDeclinationDeg(lat, lon, altM, utcMs);   // deg, EAST positive: true heading = magnetic heading + declination
magneticField(lat, lon, altM, utcMs, out);       // { X north, Y east, Z down (nT), H, F, I (dip, + down), D, year, inValidityWindow }
const cache = new MagVarCache(5000, 60_000);     // re-evaluates after 5 km or 60 s of sim time
```

## How it works

* **WGS84** — standard closed-form geodetic → ECEF; ECEF → geodetic by Bowring-style iteration
  (< 1e-9 rad in ≤ 5 iterations, special-cased on the polar axis). `LocalFrame` stores the ECEF
  origin and the E/N/U unit vectors; NED = (n, e, −u), Three.js = (e, −d, −n). The great-circle
  helpers are spherical (R = 6 371 000 m) and are what the nav module uses.
* **Mercator** — the usual slippy-map formulas; latitude clamped to ±85.0511°.
* **Sun** — NOAA solar calculator (Meeus ch. 25): geometric mean longitude/anomaly, equation of
  centre, apparent longitude, obliquity, equation of time, true solar time → hour angle →
  zenith/azimuth; azimuth is measured clockwise from true north. Refraction per NOAA for the
  apparent elevation. Moon: truncated Meeus ch. 47 as in suncalc (azimuth converted from the
  south-based convention), phase/illumination from the sun–moon elongation.
* **Magnetic variation (WMM2025)** — NOAA/NCEI algorithm: geodetic → geocentric spherical
  (`geodeticToGeocentric`, a = 6378.137 km, b = 6356.7523142 km), Gauss coefficients propagated
  with the linear secular variation g(t) = g₀ + (t − 2025.0)·ġ, Schmidt semi-normalised
  associated Legendre functions by the `PcupLow` recursion (`schmidtLegendre` exposes them),
  spherical-harmonic summation to degree/order 12 with reference radius 6371.2 km, rotation
  back to geodetic north/east/down by ψ = φ′ − φ, D = atan2(Y, X). About 2 µs per evaluation,
  allocation-free (module scratch buffers; the computation is synchronous). At the geographic
  poles the 1/cos φ′ singularity is clamped instead of using the WMM special series: values stay
  finite but D there is arbitrary (it is undefined anyway).

## Tests (`npx vitest run src/geo`)
* `magvar.test.ts` — all 20 official WMM2025 test values: X/Y/Z/H/F to 0.01 nT (actual error
  < 0.001 nT) and D/I to the published 0.01° rounding; secular variation (the 2025.5 rows miss
  by > 5 nT without it; field exactly linear in time; KSFO drifts ≈ −0.09°/yr); Schmidt
  functions vs closed forms, their normalisation ∫P̄ₙᵐ² dx = 2(2 − δₘ₀)/(2n + 1) for all n, m ≤ 12
  and the latitude derivative; geocentric conversion vs the ECEF transform; finite at the poles;
  the spec's 2026-11-02 declinations (KSFO 12.79° E … YSSY 12.85° E) to 0.02°; timing; cache.
  Mutating the Schmidt factor, dropping the geocentric rotation or flipping the secular term
  each fails the suite.
* `wgs84.test.ts` — round trips, ECEF axes, local-frame round trip within 500 km, curvature drop
  (≈ 785 m at 100 km), N/E/U directions, NED ↔ Three.js permutation, rebase rotation, great
  circle KSFO → LOWI, horizon distance.
* `mercator.test.ts` — KSFO tile/pixel at z15, metres per pixel, round trip, world tile, wrap.
* `solar.test.ts` — London solstice noon, KSFO equinox noon and sunrise azimuth, night,
  refraction, render-frame direction convention, full/new moon, sun events (SF times, and the
  geometric −0.833° definition at three sites — the first version used the apparent elevation
  and double-counted refraction).

## Tuning knobs
* `MagVarCache(maxDistanceM = 5000, maxAgeMs = 60 000)` — declination changes < 0.05° per 5 km.
* `EARTH_RADIUS` (wgs84.ts) = 6 371 000 m for all spherical helpers (the nav spec quotes
  6 371 008.8 m; the 1.4 ppm difference is below display resolution).

## Known limitations
* The WMM is valid 2025.0–2030.0; outside that window values are extrapolated and
  `inValidityWindow` is false. Decimal years use the exact UTC instant (NOAA tools use the day
  of year); the difference is < 0.003 yr.
* Heights are treated as ellipsoidal everywhere (no geoid); DEM heights are ~MSL.
* Great-circle helpers are spherical, not Vincenty; error < 0.5 % in distance, < 0.2° in
  bearing over nav distances.
* `ecefToGeodetic` loses precision within millimetres of the polar axis (`p / cos φ`), which is
  irrelevant for flight.
* `sunEvents` scans in 10-minute steps (bisection refines rise/set to < 1 s; solar noon is the
  best 10-minute sample) and returns NaN for polar day/night.
