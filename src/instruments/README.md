# `src/instruments` — cockpit instruments

2D-canvas renderers for the cockpit displays. **No Three.js imports**: the integrator wraps the
canvases in `THREE.CanvasTexture`s (cockpit panels) or places them in the DOM (HUD overlay,
pop-out displays). Everything runs in Node against `testing/mockCanvas.ts`. Spec:
`docs/research/05-cockpit-avionics-navigation.md` §1–3 and §6.

| Export | What it draws | Canvas |
|---|---|---|
| `SteamPanel` | C172S six-pack, engine/system gauges, radio stack, annunciators | 1024×512 opaque |
| `G1000` | G1000-style PFD and MFD (moving map + engine strip) | 2 × 1024×768 opaque |
| `Hud` | translucent MSFS-like overlay for the external views | viewport × dpr, transparent |
| `InstrumentModel` | instrument dynamics shared by all of the above | — |

## API

```ts
import { G1000, Hud, SteamPanel, CANVAS_TEXTURE_SETTINGS, PANEL_TEXTURE_SIZE, createCanvas } from './instruments';

// G1000 ───────────────────────────────────────────────────────────────────────────
const g1000 = new G1000({ width?, height?, createCanvas?, model?, vspeeds?, pfdHz = 30, mfdHz = 15,
                          skipUnchanged = true, maxIdleS = 1, rangeNm = 10 });
g1000.pfdCanvas; g1000.mfdCanvas;                 // HTMLCanvasElement | OffscreenCanvas
if (g1000.update(snapshot, dt)) {                 // true when a canvas changed
  if (g1000.changed.pfd) pfdTex.needsUpdate = true;
  if (g1000.changed.mfd) mfdTex.needsUpdate = true;
}
g1000.setNearestAirports(list);   // { icao, lat, lon, type }[] or nav-database Airport[]
g1000.setRange(nm); g1000.zoom(+1 | -1); g1000.rangeNm;       // snaps to 0.5 … 2000 nm steps
g1000.setMapOrientation('north-up' | 'track-up' | 'heading-up');
g1000.setCdiSource('GPS' | 'NAV1' | 'NAV2'); g1000.cycleCdiSource();   // CDI softkey
g1000.setBearingSource(1 | 2, 'OFF' | 'NAV1' | 'NAV2' | 'GPS');      // BRG1 = NAV1, BRG2 = GPS by default
g1000.setWindOption(1 | 2); g1000.setDmeSource('OFF' | 'NAV1' | 'NAV2');
g1000.com1.activeKHz = 118300; g1000.squawk = 7000; g1000.xpdrMode = 'ALT';  // not in SimSnapshot
g1000.startTimer(); g1000.stopTimer(); g1000.resetTimer();
g1000.reset(snapshot); g1000.invalidate(); g1000.dispose();
g1000.hsiGeometry;                // screen geometry of the last HSI draw (hit-testing, tests)

// HUD (DOM overlay above the WebGL canvas, CSS pointer-events: none) ────────────────
const hud = new Hud({ createCanvas?, uiScale = 1, hz = 30, showInCockpit = false });
document.body.appendChild(hud.canvas as HTMLCanvasElement);
hud.resize(innerWidth, innerHeight, devicePixelRatio);   // also sets the canvas CSS size
hud.update(snapshot, dt);         // redraws at most hz, only when something visible changed
hud.setVisible(sim.hudVisible);   // hidden: clears once, then draws nothing
hud.setStatus('Loading imagery…' | null);   // custom status-line hook (bottom left)
hud.values;                       // the numbers shown last frame

// Steam panel ────────────────────────────────────────────────────────────────────
const panel = new SteamPanel({ layout?, factory?, pixelRatio?, hz?, model?, vspeeds? });
if (panel.update(snapshot, dt)) steamTex.needsUpdate = true;

// Texture helpers (no Three.js types) ────────────────────────────────────────────
PANEL_TEXTURE_SIZE.g1000;  // { width: 1024, height: 768 };  .steam = 1024×512
CANVAS_TEXTURE_SETTINGS;   // colorSpace srgb, generateMipmaps false, linear filters, anisotropy 8, toneMapped false
createCanvas(w, h);        // <canvas> in a browser, OffscreenCanvas in a worker, throws otherwise
```

Integrator recipe for one display:

```ts
const tex = new THREE.CanvasTexture(g1000.pfdCanvas as HTMLCanvasElement);
tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false;
tex.minFilter = tex.magFilter = THREE.LinearFilter;
tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
```

Sharing one `InstrumentModel` between the steam panel and the G1000: pass `model` to the G1000
and call `model.update(snapshot, dt)` yourself before `g1000.update()` (a G1000 never steps a
model it does not own, so the lags are not advanced twice).

## How it works

* **Readings** (`readings.ts`): `InstrumentModel.update(snapshot, dt)` turns `AircraftState` into
  `InstrumentReadings` (one object, mutated in place): pitot-static and Kollsman altimetry, VSI
  lag, vacuum gyros with spin-up/erection/drift, turn coordinator and ball, magnetic compass
  errors, engine-gauge lags, electrical/vacuum/fuel systems, annunciators, wind, trends, clock.
  Glass displays use the AHRS truth (`ahrs`, `heading.magDeg`); the steam gauges use the gyros.
* **Design space**: each G1000 display is drawn in a fixed 1024×768 layout
  (`g1000/palette.ts` `PFD`/`MFD`) and scaled to the backing store with `setTransform`.
* **PFD** (`g1000/pfd.ts`): full-width attitude with pitch ladder, roll scale, slip bar and
  single-cue FD; airspeed tape (bands, V-speed bugs, 6 s trend, TAS), altitude tape (selected
  altitude, baro, trend, glideslope), VSI; HSI (`hsi.ts`: rotating rose, turn-rate scale with 6 s
  trend vector → arrowhead above 4°/s, heading bug, BRG1/BRG2 pointers, course pointer + CDI +
  TO/FROM in the source colour, HDG/CRS boxes); NAV/COM boxes (`radioBoxes.ts`), navigation status
  and AFCS boxes (`afcsBox.ts`: active green / armed white, 10 s flash on mode change, red AP
  flash for 5 s after a disconnect); wind/GS/OAT/XPDR/UTC/timer/DME/BRG info and marker beacons
  (`infoBoxes.ts`); alerts window and ALERTS softkey (`alerts.ts`).
* **Nav sources** (`g1000/navData.ts`): `resolveCdi`/`resolveBearing` map `nav1`/`nav2`/`plan`
  into what the HSI shows. GPS: course = plan DTK converted to magnetic, deviation =
  −crossTrack / full scale (ENR 2.0 nm, TERM 1.0 nm within 31 nm of the first/last waypoint).
  VOR/LOC: OBS course, `cdi` as given (+ = fly right), `dmeValid` honoured when present.
* **MFD** (`g1000/mfd.ts`): GS/DTK/TRK/ETE data fields, engine strip (`eis.ts`: RPM arc, FFLOW,
  OIL PRES/TEMP, EGT, VAC, FUEL QTY L/R, ENG HRS, bus volts and battery amps with POH bands) and
  the moving map (`map.ts`: local equirectangular projection from `geo.ts`, range ring + dashed
  half ring with compass ticks, plan legs magenta/white/grey, waypoint symbols, nearest airports,
  1-minute track vector, wind arrow, north pointer, orientation and range labels).
* **Redraw policy** (`G1000.update`): instrument dynamics step every call; each display is due at
  most `pfdHz`/`mfdHz` times per second; when due, a 32-bit hash of everything it shows, quantised
  to about half a pixel (`displaySignature.ts`, `signature.ts`), is compared with the previous one
  and the draw (and the texture upload) is skipped when equal. A redraw is forced every `maxIdleS`
  so a hash collision can never freeze a display. Parked or in a steady cruise the PFD drops from
  30 Hz to about 1 Hz (the UTC clock).
* **No per-frame allocation** in the draw paths: readouts go through `LabelCache` (memoised
  number → string), fonts through `FontCache`, scratch objects are owned by the renderers.
* **HUD** (`Hud.ts`, `hud/`): truth values from the snapshot with short display lags (IAS 0.12 s,
  VS 0.6 s); top strip (IAS/GS, ±30° heading tape with bug, ALT/VS/AGL), AP mode line, flags
  (CRASHED, STALL flashing, OVERSPEED, OVER-G, FLAP/GEAR SPEED, LOW FUEL, PAUSED, SLEW), bottom
  controls strip (THR, MIX, FLAPS, TRIM, GEAR, BRAKE/PARK) and the terrain-loading bar while
  `snapshot.terrainReady < 1`. In the cockpit camera only flags and status are shown. The scale
  follows the viewport height (1 at 600 CSS px) but shrinks so the top strip always fits the
  width (portrait phones); the status box stacks above the controls strip when space is short.

## Tests (`npx vitest run src/instruments`)

* `readings.test.ts`, `format.test.ts`, `gauges/gauges.test.ts`: altimetry, lags, gyros, turn
  coordinator, compass, systems, formatting, every steam gauge draws, static-layer caching.
* `g1000/hsi.test.ts`: nav-source resolution (VOR, invalid NAV, GPS DTK/XTK sign and TERM/ENR
  scale, no plan, bearing pointers, localizer), HSI draw, **+cdi (fly right) puts the bar right of
  centre**, reversed course pictorial sense, heading wrap 359 → 001, trend arrowhead, red X.
* `g1000/widgets.test.ts`: every PFD widget draws without throwing and with balanced
  save/restore for the sample and edge cases (AP/FD off, NAV invalid, plan null, negative VS,
  heading wrap, ILS, engine off on the ground, extreme attitude, FLC, NaN/∞/out-of-range plan
  data); AFCS labels/reference/flashing; alert priority and softkey; wind options; NAV box;
  `dmeValid`, back course and marker beacons.
* `g1000/G1000.test.ts`: first `update` returns true and a second within 33 ms returns false;
  ≤ 30 Hz cadence; unchanged frames skipped; forced refresh after `maxIdleS`; CDI cycling; MFD
  content (EIS, data fields, legs, airports, range); nav-database airports; zoom steps; track-up;
  shared model not stepped; backing-store scaling; dispose. Map projection orientation.
* `Hud.test.ts`: resize to CSS × dpr, update does not throw, content in external views,
  cockpit mode hides flight data but keeps flags and terrain loading, redraw cap and change
  skipping, hide/show, warnings and status hook, dispose; tape labels, flaps/gear text, scaling.

The layout was also checked visually by rendering the PFD, MFD and HUD in headless Chrome.

## Known limitations

* GPS CDI scaling has ENR/TERM only (no DPRT/APR/LPV ramps; the `FlightPlan` contract carries no
  approach phase). No VNAV, OBS/SUSP, or flight-plan pages; softkeys are drawn but inert.
* The moving map has no terrain/topo shading, airspace, roads or runway-shaped airport icons
  (the nearest-airport input has no runway data), and uses an equirectangular projection
  (schematic beyond ~100 nm). Labels are not decluttered beyond a range threshold.
* COM radios, transponder code/mode and the DME source live on the `G1000` instance because the
  `SimSnapshot` has no COM/XPDR state (see proposed contract changes).
* Bearing pointers support NAV1/NAV2/GPS (no ADF). The marker annunciator is static (no keying).
* The G1000 has no failure injection beyond what `InstrumentReadings` reports (dead bus → black
  screens, AHRS invalid → red X over the full-width attitude and the HSI).
* Panel dimming (`inputs.lights.panel`) and night palettes are not applied to the glass displays.
* When the PFD and MFD are composited into one texture, use `g1000.changed.pfd/mfd` to blit only
  the display that changed.
* Fonts: the canvas uses the CSS stacks in `canvas.ts`; load "Roboto Condensed"/"Roboto Mono"
  with `document.fonts.load` before the first draw or a fallback face is used.

## Tuning knobs

* Redraw: `G1000.pfdHz` (30), `mfdHz` (15), `skipUnchanged` (true), `maxIdleS` (1 s);
  `Hud.hz` (30), `SteamPanel.hz` (30). Quanta per value in `g1000/displaySignature.ts`.
* Resolution: `G1000Options.width/height` (backing store; design space stays 1024×768),
  `SteamPanel` `pixelRatio`, `Hud.uiScale` (on top of `hudScale(viewport)`).
* Layout and colours: `g1000/palette.ts` (`G`, `PFD`, `MFD`), `HSI`, `INFO`, `STATUS`, `RADIO`,
  `ALERTS_RECT`, `EIS`, `MAP` objects in their widget files; `hud/primitives.ts` `HUD_COLORS`.
* Behaviour: `GPS_CDI_SCALE_NM`, `TERMINAL_RADIUS_NM` (navData), `MODE_FLASH_S`,
  `AP_DISCONNECT_FLASH_S`, `FLASH_PERIOD_S` (afcsBox), `WIND_MIN_TAS_KT` (infoBoxes),
  `MAP.labelRangeNm`, `MAP.minTrackGsKt`, `MAP.rotatedCy` (map), `HSI.trendMaxDeg`/`arrowRateDegS`.
* Aircraft: `VSpeeds` (`c172.ts` `C172S_VSPEEDS`) for tape bands/bugs; gauge markings in `c172.ts`;
  instrument dynamics in `defaultInstrumentConfig()` (lags, gyro drift, low-fuel threshold, …).
