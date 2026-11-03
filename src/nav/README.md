# src/nav — navigation

Airport/navaid database, VOR / ILS / DME / GPS radio geometry, flight-plan sequencing and
radio-frequency helpers. Pure TypeScript, no Three.js, runs in Node (all tests use the real
data under `public/data`). Magnetic variation lives next door in `src/geo/magvar.ts` and is
owned by this module.

## Files

| File | What it does |
|---|---|
| `navTypes.ts` | Widened contract types: `AirportRecord`, `RunwayRecord` (+ `ends`), `RunwayEnd`, `IlsInfo` (+ `synthetic`), `NavaidRecord`, `NavRadioStateEx`, `FlightPlanEx`, `NavDataLoader` |
| `loaders.ts` | `fetchLoader(base)` for the browser, `memoizeLoader` (one fetch per path) |
| `airportsData.ts` | Decoders for the compact JSON (`decodeAirport`, `decodeRunway`, `decodeNavaid`), `runwayEnds`, `runwayForEnd`, `findRunwayEnd`, `runwayEndHeadingMag`, `reciprocalIdent`, surface mapping |
| `ils.ts` | Synthetic ILS assignment (`synthesizeIls`) and receiver geometry (`buildIlsGeometry`, `landingThreshold`) |
| `spatialGrid.ts` | 1° grid index with nearest-N queries (`SpatialGrid`) |
| `NavDatabase.ts` | `NavDb implements NavDatabase`: loading, shards, nearest/search/frequency lookups, `runwayInUse`, `ilsGeometry` |
| `radio.ts` | Pure geometry: VOR radial/CDI/TO-FROM, DME slant range, line-of-sight range, localizer / glideslope / markers, GPS leg maths, `computeNavRadio` → `NavRadioState` |
| `flightPlan.ts` | `FlightPlanner`: waypoints, direct-to, fly-by sequencing, `FlightPlan` per update |
| `frequencies.ts` | NAV/COM band rules, 25 / 8.33 kHz stepping with wrap, formatting, swap |
| `index.ts` | Barrel (also re-exports the magvar entry points) |
| `../geo/magvar.ts` | WMM2025: `magneticDeclinationDeg`, `magneticField`, `MagVarCache` |

## API in one page

```ts
import { NavDb, fetchLoader, computeNavRadio, FlightPlanner, MagVarCache, stepNav, formatNav } from './nav';

// Database — fetches `${base}data/airports.json`, `navaids.json`, `index.json` once,
// then small-airport shards around a region, never twice.
const db = new NavDb(fetchLoader(import.meta.env.BASE_URL));
await db.loadRegion({ lat: 37.62, lon: -122.37, alt: 0 }, 150);
const ksfo = db.getAirport('KSFO');                     // AirportRecord (4 runways, each with .ends)
db.nearestAirports(pos, 10, 50);                       // nearest first, within 50 nm
db.searchAirports('innsbruck');                        // LOWI first (ICAO/IATA exact > prefix > name/municipality)
db.findNavaidByFrequency(116_800, pos);                // OAK VORTAC (nearest in range on that kHz)
const hit = db.findIlsByFrequency(khz, pos);           // { airport, runway } oriented to the served end
const ils = db.findIlsEntry(khz, pos)?.geometry;       // IlsGeometry for the receiver model
db.runwayInUse(ksfo, 290);                             // RunwayEnd 28R (most headwind, longest wins ties)

// Radios — allocation-free when you pass `out`
const magvar = new MagVarCache();                      // recompute when moved > 5 km or every 60 s
const decl = magvar.get(ac.lat, ac.lon, ac.alt, utcMs);
const nav1 = computeNavRadio(ac.geo, decl, station /* Navaid | IlsGeometry | undefined */, { activeKHz, standbyKHz, obsDeg }, out);

// GPS flight plan
const fp = new FlightPlanner([wp1, wp2, wp3]);
fp.directTo(2, ac.geo);
const plan = fp.update(ac.geo, ac.groundSpeedMs);     // FlightPlanEx (same object each call)

// Frequencies (integers in kHz)
stepNav(117_950, +1);   // 108_000 (wraps); stepNav(k, +1, true) turns the MHz knob
stepCom(118_015, +1, false, 8.33); // 118_025
formatNav(108_100);     // '108.10'   formatCom(118_005, 8.33) → '118.005'
```

## How it works

### Data decoding
`scripts/build-airports.mjs` bakes OurAirports into compact JSON (formats in its header).
`decodeAirport` keeps **one `RunwayRecord` per physical runway**, oriented to the low-numbered
(`le`) end to satisfy the `Runway` contract, and exposes **both landing directions** in
`ends: [RunwayEnd, RunwayEnd]` (`runwayEnds(rw)` also works on plain contract `Runway`s).
`runwayForEnd(rw, 1)` returns a `Runway` view oriented to the other end (that is what
`findIlsByFrequency` returns, so `runway.ident === '28R'`). End elevations of 0/missing fall
back to the field elevation; missing headings fall back to the geometric bearing to the far end.
`RunwayEnd.threshold` is the pavement end as recorded; `landingThreshold(end)` applies the
displaced distance. `runwayEndHeadingMag(end, utcMs)` = true heading − WMM declination.

Navaids keep their station elevation in `position.alt`; `magneticVariationDeg` is the
OurAirports **slaved variation** (the declination the VOR rose is aligned to), which is what
the radial computation must use. `NDB-DME` is folded into type `'NDB'` with `hasDme: true`.
`rangeNm` is a per-type default (VOR/VOR-DME/DME 40, VORTAC/TACAN 130, NDB 50) because the
compact data has no power class yet.

### Synthetic ILS
OurAirports has no ILS rows, so every paved runway end ≥ 1500 m at a large/medium airport gets
one: frequency = FNV-1a(`icao:ident`) mod 40 localizer channels (odd tenths 108.10–111.95),
probed forward so no two ends at one airport collide; ident `I` + last three ICAO letters;
3.0° glideslope; course = runway true heading; `synthetic: true`. The physical runway's
contract field `ils` carries the `le` end's ILS; the `he` end's is on `ends[1].ils`.

`buildIlsGeometry` places the localizer antenna 300 m beyond the stop end on the course line
through the landing threshold, the glideslope antenna 300 m in from the threshold and 120 m
right (the vertical geometry is referenced to the centreline point abeam it), and markers at
7.2 km / 1.05 km / 300 m. Full-scale localizer deviation = atan(106.7 m / antenna→threshold),
i.e. ±350 ft at the threshold (3.12° total width at KSFO 28R), clamped to a 3°–6° total width.

### Spatial index and lookups
`SpatialGrid` buckets items by 1°×1° cell. `nearest` scans rows outward from the query cell
across the longitude span the radius can reach and stops as soon as the N-th best distance is
inside the rows already scanned, so a 30 nm query touches ~9 cells whatever the dataset size.
Frequency lookups use `Map<kHz, records[]>` and pick the nearest in range (published range
for navaids, 40 nm for ILS). `loadRegion` computes the 10° shard ids intersecting the circle,
loads the ones listed in `index.json`, and memoises every path (`NavDb.loaderCalls` counts).

### Radio geometry (`radio.ts`)
Sign conventions, shared with the autopilot: **`cdi` +1 = fly right**, **`gsDeviation` +1 =
fly up**, **cross-track +m = right of course**.

* **VOR** — radial = true bearing station→aircraft − station declination. With
  `d = Δ(OBS − radial)`: FROM when |d| ≤ 90 and deviation = d; TO otherwise and deviation =
  Δ(180 − d). Full scale ±10°. Example: outbound on 360 and 5° right of course (radial 005)
  → `cdi = −0.5` (fly left); inbound on 180 from the north and 5° right (radial 355) →
  `cdi = −0.5` too. Within 1 nm of the station the CDI flags `'off'` (cone of confusion) while
  DME keeps reading. Validity: distance ≤ min(1.23·(√h_ac ft + √h_station ft) nm, `rangeNm`).
  NDBs use range only.
* **DME** — slant range from 3-D positions; for an ILS it reads to the landing threshold.
* **ILS** — localizer: angle between the course line from the antenna and the aircraft, scaled
  by the full-scale angle; the needle depends only on the geographic side of the front course,
  so the back course has reverse sensing (`backCourse: true`, no glideslope). Usable 18 nm within
  ±10°, 10 nm within ±35°. Glideslope: elevation angle from the GS reference point, full scale
  ±0.7°, valid within 10 nm, ±8° of course, front side only. Marker beacons report when within
  ±300 m along track and ±300 m laterally of the beacon.
* **GPS** — `legGeometry(A, B, P)` gives cross-track, along-track, remaining distance, desired
  track at the abeam point and direct bearing/distance (standard spherical formulas on
  R = 6 371 km). `turnRadiusM(V, φ) = V²/(g·tan φ)` with φ = 25°,
  `turnAnticipationM = r·tan(Δ/2)`, capped at r for turns beyond 90°.

### Flight plan
`activeLeg` is the index of the active (TO) waypoint; the FROM point is the previous waypoint
or the position where direct-to was pressed. The next leg becomes active when the remaining
along-track distance drops below the turn-anticipation distance (and the aircraft is actually
near the waypoint, not merely abeam from far off-track), or when the waypoint is passed. The
last waypoint is never sequenced past; `complete` turns true once it is behind. `eteS` is to
the active waypoint; `eteTotalS`, `totalDistanceM`, `remainingDistanceM` cover the route.

### Magnetic variation (`src/geo/magvar.ts`)
Full WMM2025 spherical-harmonic evaluation (degree 12, Schmidt semi-normalised Legendre
recursion, secular variation to the decimal year, geodetic→geocentric conversion and back).
≈ 1.7 µs per evaluation measured in Node 22 (budget was 50 µs). `MagVarCache` caches by position/time.

## Tests (`npx vitest run src/nav src/geo`)
* `magvar.test.ts` — all 20 official WMM2025 test values (D within 0.05°, F within 10 nT, and
  X/Y/Z/H/I), KSFO ≈ 13° E and Innsbruck ≈ 4° E for 2026, timing < 50 µs, cache behaviour.
* `airportsData.test.ts` — KSFO → 4 runways, 28R threshold/length/heading, `runwayForEnd`,
  LOWI 08/26, KHAF from a small shard, elevation/heading fallbacks, synthetic ILS in band,
  unique per airport and deterministic, ILS geometry distances, magnetic runway heading,
  navaid decoding, surface codes, reciprocal idents.
* `NavDatabase.test.ts` — empty before load, `getAirport`, `nearestAirports` (KSFO first, KOAK /
  KSQL / KHAF included, sorted, bounded), `nearestNavaids`, `searchAirports` ranking,
  `findNavaidByFrequency(116800)` → OAK, `findIlsByFrequency` → 28R, `runwayInUse` for winds
  290 / 100 / 20 / 200, shard loading with loader-call counting and no re-fetch, shard cells
  across the equator and the dateline.
* `radio.test.ts` — the VOR sign-convention cases above, full scale/clamping, TO/FROM flip,
  cone of confusion, range/line of sight, DME/NDB behaviour; ILS centred on the 3° path,
  100 ft high at 2 nm → −0.67, ±350 ft at the threshold → ∓1, back course, markers, range
  lobes; GPS cross-/along-track signs, turn radius and anticipation.
* `flightPlan.test.ts` — KSFO→KHAF→LOWI distances and ETE, cross-track sign, sequencing by
  anticipation and by passing abeam, no early sequencing when far off-track, last waypoint,
  direct-to, add/insert/remove/clear.
* `frequencies.test.ts` — band classification, NAV/COM stepping with wrap for both spacings and
  both knobs, formatting (`'118.005'`), snapping, parsing, swap.

## Known limitations
* ILS data is synthetic (frequencies/idents are not the real ones) — swap in FAA NASR / real
  data when available; `synthetic: false` records flow through the same code.
* The contract's `Runway.ils` can hold only one ILS, so the high-numbered end's lives on
  `ends[1].ils`; code that only reads the contract field misses it (see proposed changes).
* Navaid ranges are per-type defaults, not the published service volume; the build script
  does not bake OurAirports' `power` column.
* VOR/ILS signal quality is binary (valid / flagged); no needle wobble, no false glideslopes,
  no terrain masking beyond the smooth-earth radio horizon.
* The glideslope uses the centreline reference point, so the lateral antenna offset only
  matters for scenery placement.
* Great-circle maths is spherical (R = 6371 km); fine for displays and the CDI, not for survey
  work. `desiredTrackDeg` is the abeam-point course to first order in the cross-track offset.
* `NavDb` keeps everything in memory (~5k large/medium airports, 11k navaids, plus loaded
  shards) and never evicts shards.
* `searchAirports` is a linear scan over loaded airports (≈ 1 ms for 11k records); fine for
  typing in a search box, but not for per-frame use.
