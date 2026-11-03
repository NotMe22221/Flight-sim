# src/nav — navigation

Airport/navaid database, VOR / ILS / DME / GPS radio geometry, flight-plan sequencing and
radio-frequency helpers. Pure TypeScript, no Three.js, runs in Node (the tests use the real
data under `public/data`). Magnetic variation lives next door in `src/geo/magvar.ts` (see
`src/geo/README.md`) and is re-exported from the barrel. Spec: docs/research/05 §4.

## Files

| File | What it does |
|---|---|
| `navTypes.ts` | Widened contract types: `AirportRecord`, `RunwayRecord` (+ `ends`), `RunwayEnd`, `IlsInfo` (+ `synthetic`), `NavaidRecord`, `NavRadioStateEx` (+ `backCourse`, `marker`, `distanceM`, `dmeValid`), `FlightPlanEx`, `NavDataLoader` |
| `loaders.ts` | `fetchLoader(base)` for the browser, `memoizeLoader` (one fetch per path) |
| `airportsData.ts` | Decoders for the compact JSON (`decodeAirport`, `decodeRunway`, `decodeNavaid`), `runwayEnds`, `runwayForEnd`, `findRunwayEnd`, `runwayEndHeadingMag`, `reciprocalIdent`, surface mapping |
| `ils.ts` | Synthetic ILS assignment (`synthesizeIls`) and receiver geometry (`buildIlsGeometry`, `landingThreshold`) |
| `spatialGrid.ts` | 1° grid index with nearest-N queries (`SpatialGrid`), `capLonHalfWidthDeg` |
| `NavDatabase.ts` | `NavDb implements NavDatabase`: loading, shards, nearest/search/frequency lookups, `runwayInUse`, `ilsGeometry`, `shardCellsAround` |
| `radio.ts` | Pure geometry: VOR radial/CDI/TO-FROM, cone of confusion, DME slant range and availability, line-of-sight range, localizer / glideslope / markers, GPS leg maths, `computeNavRadio` → `NavRadioState` |
| `flightPlan.ts` | `FlightPlanner`: waypoints, direct-to, fly-by sequencing, `FlightPlan` per update |
| `frequencies.ts` | NAV/COM band rules, 25 / 8.33 kHz stepping with wrap, formatting, swap |
| `index.ts` | Barrel (also re-exports `MagVarCache`, `magneticDeclinationDeg`, `magneticField`, `decimalYear`) |

## API in one page

```ts
import { NavDb, fetchLoader, computeNavRadio, FlightPlanner, MagVarCache, stepNav, formatNav } from './nav';

// Database — fetches `${base}data/airports.json`, `navaids.json`, `index.json` once,
// then small-airport shards around a region, never twice.
const db = new NavDb(fetchLoader(import.meta.env.BASE_URL));
await db.loadRegion({ lat: 37.62, lon: -122.37, alt: 0 }, 150);
const ksfo = db.getAirport('KSFO');                     // AirportRecord (4 runways, each with .ends)
db.nearestAirports(pos, 10, 50);                       // nearest first, within 50 nm (exact, = brute force)
db.nearestNavaids(pos, 5, 130);
db.searchAirports('innsbruck');                        // LOWI first (ICAO/IATA exact > prefix > name/municipality)
db.findNavaidByFrequency(116_800, pos);                // OAK VORTAC (nearest in its published range on that kHz)
const hit = db.findIlsByFrequency(khz, pos);           // { airport, runway } oriented to the served end
const ils = db.findIlsEntry(khz, pos)?.geometry;       // IlsGeometry for the receiver model (no allocation)
db.runwayInUse(ksfo, 290);                             // RunwayEnd 28R: wind FROM 290° true

// Radios — allocation-free when you pass `out` (call every frame)
const magvar = new MagVarCache();                      // recompute when moved > 5 km or every 60 s
const decl = magvar.get(ac.lat, ac.lon, ac.alt, utcMs); // deg, EAST positive: true = magnetic + decl
const nav1 = computeNavRadio(ac.geo, decl, station /* Navaid | IlsGeometry | undefined */, { activeKHz, standbyKHz, obsDeg }, out);
nav1.cdi;        // −1..1, +1 = FLY RIGHT          nav1.gsDeviation // −1..1, +1 = FLY UP
nav1.toFrom;     // 'to' | 'from' | 'off'          nav1.dmeNm + nav1.dmeValid (plain VOR/NDB: no DME)

// GPS flight plan (all true degrees)
const fp = new FlightPlanner([wp1, wp2, wp3]);
fp.directTo(2, ac.geo);
const plan = fp.update(ac.geo, ac.groundSpeedMs);     // FlightPlanEx (same object each call); crossTrackM + = right of course

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

Navaids keep their station elevation in `position.alt`; `magneticVariationDeg` (east positive)
is the OurAirports **slaved variation** — the declination the VOR rose is aligned to — which is
what the radial computation must use (the build script falls back to the row's
`magnetic_variation_deg` when no slaved value exists; see limitations). `NDB-DME` is folded into
type `'NDB'` with `hasDme: true`. `rangeNm` is a per-type default (VOR/VOR-DME/DME 40,
VORTAC/TACAN 130, NDB 50) because the compact data has no power class yet.

### Synthetic ILS
OurAirports has no ILS rows, so every paved runway end ≥ 4 000 ft at a large/medium airport
gets one: frequency = FNV-1a(`icao:ident`) mod 40 localizer channels (odd tenths 108.10–111.95),
probed forward so no two ends at one airport collide; ident `I` + last three ICAO letters;
3.0° glideslope; course = runway true heading; `synthetic: true`. The physical runway's
contract field `ils` carries the `le` end's ILS; the `he` end's is on `ends[1].ils`.

`buildIlsGeometry` places the localizer antenna 300 m (≈ 1 000 ft) beyond the stop end on the
course line through the landing threshold, the glideslope antenna 300 m in from the threshold
and 120 m right (the vertical geometry is referenced to the centreline point abeam it, giving a
52 ft threshold crossing height), and markers at 4 nm / 1 050 m / 300 m. Full-scale localizer
deviation = atan(350 ft / threshold→antenna distance), i.e. ±350 ft at the landing threshold
(3.19° total at KSFO 28R, whose threshold is displaced 91 m; KTRK 11 ≈ 5.0°, LOWI 26 ≈ 5.3°),
clamped to a 3°–6° total width.

### Spatial index and lookups
`SpatialGrid` buckets items by 1°×1° cell. `nearest` scans rows outward from the query cell.
Its column range is the **exact** longitude half-width of the spherical search cap,
`asin(sin δ / cos φ)` (+1 cell for flooring); when the cap contains a pole or the band would
wrap, every one of the 360 columns is scanned once (scanning ±180 would visit the antipodal
column twice). It stops as soon as the N-th best distance is ≤ k·(πR/180) after rows ±k —
every unscanned point is more than k degrees of latitude away. Results equal a brute-force scan
(property-tested at cell corners, the antimeridian and both poles); 1 000 queries take ≈ 15 ms.
Frequency lookups use `Map<kHz, records[]>` and pick the nearest in range (published range for
navaids, 40 nm for ILS). `loadRegion` computes the 10° shard ids intersecting the circle with the
same exact cap bound (all longitudes when it holds a pole), loads the ones listed in
`index.json`, and memoises every path (`NavDb.loaderCalls` counts).

### Radio geometry (`radio.ts`)
Sign conventions, shared with the autopilot: **`cdi` +1 = fly right**, **`gsDeviation` +1 =
fly up**, **cross-track +m = right of course**. Radials/bearings in `NavRadioState` are magnetic;
everything in the flight plan and `IlsGeometry` is true.

* **VOR** — radial = true bearing station→aircraft − *station* declination; `bearingDeg` (to the
  station) uses the *local* declination passed in. With `d = Δ(OBS − radial)`: FROM when
  |d| ≤ 90 and deviation = d; TO otherwise and deviation = Δ(180 − d), so the needle stays on the
  same side across the 90° flag flip. Full scale ±10°. Example: outbound on 360 and 5° right of
  course (radial 005) → `cdi = −0.5` (fly left); inbound on 180 from the north and 5° right
  (radial 355) → `cdi = −0.5` too. Spec worked example: SFO VOR → (37.74, −122.22) is radial
  032 (13.1° E), 10.3 nm, centred with OBS 032 FROM / 212 TO. Cone of confusion: within
  max(300 m, h·tan 50°) of the station (h = height above it) the flag shows `'off'` while DME
  keeps reading. Validity: distance ≤ min(1.23·(√h_ac ft + √h_station ft) nm, `rangeNm`); NDBs
  use range only. Note the spec's pseudo-code negates the deviation twice; the implemented sign
  is the geometric one (verified against positions, not against that pseudo-code).
* **DME** — slant range from 3-D positions; for an ILS it reads to the landing threshold.
  `dmeValid` is true only for DME-equipped stations in range (VOR-DME, VORTAC, DME, TACAN,
  NDB-DME, and ILS).
* **ILS** — localizer: angle between the course line from the antenna and the aircraft, scaled
  by the full-scale angle; the needle depends only on the geographic side of the front course,
  so the back course has reverse sensing (`backCourse: true`, no glideslope). Usable 18 nm within
  ±10°, 10 nm within ±35°. Glideslope: elevation angle from the GS reference point, full scale
  ±0.7° (0.35° per dot), valid within 10 nm, ±8° of course, front side only. Marker beacons
  report when within ±300 m along track and ±300 m laterally of the beacon.
* **GPS** — `legGeometry(A, B, P)` gives cross-track, along-track, remaining distance, desired
  track at the abeam point and direct bearing/distance (standard spherical formulas on
  R = 6 371 km). `turnRadiusM(V, φ) = V²/(g·tan φ)` with φ = 25° (110 kt → 700 m),
  `turnAnticipationM = r·tan(Δ/2)`, capped at r for turns beyond 90°.

### Flight plan
`activeLeg` is the index of the active (TO) waypoint; the FROM point is the previous waypoint
or the position where direct-to was pressed. The next leg becomes active when the remaining
along-track distance drops below the turn-anticipation distance (and the aircraft is actually
near the waypoint, not merely abeam from far off-track), or when the waypoint is passed. The
last waypoint is never sequenced past; `complete` turns true once it is behind. Removing the
active waypoint activates the next one and cancels a direct-to; removing any other waypoint
keeps the direct-to origin. `eteS` is to the active waypoint; `eteTotalS`, `totalDistanceM`,
`remainingDistanceM` cover the route.

## Tuning knobs

| Constant (file) | Default | Meaning |
|---|---|---|
| `ILS_MIN_RUNWAY_M` (ils.ts) | 4 000 ft | shortest paved runway that gets a synthetic ILS (large/medium airports) |
| `LOC_ANTENNA_BEYOND_END_M`, `LOC_HALF_WIDTH_AT_THRESHOLD_M` | 300 m, 106.7 m | localizer siting and course width (±350 ft at the threshold) |
| `LOC_HALF_WIDTH_MIN_DEG` / `MAX_DEG` | 1.5° / 3.0° | allowed full-scale half-width (3°–6° course) |
| `GS_ANTENNA_SETBACK_M`, `GS_ANTENNA_LATERAL_M`, `GS_ANGLE_DEG`, `GS_FULL_SCALE_DEG` | 300 m, 120 m, 3.0°, 0.7° | glideslope geometry |
| `MARKER_DISTANCES_M`, `MARKER_ALONG_TRACK_M`, `MARKER_LATERAL_M` | 4 nm / 1 050 m / 300 m; ±300 m | marker beacons |
| `VOR_FULL_SCALE_DEG` (radio.ts) | 10° | VOR CDI full scale |
| `VOR_CONE_HALF_ANGLE_DEG`, `VOR_CONE_MIN_RADIUS_M` | 50°, 300 m | cone of confusion |
| `STATION_ANTENNA_HEIGHT_M` | 10 m | added to the station elevation for the radio horizon |
| `LOC_RANGE_NM`, `LOC_WIDE_RANGE_NM`, `GS_RANGE_NM` | 18, 10, 10 nm | ILS service volume |
| `TURN_BANK_DEG` / `FlightPlanner.bankDeg` | 25° | turn-anticipation bank |
| `ILS_TUNE_RANGE_NM` (NavDatabase.ts) | 40 nm | farthest ILS `findIlsByFrequency` returns |
| `DEFAULT_NAVAID_RANGE_NM` (airportsData.ts) | VOR 40, VORTAC/TACAN 130, NDB 50 nm | published range per type |
| `HEADWIND_TIE_EPS` (NavDatabase.ts) | 0.02 | headwind (cos) tolerance within which the longer runway wins |
| `MagVarCache(maxDistanceM, maxAgeMs)` | 5 km, 60 s | declination cache staleness |

## Tests (`npx vitest run src/nav src/geo`)
* `radio.test.ts` — the VOR sign-convention cases above, full scale/clamping, TO/FROM flip, cone
  of confusion, range/line of sight, DME/NDB behaviour; ILS centred on the 3° path, 100 ft high
  at 2 nm → −0.67, ±350 ft at the threshold → ∓1, back course, markers, range lobes; GPS cross-/
  along-track signs, turn radius and anticipation.
* `radio.spec.test.ts` — spot checks against the spec: KSFO→KOAK/KSEA/LOWI distances and
  bearings, D→ KOAK (9.46 nm, 050° T, 037.7° M), the SFO VOR worked example (OBS 032 FROM /
  212 TO), station vs local declination, TO/FROM exactly at 90°, altitude-dependent cone, DME
  availability, LOC widths (KTRK 11, LOWI 26, KSFO 28R, 6° clamp), angular full scale at 5 nm,
  GS ±0.7° full scale / 0.35° half scale, 52 ft TCH, 478 fpm at 90 kt.
* `spatialGrid.test.ts` — exact metres/degree, no duplicates when the column band wraps,
  neighbours across cell corners, the antimeridian and the poles, 200 random synthetic queries
  and **56 positions × (airports, navaids) on the full real dataset vs a brute-force scan**,
  1 000 queries < 200 ms, `shardCellsAround` vs dense sampling of the circle (poles, antimeridian).
* `airportsData.test.ts` — KSFO → 4 runways, 28R threshold/length/heading, `runwayForEnd`,
  LOWI 08/26, KHAF from a small shard, elevation/heading fallbacks, the 4 000 ft ILS rule,
  synthetic ILS in band, unique per airport and deterministic, ILS geometry distances,
  magnetic runway heading, navaid decoding, surface codes, reciprocal idents.
* `NavDatabase.test.ts` — empty before load, `getAirport`, `nearestAirports`, `nearestNavaids`,
  `searchAirports` ranking, `findNavaidByFrequency(116800)` → OAK, `findIlsByFrequency` → 28R,
  `runwayInUse` for winds 290 / 100 / 20 / 200, shard loading with loader-call counting.
* `flightPlan.test.ts` — distances and ETE, cross-track sign, sequencing by anticipation and by
  passing abeam, no early sequencing far off-track, last waypoint, direct-to, add/insert/remove,
  direct-to origin kept when an earlier waypoint is removed, zero-length legs stay finite.
* `frequencies.test.ts` — band classification, NAV/COM stepping with wrap for both spacings and
  both knobs, formatting (`'118.005'`), snapping, parsing, swap.

The sign conventions, the TO/FROM boundary, the declination sign, the glideslope sign, the
grid's early exit and column margin and the turn anticipation formula were each mutated during
review and every mutation fails the suite.

## Known limitations
* ILS data is synthetic (frequencies/idents are not the real ones) — swap in FAA NASR / real
  data when available; `synthetic: false` records flow through the same code.
* The contract's `Runway.ils` can hold only one ILS, so the high-numbered end's lives on
  `ends[1].ils`; code that only reads the contract field misses it (see proposed changes).
* Navaid ranges are per-type defaults, not the published service volume; the build script does
  not bake OurAirports' `power` column. It also merges `slaved_variation_deg` with the older-epoch
  `magnetic_variation_deg` into one field, so for the ~70 % of navaids without a slaved value
  the radial uses that older variation instead of the WMM fallback the spec asks for.
* VOR/ILS signal quality is binary (valid / flagged); no needle wobble, no false glideslopes, no
  1.3× fringe, no terrain masking beyond the smooth-earth radio horizon (heights above MSL, so
  stations at high elevation are received generously).
* The glideslope uses the centreline reference point and ignores earth curvature (≈ 0.08° at
  10 nm), so the lateral antenna offset only matters for scenery placement.
* No DME ground speed / ETE (`−d(slant)/dt`) yet; no ADF needle model beyond `bearingDeg`.
* Great-circle maths is spherical (R = 6 371 km; the spec's 6 371 008.8 m differs by 1.4 ppm);
  fine for displays and the CDI, not for survey work. `desiredTrackDeg` is the abeam-point
  course to first order in the cross-track offset.
* `NavDb` keeps everything in memory (~5k large/medium airports, 11k navaids, plus loaded
  shards) and never evicts shards. `searchAirports` is a linear scan (≈ 1 ms for 11k records).

## Proposed changes to `src/core/types.ts` (not made; implemented here as extensions)
* `NavRadioState`: add `dmeValid: boolean` (a plain VOR/NDB has no DME, but `dmeNm` is always a
  number), `backCourse: boolean` and `marker: 'outer' | 'middle' | 'inner' | null` — all three
  exist on `NavRadioStateEx`.
* `Runway.ils` → per-end ILS (or `Runway` → one record per landing direction), so both ends of a
  physical runway can carry one without the `ends` extension.
* `Navaid`: optional `hasDme` and a separate `stationDeclinationDeg?` (slaved variation) so the
  WMM fallback in spec §4.2 can be applied when the station value is missing (needs the build
  script to stop merging the two columns).
