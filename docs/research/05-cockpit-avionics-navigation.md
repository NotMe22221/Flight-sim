# 05 — Cockpit, instruments, navigation, autopilot, ATC: implementation spec

Scope: everything between the FDM (doc 02) and the pixels — steam gauges for a Cessna 172S, a G1000-style PFD/MFD, Three.js rendering strategy, VOR/ILS/DME/GPS/ADF models, an attitude-based autopilot with flight director, the external-view HUD and MSFS-style toolbar, navaid/airport data, 172S checklists, and a scripted ATC with Web Speech voices. Companion to doc 01 (§5, §7.3, §8, §9, §15.4), doc 02 (`FDMState`/`FDMOutputs`, §7 airspeeds) and doc 03 (§11 OurAirports).

Evidence tags used throughout: **[verified]** = fetched or computed in this session (file headers, source code, scripts); **[search]** = taken from search-engine summaries of secondary sources (flight-school guides, manual mirrors); **[memory]** = standard aviation knowledge not confirmable from this container (hosts such as faa.gov, garmin.com, manualslib.com, wiki.flightgear.org were unreachable). Anything tagged [memory] that affects numbers in code is also listed in §12 for a browser-side check.

---

## 0. Decisions in one page

| Topic | Decision | Why |
|---|---|---|
| Steam gauges | 3D meshes (bezel + dial texture + needle sub-meshes rotated per frame), **no per-frame texture upload** | Cheapest and crispest; zoom-proof; standard MSFS/X-Plane approach |
| Glass (G1000) | One 1024×768 `CanvasTexture` per display unit, redrawn at 30 Hz (PFD) / 15–20 Hz (MFD) with `generateMipmaps=false`; same `<canvas>` reusable as a 2D pop-out | GDU 1040 native resolution is 1024×768 **[search]**; CanvasTexture is the only practical way to get rich 2D graphics onto a cockpit mesh; dirty-rate control bounds the upload cost |
| HUD / toolbar / ATC / checklist / map | HTML + CSS overlay above the WebGL canvas | Crisp DOM text, accessibility, zero GPU cost, easy layout; MSFS panels are 2D anyway |
| Instrument model | A pure `Instruments` module (`FDMOutputs` → `InstrumentReadings`) with explicit lags, gyro spin-up/drift, pitot-static errors and failures | "Feel" lives in the lags: VSI τ ≈ 2.5–3 s, AI 4 s spin-up / 3 min spin-down, HI drift 0.25°/min, compass turning error |
| Nav model | Great-circle geodesy on a sphere (R = 6 371 008.8 m) for nav; WGS-84 only for terrain placement; WMM2025 declination via the MIT `magvar` algorithm (bundled, 13×13 coefficient tables) | Error of spherical vs ellipsoidal bearing < 0.2° over 100 nm, irrelevant for a 5° CDI; `magvar` validates against NOAA's WMM2025 test vectors **[verified]** |
| ILS data | **Synthesize** an ILS for every paved runway ≥ 4 000 ft at `large_airport`/`medium_airport` (LOC at far end, GS antenna 1 000 ft from threshold, 3.0°), optional FAA NASR import for real US frequencies | OurAirports `navaids.csv` contains **zero** ILS/LOC rows **[verified]** |
| Autopilot | Attitude-based cascaded loops (GFC 700-like): mode → roll/pitch command → surface; modes HDG NAV APR ALT VS FLC LVL (+ROL/PIT/GS/BC), bank limit 25° (22° in APR), pitch +15°/−10°, servo authority ±50 %, autotrim | Attitude-based is far easier to tune and matches the G1000 the user expects; KAP 140 (rate-based) behaviour documented for flavour |
| Voice | Web Speech API `speechSynthesis` (all evergreen browsers **[verified caniuse]**), radio click/squelch samples via WebAudio, text subtitles always on | No backend; the TTS output cannot be routed through WebAudio, so the "radio" effect is faked with bracketing samples |
| Data | `scripts/build-navdata.mjs` → `public/data/{navaids,airports,frequencies}.json` (sharded by 10° cells for small airports/frequencies); runtime fetch of CSVs **not** done | 17 MB of CSV vs ~1.5 MB JSON; raw.githubusercontent.com serves `access-control-allow-origin: *` **[verified]** if a runtime fallback is ever wanted |

---

## 1. Steam-gauge cockpit (Cessna 172S)

### 1.1 V-speeds and airspeed indicator markings (172S, 2 550 lb)

Values agree across the 172S POH Section 2 copies summarised by [Angle of Attack](https://www.angleofattack.com/what-are-v-speeds/), [SE Oklahoma V-speed charts](https://www.se.edu/aviation/wp-content/uploads/sites/4/2023/10/V-Speed-Charts.pdf), [Brainscape 172S cards](https://www.brainscape.com/flashcards/cessna-172-s-v-speeds-7961718/packs/13202957) and the [AirPlains 180 hp STC supplement](https://txwg.cap.gov/media/cms/AFM_Suppl__STC_SA2196CE_AirPlains_C_21839006FDB25.pdf) **[search]**; doc 02 §10 uses the same numbers.

| Symbol | KIAS | Meaning / where it shows |
|---|---|---|
| Vso | 40 | Stall, landing config (flaps 30) — bottom of white arc (47 KCAS) |
| Vs1 | 48 | Stall, clean — bottom of green arc (53 KCAS) |
| Vr | 55 | Rotate (normal); 51 short-field |
| Vx | 62 (SL) → 67 (10 000 ft) | Best angle |
| Vy | 74 (SL) → 72 (10 000 ft) | Best rate |
| Best glide | 68 | Engine-out |
| Vfe | 110 (flaps 0→10°), 85 (10→30°) | Top of white arc = 85; 110 shown as a separate white tick/label in G1000 |
| Va | 105 @ 2 550 lb, 98 @ 2 200, 90 @ 1 900 | Not marked on dial (placard) |
| Vno | 129 | Green/yellow boundary |
| Vne | 163 | Red radial line |
| Approach | 65–75 flaps up, 60–70 flaps 30, 61 short field | Landing |
| Balked landing | 55 (flaps 20) | Go-around |
| Max demonstrated crosswind | 15 kt | Not a limit |

Dial: 0–200 kt scale, non-linear mechanical dials start at 40; use a **linear 40–200 kt over 320°** mapping with a dead sector below 40 (0–40 compressed into 20°) so the needle sits at "0" when parked. Arcs: white 40–85, green 48–129, yellow 129–163, red line 163. Va placard "105 KIAS @ 2550 LB".

### 1.2 Six pack: what each instrument reads and how it lags

Inputs come from `FDMOutputs` (doc 02 §12): `Vias/Vcas` (already position-corrected), `pStatic`, `altitudeIndicated` (if the FDM does Kollsman) or raw `pStatic` + `qnhPa`, `verticalSpeed` (true ḣ), `eulerRad`, `omega` (p, q, r), `headingMagRad`, `ny/nz`, `rho`, plus engine/system state. The constants below come from FlightGear's instrument sources (`src/Instrumentation/*.cxx`, GPL-2, fetched **[verified]** from the GitHub mirror) unless noted; they were tuned over 20 years against pilot feedback and are a good default.

| Instrument | Source signal | Model (per sim step, dt) | Default constants |
|---|---|---|---|
| **Airspeed (ASI)** | impact pressure `qc = pt − ps` | `Vcas = a0·sqrt(5·((qc/p0 + 1)^(2/7) − 1))`, then `IAS = Vcas + Δpos(Vcas, flap)` (doc 02 §7 table), 1st-order lag `τ = 0.1 s` (FG uses 0.02 s — effectively none) | position-error table doc 02 §7 (reconstructed, **[memory]**); needle quantisation none |
| **Attitude (AI, vacuum)** | φ, θ | gyro spin `s` ∈ [0,1]: power = `suction/4.5 inHg` (min vacuum 4.5), spin-up 4 s to full, spin-down 180 s with power off; indicated = lowpass(true, `s⁶`) + erection error: for `s < 0.8`, `err = ((0.8−s)/0.8)²·(40° roll, 12° pitch)`; optional tumble past ±45° with 300 s re-erect (1 s if caged) | from `attitude_indicator.cxx` **[verified]**; real erection rate 2.5–8 °/min and 3–5° precession error after a 180° steep turn **[search]** — add `precessionDeg = 0.02·∫|p|dt` decaying at 3°/min for extra flavour |
| **Altimeter** | `ps`, Kollsman `p_set` | `h_press = (T0/|L|)·(1 − (ps/p0)^(R|L|/g0)) = 145 366.45·(1 − (ps/1013.25 hPa)^0.190284) ft`; `h_ind = h_press − kollsman(p_set)` where `kollsman = 145 366.45·(1 − (p_set/1013.25)^0.190284)`; both low-passed with `τ = 0.1 s`; optional 10 ft quantum; Mode C = round to 100 ft | `altimeter.cxx` **[verified]**; 0.20 inHg setting change ≈ 184 ft at SL (rule of thumb "1 inHg = 1 000 ft") **[computed]** |
| **Turn coordinator (electric)** | p, r (°/s) | `rate = p/20 + r/3` in *standard-rate units* (1.0 = 3°/s), clamp ±2.5, scale by gyro factor `1 − (1−s)³`, low-pass `τ = 2 s` (RESPONSIVENESS 0.5) | `turn_indicator.cxx` **[verified]**; spin-up 4 s, spin-down 180 s on electrical bus |
| **Inclinometer ball** | body accel `a_y, a_z` | `ball = clamp(atan2(−a_y, −a_z) / (4°), −1.5, +1.5)` ball-widths, low-pass `τ = 0.3 s` | FG `slip_skid_ball.cxx` uses a similar accel ratio **[verified]**; 4°/ball is a tuning value **[memory]** |
| **Heading indicator (vacuum DG)** | ψ_true, mag var | `offset −= 0.25°/min · dt` (earth rate, 360°/day) plus random walk `σ = 0.5°/√min`; `hdg_ind = lowpass(ψ_true, dt·100·s⁶) + offset`; pilot "set" button copies compass heading into `offset`; heading bug error = `wrap(bug − hdg_ind)` | `heading_indicator.cxx` **[verified]**: power = suction/5.0; real-world drift ~3° per 15 min expected by pilots **[memory]** |
| **VSI** | `ps` | Preferred simple model: `vsi = lowpass(ḣ_true, τ = 2.8 s)` (+ "reversal" blip `−0.02·q̇`); FG's physical model: casing 1.25e-4 m³, orifice 7.85e-9 m² (Ø 0.1 mm), `vs_fpm = sign·sqrt(|Δp|)·189.15` — reproduces the 6–9 s settling pilots quote | `vertical_speed_indicator.cxx` **[verified]**; "six to nine seconds" lag **[search]** |
| **Magnetic compass (wet)** | ψ_mag, φ, θ, dip μ, accelerations | target heading `Hc = atan2(a, b)` with `a = cosφ·sinψ·cosμ − sinφ·cosθ·sinμ − sinφ·sinθ·cosμ·cosψ`, `b = cosθ·cosψ·cosμ − sinθ·sinμ`; tilt the float 0.07 rad per g of longitudinal/lateral acceleration (`θ −= 0.07·a_x/g`, `φ −= 0.07·a_y/g`); card dynamics: `rate = lowpass(error, dt/5)`, `hdg += rate·dt` (gives the real overshoot/oscillation); deviation card ±3° | `mag_compass.cxx` (public domain) **[verified]**; dip at KSFO ≈ 61°, LOWI ≈ 64° (dipole approx `tan I = 2·tan(mag lat)`) **[memory]** |

Implementation notes:
* Run instruments at the render rate (60 Hz) on the latest FDM state; they are cheap. Keep each instrument's internal state in a struct so failures (vacuum pump off, electrical off, pitot/static blockage) just change inputs.
* **Pitot/static failures** (for the Assistance/failures menu): blocked pitot + drain → `qc` frozen → IAS behaves like an altimeter (rises in climb); blocked static → altimeter frozen, VSI → 0, IAS reads low in climb/high in descent ("PUD-SOD") **[search]**; alternate static (cabin) → altimeter +~30 ft, IAS +~2 kt **[memory]**.
* Vacuum (suction) model: `suction = engineRunning ? clamp(5.0·min(1, rpm/1 200), 0, 5.2) : 0` with regulator holding 4.6–5.4 inHg above 1 500 RPM; AI and DG take their power from it; TC from the electrical bus.

### 1.3 Engine and system gauges (172S steam panel) — markings and derivations

172S has a Lycoming IO-360-L2A, 180 BHP at 2 700 RPM, fuel-injected (**no carburettor heat**; the 172N/P have it), 28 V electrical system with 60 A alternator, 56 gal total / 53 gal usable (26.5 per tank, 1.5 unusable per tank) **[search: POH mirrors]**. There is **no manifold-pressure gauge on a fixed-pitch 172** — the MAP gauge below is for the 182/constant-speed archetype and uses `FDMState.map_inHg`.

| Gauge | Scale | Markings | Derivation from FDM / systems |
|---|---|---|---|
| Tachometer | 0–3 500 RPM, 270° sweep | green 2 100–2 700 (172S; 172R: 1 900–2 400), red 2 700 (172R 2 400) **[search]** | `rpm` direct (mechanical drive; add τ 0.15 s to hide integrator jitter); hour meter advances at `rpm/2 300` × real time |
| Manifold pressure (182-class only) | 10–35 inHg | green 15–? per type | `map_inHg` τ 0.1 s |
| Oil temperature | 75–250 °F | green 100–245, red 245 **[search]** | 1st-order toward `T_target(°F) = 1.8·OAT_C + 32 + 100 + 70·pctPower`, τ 120 s warming / 300 s cooling; starts at OAT |
| Oil pressure | 0–115 psi | red 20 (min), green 50–90, red 115 (max) **[search]** | `P = engineRunning ? min(90, 25 + 65·rpm/2 700)·(1 + 0.25·max(0, (150−T_oil_F)/150)) : 0`, 3 s rise after start |
| Fuel quantity L/R | E–F (0–26.5 gal) | red line at E (0 usable) **[search]** | `gal = tanksKg[i]/2.72 − 1.5 (unusable)`; float gauge: τ 2 s, slosh offset `±0.6 gal·sin(φ)·(1 − fill)` and `±0.4 gal·sin(θ)`; accuracy legally guaranteed only at empty, so bias +0.5 gal at ¾ full |
| Fuel flow (172S) | 0–20 gph | green 0–? (POH) **[memory]** | `fuelFlowKgS·3 600/2.72` gph, τ 1 s |
| EGT | 1 000–1 700 °F, 25 °F per division **[memory]** | reference needle set by pilot | doc 02 §4.8 EGT with τ 3 s |
| Suction | 3–7 inHg | green 4.5–5.5 **[search: STC supplement; 172S POH expected same, verify]** | vacuum model above |
| Ammeter | −60…+60 A (172S shows alternator load 0–60 A) | none; **LOW VOLTS** annunciator < ~24.5 V **[memory]** | `I = alternatorOnline ? Σ loads (avionics 8 A, nav lights 3, beacon 2.5, strobe 3, landing light 8, taxi 5, pitot heat 7, flaps motor 15 while moving) + batteryCharge : 0`; battery discharge negative when alternator off |
| Flap position | 0/10/20/30 | — | `surfaces.flapDeg` direct (electric; indicator is a separate follow-up pot, τ 0.2 s) |
| Elevator trim | nose down … TAKEOFF … nose up | TAKEOFF band | `surfaces.trimRad / trimMax` → pointer; TAKEOFF ≈ 0 to +5 % nose-up |
| OAT | −40…+50 °C/°F | — | `T − 273.15`, τ 10 s |
| Clock / Hobbs | — | — | sim time; Hobbs runs when oil pressure > 20 psi |

Annunciators (172S): LOW VOLTS, LOW FUEL L/R (< 5 gal for 60 s), OIL PRESS (< 20 psi, steam has none but G1000 does), VACUUM (< 3.5 inHg), PITOT HEAT (off/fail), carb-heat n/a. Stall warning horn: `alpha > alphaStall − 5°…−10°` (reed horn, pitch rises with α — see audio doc).

---

## 2. G1000-style PFD/MFD specification

Garmin's own pilot's guides were unreachable from this container; the layout below combines the fragments that search summaries quoted verbatim **[search]**, the physical unit facts (GDU 1040: 10.4″ LCD, **1024×768**, 4:3 **[search]**), and the community's implementation of the layout in MSFS ([microsoft/msfs-avionics-mirror](https://raw.githubusercontent.com/microsoft/msfs-avionics-mirror/main/README.md), MIT — a legitimate behavioural reference, do not copy art). Draw everything in a **1024×768 design space** and scale.

### 2.1 Verified behaviours to reproduce (quoted facts)

* Airspeed tape: "speed indication starts at 20 knots, with 60 knots of airspeed viewable at any time"; labels/major ticks every 10 kt, minor ticks every 5 kt (TBM guide); colour bands white/green/yellow/red per POH; **magenta trend vector showing airspeed in 6 s**; TAS readout at the bottom of the tape; Vspeed bugs (Vr, Vx, Vy, Vglide) as labelled markers; the trend vector is absent when speed is constant **[search]**.
* Altimeter: moving tape with minor ticks every 20 ft and labels/major ticks every 100 ft, central rolling-drum pointer, **6 s trend vector**, selected-altitude bug + box above the tape, barometric setting box below **[search]**. Viewable range **~600 ft** (±300) **[memory]**.
* VSI: fixed scale labelled 1 000 and 2 000 fpm each way, minor ticks every 500 fpm; **digits appear in the pointer only above 100 fpm**; pointer clamps at the scale end **[search]**.
* Attitude: major pitch marks and labels every 10° (10…80), minor at 5°; red extreme-pitch chevrons pointing at the horizon from **50° nose-up and 30° nose-down**; roll scale ticks at 10, 20, 30, 45, 60 with an inverted white zero-triangle and a roll pointer; **slip/skid bar beneath the roll pointer, "one bar displacement equals one ball displacement"**; red X over the attitude display on failure **[search]**.
* HSI: rotating compass card (heading-up), cardinal letters, numeric labels every 30°, ticks every 5°/10°; CDI with **2 dots each side**; nav source colour **magenta = GPS, green = VOR/LOC**; **bearing pointers cyan — single line BRG1, double line BRG2**; **turn-rate indicator above the HSI with ticks at half-standard and standard rate and a magenta 6 s heading trend vector that becomes an arrowhead above ~4°/s** **[search]**.
* GPS CDI auto-scaling (full-scale): **ENR 2.0 nm, OCN 2.0, TERM 1.0 (ramps 2.0→1.0 over 1 nm when within 31 nm of departure/destination), DPRT 0.3, APR 0.3 (ramps within 2 nm of the FAF; LNAV 1.0→350 ft, LPV 0.3), MAPR 0.3** **[search]**.
* AFCS status box "towards the top of the PFD, just below the Navigation Status Box"; **active modes green, armed modes white**; autopilot status on the left, lateral modes centre, vertical modes right; red for time-critical AFCS alerts **[search]**. Mode changes flash the annunciation for ~10 s; AP disconnect flashes red "AP" with a tone **[memory]**.
* GFC 700 limits (CAP training material, aircraft generic): **max commanded pitch +20°/−15°, bank 22°**; ROL mode rolls back to 22° if more; engagement 70–165 KIAS (DA40 supplement) **[search]**.

### 2.2 PFD layout (design units, origin top-left, 1024×768)

```
y=  0  ┌────────────────────────────────────────────────────────────────┐
       │ NAV1 117.95 ↔ 115.80  │  NAV STATUS BOX (D→ KHAF  DIS 12.3nm │ COM1 120.500 ↔ 121.800 │  h=42
y= 42  │ NAV2 ...              │  BRG 213° ETE 00:07)  ─ AFCS BOX  ...│ COM2 ...               │  h=28  (AFCS: AP  | HDG NAV | ALT 3500FT  — y 42..70)
y= 70  ├──────────┬────────────────────────────────────────────┬────────┤
       │ AIRSPEED │            ATTITUDE INDICATOR               │ ALTITUDE│
       │  TAPE    │   sky #0A5CFF→#1E7BFF, ground #8B5A2B→#6E4423│  TAPE   │
       │ x 60-150 │   horizon line white 2px; pitch ladder      │ x 836-  │
       │ (w 90)   │   ±(viewport) ; FD single-cue magenta       │   926   │
       │          │   roll scale radius 300 centred (512,330)   │ (w 90)  │  VSI x 930-980
y=600  ├──────────┴───────────────┬──────────────┬──────────────┴────────┤
       │  (inset map 230×190 opt.)│   HSI Ø 300  │  wind box, OAT, timer │
       │                          │ centre(512,  │  XPDR 1200 ALT  UTC   │
       │                          │   590)       │                       │
y=738  ├─────────────────────────────────────────────────────────────────┤
       │  12 softkeys 85×30: [INSET][ ][PFD][OBS][CDI][ADF/DME][XPDR][IDENT][TMR/REF][NRST][ALERTS]  │
y=768  └─────────────────────────────────────────────────────────────────┘
```

Element rules:
* Airspeed tape: x 60–150, y 110–560 ⇒ 450 px for 60 kt ⇒ **7.5 px/kt**; current-speed window 86×46 at the midline with 24 px bold digits, last digit as a rolling drum; red "Vne" band from 163 up; low-speed red band below Vs1 when airborne (G1000 shows a red/white barber pole at Vs… **[memory]**); trend line 6 px wide magenta from midline to `v + 6·v̇`; TAS text under tape "TAS 112KT".
* Altitude tape: x 836–926, y 110–560 ⇒ 450 px for 600 ft ⇒ **0.75 px/ft**; window 90×52, hundreds in 24 px, tens as a drum; selected altitude box above (cyan digits), baro "29.92 IN" below (cyan), trend vector magenta on the left edge; minimums bug (BARO MIN) cyan-white.
* VSI: x 930–980, scale ±2 000 fpm over 300 px (±150 px, 0.075 px/fpm), pointer with digits when |vs| > 100 fpm; selected VS bug when in VS mode.
* Attitude: pitch ladder scale **4.0 px/°** (so 10° = 40 px; the visible ladder spans ±~45° within the 500×450 area); horizon rotates about (512, 330); roll pointer triangle at radius 300; slip/skid bar 36×8 px under it, displacement = ball × 18 px; chevrons at ≥50° up / ≥30° down; FD single-cue inverted V magenta (Cessna Nav III uses single cue), aircraft symbol yellow wedge + wingtips; "AP" disengage: hide FD unless FD on.
* HSI: Ø 300 at (512, 590) (overlaps the attitude area bottom by design — G1000 does this); compass card rotates `−heading`; heading bug cyan notch; course pointer and CDI bar in source colour; 2 dots each side at 26 px spacing (dot Ø 8); TO/FROM triangle; "HDG 270°" cyan box upper-left of HSI, "CRS 283°" magenta/green upper-right; turn-rate scale above the card (ticks at ±half-standard = 1.5°/s and ±standard = 3°/s, drawn as the heading change in 6 s → ±9° and ±18° of arc; magenta trend vector to `heading + 6·r`, arrowhead when |r| > 4°/s); bearing pointers BRG1/BRG2 cyan with info fields at the HSI's lower corners; wind vector box left of HSI (Option 1: arrow + speed; Option 2: head/cross components); DME window.
* Nav/Com frequencies top: active in white (NAV in green when identing? no — active frequency white, standby cyan/blue tuned field); NAV ident shown left ("SFO") when decoded.
* Colours (approximations of the real palette — Garmin does not publish them **[memory]**): sky `#1565D8`, ground `#7A4A1D`, cyan `#00FFFF` (selected/bug values: heading bug, selected altitude, baro, BRG pointers), magenta `#FF00FF` (GPS course/CDI, FD bars, trend vectors), green `#00FF00` (VOR/LOC, active AP modes, normal ranges), white `#FFFFFF` (armed modes, scales, text), yellow `#FFFF00` (caution, aircraft symbol), red `#FF0000` (warnings, Vne, chevrons), grey tape background `rgba(0,0,0,0.55)`, softkey background `#1C1C1C` with white 14 px labels.
* Fonts: Garmin's typeface is proprietary (MSFS ships "A1000.ttf" internally) **[search]**. Use an OFL-licensed condensed sans with tabular figures: **Roboto Condensed** (tapes, labels), **Roboto Mono** or **Oxanium** for the large numeric windows; set `font-variant-numeric: tabular-nums` equivalents by measuring digit width once and drawing digits at fixed advances (canvas has no tabular-nums). Sizes at 1024×768: softkeys 14 px, tape labels 16 px bold, windows 24–28 px bold, AFCS box 15 px, nav/com 18 px.

### 2.3 MFD layout

* Left engine strip (EIS) 150 px wide for the 172S: **RPM** arc gauge (0–3 000, green 2 100–2 700, red 2 700) with digital RPM; **FFLOW GPH** (0–20); **OIL PRES** (0–115, green 50–90, reds 20/115); **OIL TEMP** (100–245 green); **EGT** bar with lean-assist page (peak marker, ΔT); **FUEL QTY GAL** L/R horizontal bars 0–26 with red < 1.5, yellow < 5 (**[memory]** for yellow); **ENG HRS**; **VOLTS** M/E bus; **AMPS** M/S batt; **ENGINE / LEAN / SYSTEM** softkeys. Numbers per POH markings in §1.3.
* Map area 870×650: north-up or track-up moving map, range ring and range label (0.5–2 000 nm steps 0.5,0.75,1,1.5,2,3,4,5,7.5,10,15,20,25,30,40,50,75,100…), aircraft symbol, flight plan legs magenta (active) / white, airports (runway-shaped icons at ≤ 15 nm, circles beyond), VOR/NDB symbols, terrain shading optional (use the same elevation tiles as doc 03 at zoom 8–10, coloured by AGL: red < 100 ft, yellow < 1 000 ft), topo colours otherwise, cities/roads not needed in v1. Data fields on top: GS, DTK, TRK, ETE.
* Right/bottom windows: active flight plan (FPL) list, Nearest (NRST) pages, Direct-to dialog, PROC (Select Approach: runway → ILS/visual; v1 has synthetic ILS so "ILS RWY xx" for every eligible runway).
* Softkeys: `ENGINE  [ ]  MAP  DCLTR  SHW CHRT  CHKLIST  [ ]` (chart pages out of scope).

### 2.4 Bezel controls (keyboard/mouse mapping)

Knobs (hover + wheel; shift = ×10 or outer ring): NAV (inner kHz 0.05, outer MHz) + swap, COM (inner 25/8.33 kHz, outer MHz) + swap, HDG (push = sync to heading), ALT (outer 1 000 ft, inner 100 ft), CRS/BARO (CRS inner 1°, push = centre; BARO outer 0.01 inHg), RANGE joystick (map pan + range), FMS knob (outer field, inner character). Keys: D→, FPL, PROC, MENU, CLR, ENT, AP, FD, HDG, ALT, NAV, VNV, APR, BC, VS, FLC, NOSE UP/DN, CWS (yoke). Keyboard defaults from doc 01 §15.4.

Direct-to flow: D→ → identifier entry (FMS knobs or typed) → ENT → "ACTIVATE?" ENT; sets `gps.activeLeg = {from: present position, to: wpt}`, CDI auto-switches to GPS if "AUTO" selected.

---

## 3. Rendering approach in Three.js (r0.187)

### 3.1 Options compared

| Approach | Pros | Cons | Cost per frame (1024×768 display) |
|---|---|---|---|
| **A. 2D canvas → `CanvasTexture` on panel mesh** | Full Canvas2D toolbox (text, arcs, clipping), one draw path for cockpit and pop-out, perspective-correct in 3D, reflections/glare possible | Upload cost (`texImage2D` of 3.1 MB RGBA), browser-dependent readback cost (Firefox/Safari slow: a 2K canvas fell from 60 → 28 fps when uploaded every frame **[search]**), text can blur under minification without anisotropy | ≈ 0.5–1.5 ms on Chrome desktop at 30 Hz; 2–5 ms on Firefox/Safari **[search + memory]** |
| **B. HTML overlay (DOM/SVG/CSS)** | Free, crisp, accessible, easy styling and layout; perfect for HUD/toolbar/panels | Not inside the 3D scene: no perspective, no occlusion by yoke/hands, no reflections; mixing DOM with WebGL for the *cockpit* looks like a game from 2005 | ~0 GPU |
| **C. Vector geometry in Three.js (meshes + SDF text, e.g. `troika-three-text`, MIT) rendered to a `WebGLRenderTarget` or directly** | Zero texture upload; resolution-independent; GPU-only; can be instanced | Every gauge element is a mesh: much more code; text via SDF only; clipping tapes needs stencil or `clippingPlanes`; harder to get "pixel-perfect Garmin" look | < 0.3 ms |
| **D. Static dial textures + needle sub-meshes (steam gauges)** | No per-frame upload at all; crisp at any zoom with mipmaps + anisotropy; trivially cheap | Only works for pointer/drum gauges (that is all steam gauges are) | ~0 |

Decision: **D for steam gauges, A for the G1000 displays, B for everything that is 2D UI**, and keep C as the optimisation path if A profiles badly (e.g. Safari on an M1 Air). This is also what MSFS does conceptually (its glass instruments are HTML/JS rendered to textures).

### 3.2 CanvasTexture details that matter

```ts
const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 768;
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })!;
const tex = new THREE.CanvasTexture(canvas);
tex.colorSpace = THREE.SRGBColorSpace;      // r152+ API; keeps the Garmin palette as drawn
tex.generateMipmaps = false;                // otherwise every upload also builds 10 mip levels
tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
tex.anisotropy = renderer.capabilities.getMaxAnisotropy(); // crisp tape text at oblique angles
tex.flipY = true;                            // default for Canvas; keep UVs standard
const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }); // self-lit screen, bypass ACES
// per frame:
if (display.dirty && now - display.lastDraw >= 1000/display.hz) { display.draw(ctx, readings); tex.needsUpdate = true; }
```

* `toneMapped: false` + an emissive-like `MeshBasicMaterial` so the screen is not darkened by the scene's tone mapping/exposure; add a second transparent plane with a glass-reflection texture (`MeshPhysicalMaterial`, `transmission`) only on high settings.
* Draw at a **fixed 1024×768** regardless of device pixel ratio; the cockpit camera rarely shows the PFD larger than ~700 px wide. Offer a "pop-out" (MSFS: right-alt+click) that simply appends the same `<canvas>` (or a second context fed by the same draw function at 2× size) to the DOM.
* Update rate: PFD 30 Hz (attitude at 30 Hz looks fine on a texture seen in perspective; smooth the attitude input with the render timestep so 30 Hz redraws do not stutter), MFD 15 Hz, engine strip 10 Hz. Skip the upload if nothing changed (parked, AP steady) — compare a hash of the quantised readings.
* `desynchronized: true` and `alpha: false` avoid compositing copies on Chrome. `OffscreenCanvas` in a Worker (`transferControlToOffscreen`) is possible but the texture upload still happens on the main thread via `ImageBitmap`; not worth it for v1 **[search: suggested, unmeasured]**.
* Anti-aliasing: Canvas2D is anti-aliased; draw hairlines at `x + 0.5`; snap tape tick positions to integer pixels; use `ctx.save()/clip()` for the tapes; avoid `shadowBlur` (very slow). For needles in approach D use `MeshBasicMaterial` with `polygonOffset` so they sit above the dial, and enable MSAA (`antialias: true` on the renderer, or SMAA pass) — thin needles alias badly otherwise.
* Fonts: load WOFF2 via CSS `@font-face` and `document.fonts.load('bold 24px "Roboto Condensed"')` before the first draw, or the canvas falls back to a default font on the first frames.
* Night: multiply the drawn frame by a dimmer (`ctx.globalCompositeOperation = 'multiply'` with a grey fill) or pass `uniform float dim` in a custom shader; cockpit flood/post lights are scene lights on the panel mesh, not on the screen (screens are emissive).

### 3.3 Steam gauge meshes

Per gauge: bezel (shared geometry), dial plane with a 512×512 texture (baked from SVG at build time, so arcs/labels are exact), needle(s) as separate meshes with pivot at the hub; drum counters (altimeter 10 000-ft pointer, Hobbs) as cylinders with digit textures. Per frame: `needle.rotation.z = map(reading)`; nothing else. Glass: a slightly convex transparent disc with an environment-map reflection (`envMapIntensity 0.3`) sells the look. Backlighting: emissive dial texture with `emissiveIntensity` tied to the panel-light rheostat.

---

## 4. Navigation radios and GPS

### 4.1 Geodesy helpers (sphere, R = 6 371 008.8 m)

```ts
const R = 6371008.8, D2R = Math.PI/180, NM = 1852;
export function distanceM(a: LatLon, b: LatLon): number {     // haversine
  const φ1=a.lat*D2R, φ2=b.lat*D2R, dφ=(b.lat-a.lat)*D2R, dλ=(b.lon-a.lon)*D2R;
  const h = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
export function initialBearingDeg(a: LatLon, b: LatLon): number {
  const φ1=a.lat*D2R, φ2=b.lat*D2R, dλ=(b.lon-a.lon)*D2R;
  const y = Math.sin(dλ)*Math.cos(φ2), x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(dλ);
  return (Math.atan2(y,x)/D2R + 360) % 360;
}
export function destination(a: LatLon, brgDeg: number, distM: number): LatLon {
  const δ=distM/R, θ=brgDeg*D2R, φ1=a.lat*D2R, λ1=a.lon*D2R;
  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1), Math.cos(δ) - Math.sin(φ1)*Math.sin(φ2));
  return { lat: φ2/D2R, lon: ((λ2/D2R + 540) % 360) - 180 };
}
/** cross-track (m, +right of course) and along-track distance from leg start for leg A->B at point P */
export function xtkAtd(A: LatLon, B: LatLon, P: LatLon) {
  const d13 = distanceM(A,P)/R, θ13 = initialBearingDeg(A,P)*D2R, θ12 = initialBearingDeg(A,B)*D2R;
  const xtk = Math.asin(Math.sin(d13)*Math.sin(θ13-θ12)) * R;
  const atd = Math.acos(Math.cos(d13)/Math.cos(xtk/R)) * R;
  return { xtkM: xtk, atdM: atd };
}
export const wrap180 = (d: number) => ((d + 540) % 360) - 180;
```

Test vectors **[computed here]**: KSFO ARP (37.6199, −122.3748) → KOAK ARP (37.7201, −122.2212): 9.459 nm, bearing 050.5° T; KSFO → KSEA (47.4479, −122.3103): 590.09 nm, 000.3° T; KSFO → LOWI (47.2602, 11.3440): 5 139.2 nm, 029.5° T.

Local-frame shortcut: within ~100 km of the FDM origin use the flat-earth NED position from doc 02 (`north = Δlat·R`, `east = Δlon·R·cos(lat0)`) for navaid relative vectors; it is faster and consistent with the terrain placement.

### 4.2 Magnetic variation

* Use the **WMM2025** spherical-harmonic model (degree 12, 13×13 `g`, `h`, `ġ`, `ḣ` tables). The npm package [`magvar` 2.0.0](https://registry.npmjs.org/magvar/2.0.0) (MIT, 48 KB unpacked, repo `dpyeates/magvar`) implements exactly this and its test suite checks the official WMM2025 test values to 0.1° **[verified: tarball read]**. Either depend on it or port the ~120-line function to TypeScript (recommended: port, because the package computes "today" with `getDay()` — a weekday — instead of `getDate()` **[verified bug]**, and we want a deterministic sim date).
* Algorithm (from `magvar.js` **[verified]**): geodetic → geocentric (a = 6 378.137 km, b = 6 356.7523142 km, r0 = 6 371.2 km), Schmidt semi-normalised Legendre recursion, secular variation `g = g0 + (t − 2025.0)·ġ`, field components `X = −Bθ·cosψ − Br·sinψ`, `Y = Bφ`, **declination `D = atan2(Y, X)`**. Cost ≈ 20 µs; cache per 0.25° cell.
* Values for 2026-11-02 **[computed with the package]**: KSFO 12.79° E, KSEA 14.83° E, KTRK 12.74° E, KASE 8.37° E, LOWI 4.26° E, EGLL 1.11° E, YSSY 12.85° E. Doc 03's "≈ 13.0° E" for KSFO is consistent.
* **Do not** use OurAirports `magnetic_variation_deg` for present-day variation: SFO VOR-DME shows 14.423 (an older epoch) and `slaved_variation_deg` = 17.001 is the VOR's *station declination* (the value the station's radials are aligned to) **[verified in navaids.csv]**. Use `slaved_variation_deg` where present for VOR radials (§4.3), WMM for everything else.
* Constant-per-region fallback (offline/first frame): the seven values above, nearest-neighbour; worst case error ~1–2° inside a 500 nm region.

### 4.3 VOR

Facts (AIM 1-1-3/1-1-8 **[memory]** + FlightGear `navradio.cxx` **[verified]**): 108.00–117.95 MHz (ILS localizers occupy the odd-tenth channels 108.10–111.95); full-scale CDI = **±10°** (2 dots × 5° on an HSI, 5 dots × 2° on a GNS/mechanical CDI); TO/FROM flips across the ±90° abeam line; cone of confusion overhead; standard service volumes — **T: 25 nm, 1 000–12 000 ft AGL; L: 40 nm, 1 000–18 000 ft; H: 40 nm (1 000–14 500), 100 nm (14 500–18 000), 130 nm (18 000–45 000), 100 nm (45 000–60 000)**; the new VOR-MON classes **VL (70 nm above 5 000 ft) and VH (130 nm)** **[search]**. OurAirports `power` LOW/MEDIUM/HIGH maps reasonably to T/L/H (use 25/40/130 nm) **[memory: mapping assumption]**.

```ts
function updateVor(rx: NavRadioState, st: Navaid, ac: LatLon, altFt: number, dt: number) {
  const distM = distanceM(st, ac);
  const brgStationToAcTrue = initialBearingDeg(st, ac);
  const twist = st.slavedVariationDeg ?? declinationDeg(st.lat, st.lon);   // station declination
  const radialMag = wrap360(brgStationToAcTrue - twist);                   // the radial we are ON
  const r = wrap180(rx.obsDeg - radialMag);                                // course - radial
  const from = Math.abs(r) <= 90;                                          // FROM if OBS ~ radial
  let dev = from ? r : wrap180(r - 180);                                   // degrees, + = course is right of us (fly right)
  dev = -dev;                                                               // sign convention: + => needle right
  const range = serviceVolumeNm(st, altFt - st.elevFt) * 1.3;             // FG: 1.3× published
  const q = distM/NM < range ? 1 : 1/((distM/NM)/range)**2;                // signal quality
  rx.inRange = q > 0.2;
  rx.cone = distM < Math.max(300, (altFt - st.elevFt) * 0.3048 * Math.tan(50*D2R)); // ~±50° cone overhead
  rx.cdiDeg = rx.inRange && !rx.cone ? clamp(dev, -10, 10) * q : 0;       // -10..10 degrees
  rx.cdiDots = rx.cdiDeg / 5;                                              // HSI 2-dot scale
  rx.toFrom = rx.inRange && !rx.cone ? (from ? 'FROM' : 'TO') : 'OFF';
  rx.radialDeg = radialMag; rx.distanceNm = distM / NM;                    // DME slant below
  rx.identAudio = rx.inRange && rx.identOn;                                // Morse 1020 Hz, 7 wpm, every ~10 s
}
```

Flag logic: the needle "centres" when `|dev| < 10°` either side of both the course and its reciprocal — exactly like the real thing (OBS 90° off the radial gives full deflection with an ambiguous flag). Worked example **[computed]**: SFO VOR (37.6195, −122.374) to an aircraft at (37.74, −122.22): true bearing 045.3°, radial with 13.1° E variation ≈ 032°, 10.3 nm. FG's false-course behaviour (sawtooth) is not needed.

### 4.4 ILS: localizer, glideslope, markers

Geometry (AIM 1-1-9 **[memory]**, FlightGear **[verified]**, numbers cross-checked by search **[search]**):
* Localizer: 108.10–111.95 MHz odd tenths; antenna on the extended centreline **~1 000 ft beyond the stop end**; course width "tailored" so full-scale (±2 dots, ±150 µA) = **700 ft total at the threshold**, within the allowed **3°–6°** total; usable 18 nm within ±10°, 10 nm within ±35° **[memory]**; a back course exists (reverse sensing unless BC mode). Computed widths **[computed]**: KSFO 28R (11 870 ft) → 2·atan(350/(11 870+1 000)) = 3.12°; KTRK 11 (7 001 ft) → 5.01°; LOWI 08 (6 562 ft) → 5.30°; KHAF 12 (5 000 ft) → 6.68° → clamp to 6.0°.
* Glideslope: paired UHF 329.15–335.00 MHz (tune with the LOC frequency); antenna **750–1 250 ft from the approach end, 250–650 ft lateral offset**; nominal **3.0°**, full-scale **±0.7°** (total 1.4°), 0.35°/dot on a 2-dot scale, 0.14° on a 5-dot scale **[search]**; false glideslopes at 6° (reverse) and 9° above; threshold crossing height ≈ 1 000 ft × tan 3° = 52 ft **[computed]**; 3° descent rate ≈ GS(kt) × 5.3 fpm (90 kt → 478 fpm) **[computed]**.
* Marker beacons (75 MHz, vertical cone): **OM 4–7 nm** from threshold, 400 Hz, continuous dashes (2/s), **blue** lamp; **MM ~3 500 ft** (0.5–0.8 nm), 1 300 Hz, alternating dot-dash, **amber**; **IM** at Cat II DH, 3 000 Hz, dots (6/s), **white** **[search + memory]**. FG reception: in range if horizontal distance `< 2.4·Δh` (cone) and Δh < 4 000 ft **[verified]**.

Synthesising an ILS from `runways.csv` (needed because OurAirports has no ILS rows **[verified]**): for each eligible runway end `le/he` with `*_latitude_deg`, `*_heading_degT`, `*_displaced_threshold_ft`:

```ts
const thr = displaced > 0 ? destination(end, hdgT, displaced*FT) : end;      // landing threshold
const far = oppositeEnd;                                                    // other end record
const loc = destination(far, hdgT, 1000*FT);                                // LOC antenna 1000 ft past stop end
const widthDeg = clamp(2*atan(350 / (lengthFt + 1000)) * R2D, 3, 6);
const gsAnt = offsetLateral(destination(thr, hdgT, 1000*FT), hdgT + 90, 400*FT); // 1000 ft in, 400 ft right
const gsAngle = 3.0; const freqMHz = pickOddTenth(hash(ident, rwy));         // deterministic 108.10..111.95
const ident = 'I' + last3(airportIdent);                                     // e.g. I-SFO (real idents differ)
```
Replace with real data when the FAA NASR CSVs (public domain, 28-day cycle, group "ILS") are imported; the ILS CSV column names were not verifiable here **[search: README exists per cycle]**.

Receiver model (per frame):

```ts
function updateIls(rx, ils, acPos, acAltM) {
  // localizer: angle between the runway course and the bearing from the LOC antenna to the aircraft
  const brgFromLoc = initialBearingDeg(ils.loc, acPos);
  const off = wrap180(brgFromLoc - (ils.courseTrue + 180));   // 0 when on centreline on the approach side
  const frontCourse = Math.abs(off) < 90;
  const sens = 20 / ils.widthDeg;                              // scale so that widthDeg/2 => 10 "deg-units" (FG)
  let dev = (frontCourse ? -off : wrap180(off - 180)) * sens;  // deg-units, + = fly right
  if (!frontCourse) dev = -dev;                                // back course reverse sensing
  if (rx.backCourseMode) dev = -dev;
  rx.locDots = clamp(dev, -10, 10) / 5;                        // ±2 dots
  rx.locInRange = distNm(ils.loc, acPos) < (Math.abs(off) < 10 ? 18 : Math.abs(off) < 35 ? 10 : 0) * 1.3;
  // glideslope: elevation angle seen from the GS antenna, measured along the approach axis
  const d = alongTrackFromGsAntenna(ils, acPos);               // metres toward the approach side
  const h = acAltM - ils.gsAntennaAltM;
  const elev = Math.atan2(h, d) * R2D;                         // ~3.0 when on path
  let gsErr = ils.gsAngleDeg - elev;                           // + = we are below => fly up
  if (gsErr < 0 && rx.falseGs) gsErr = 1.5 * sawtooth(gsErr / 1.5); // false GS at 6° (reverse), 9°
  rx.gsDots = clamp(gsErr, -0.7, 0.7) / 0.35;                  // ±2 dots
  rx.gsInRange = rx.locInRange && d > 0 && distNm(ils.gsAntenna, acPos) < 10;
  // markers
  rx.marker = nearestMarker(acPos, acAltM, ils) // 'O' | 'M' | 'I' | null using the 2.4·Δh cone
}
```

Note the sign convention: `locDots > 0` means the course is to the right → fly right. In APR mode the autopilot consumes `locDots`, `gsDots` and the course.

### 4.5 DME

Slant range `sqrt(ground² + Δh²)` from the DME antenna (`dme_latitude_deg` only populated on 225 of 4 081 DME-equipped rows **[verified]** → fall back to the navaid position); radio-horizon range `1.23·sqrt(Δh_ft)` nm clamped to [20, published] **[FG verified]**; display 0.1 nm resolution below 100 nm; ground speed = `−d(slant)/dt` smoothed 2 s (reads ~0 overhead — a real DME quirk), ETE = dist/speed. Paired channel from `dme_channel` (e.g. "105X") is cosmetic. DME ident 1 350 Hz Morse every 30 s (VOR ident 1 020 Hz three times, DME once) **[memory]**.

### 4.6 GPS (G1000-like)

* Position: truth plus 2 m noise (irrelevant); RAIM/loss-of-integrity optional failure.
* Direct-to and flight plan: legs are great circles (`xtkAtd`); CDI full-scale by phase as in §2.1 (ENR 2.0 nm … APR 0.3 nm); `cdiDots = clamp(xtk / fullScale, −1, 1) × 2`; DTK = initial bearing from leg start (recomputed from present position for D→), TRK from `FDMOutputs.track`, BRG/DIS to active waypoint, ETE = DIS/GS, ETA.
* Sequencing (fly-by): turn radius `R_t = V²/(g·tan φ)` with φ = 25° (G1000 default is 22–25° **[memory]**): at 110 KTAS (56.6 m/s) → 687 m = 0.37 nm; anticipation distance `R_t·tan(Δtrack/2)`; sequence when along-track distance to the waypoint ≤ anticipation (or the waypoint is abeam for > 90° turns); fly-over for the missed-approach point and holds. Turn anticipation shows as a "TURN TO 283°" annunciation 10 s before.
* OBS mode: freezes sequencing and lets the pilot pick a course to the waypoint (GPS behaves like a VOR with linear scaling).
* Approach: load "ILS RWY xx" = our synthetic ILS; GPS CDI goes to APR scale 2 nm before the FAF (we place a pseudo-FAF 5 nm from threshold on the final course); CDI auto-switches GPS → LOC when the localizer is alive and within 1.2 nm of the FAF ("LOC" message) **[memory]**.
* Nearest page: query the airport spatial grid (doc 03 §11 shards) for the 25 closest with runway ≥ 1 500 ft.

### 4.7 ADF/NDB (optional)

190–535 kHz (OurAirports: 6 609 NDB + 137 NDB-DME rows; a few `−1` placeholder frequencies **[verified]**). Relative bearing `RB = wrap180(bearingTrue(ac → ndb) − ψ_true)`; needle = RB on a fixed card (or MH + RB on a rotating card); range by `power` (LOW 25, MEDIUM 50, HIGH 75 nm), needle wander ±(2 + 10·(1−q))° at a 0.3 Hz random walk, "dip" in turns ≈ φ·0.2, and night effect noise beyond 50 nm. Ident Morse at 1 020 Hz (400 Hz modulation) continuous.

### 4.8 Radio stack behaviours

NAV: active/standby, swap, 50 kHz steps, auto-ident decode after 3 s in range; COM 25 kHz (8.33 kHz optional, `airport-frequencies.csv` has 3 decimals); audio panel: NAV1/NAV2/DME/MKR/ADF selectors and MKR sensitivity HI/LO; transponder codes with VFR 1200 (7000 in Europe), IDENT 18 s flash; COM tuned frequency decides which ATC "controller" hears us (§9).

---

## 5. Autopilot and flight director

### 5.1 What the real units do (to decide what to emulate)

* **KAP 140** (steam 172S/172R): two-axis, **rate-based** — roll commands come from the turn coordinator, pitch from an internal pressure transducer + accelerometer (it does not know pitch attitude) **[search]**. Modes ROL (default), HDG, NAV, APR, REV, VS (default pitch), ALT, GS; ARM for altitude pre-select; UP/DN change the VS target (100 fpm per press **[memory]**); altitude alerter beeps 1 000 ft before the preselected altitude and when deviating ±200 ft after capture (FlightGear implements exactly these bands, 1000/200 ft, and stops the tone after 2 s) **[verified: kap140-proprules.xml]**; HDG toggles ROL↔HDG, ALT toggles VS↔ALT **[search]**. FlightGear's c172p implementation (GPL) **[verified: kap140-autopilot.xml]**: target turn rate = f(heading error) clamped ±0.9 standard-rate units (2.7°/s) and slewed at 0.2 /s; roll PI on turn-rate error `Kp −0.08, Ti 3.5 s, Td 0.15 s`, aileron authority ±0.25, aileron rate limit 0.085 /s; NAV intercept angle = `12.5°·needle_deflection` (±45°) + integral 0.05 (±5°) + derivative; vertical: pressure rate → VS (`−58 000 fpm per inHg/s`), altitude capture `3 625 fpm per inHg` of altitude-pressure error clamped ±400 fpm, VS target slewed 200 fpm/s, G/S PID `Kp −400 fpm per needle unit, Ti 20 s`, VS limits −1 200/+50 fpm on the glideslope; VS → normal acceleration PI `Kp −0.00015 g/fpm, Ki −0.000011`, ±0.1 g; g → elevator PI `Kp 0.16/g, Ti 0.5 s`, elevator authority ±0.25, rate 0.0769 /s; auto-trim when |elevator| > 0.025 for a few seconds; servo-torque monitors disconnect the AP. Excellent reference for *behaviour*; too twitchy to tune blind.
* **GFC 700** (Nav III G1000): attitude-based (AHRS), FD + AP + optional yaw damper; lateral ROL, HDG, NAV (GPS/VOR/LOC), APR (LOC + GS, or GPS LPV GP), BC, LVL; vertical PIT, ALT, VS, FLC, ALTS/ALTV arming, GS/GP, VNV (we skip VNAV); limits bank 22°, pitch +20°/−15°, roll-rate limited; engage 70–165 KIAS (DA40 figure; the 172 is probably 70/160 — verify) **[search]**. Single-cue FD on Cessnas. Annunciations: green active / white armed, flashing on change ~10 s; AP disconnect: red flashing "AP" + 2-tone aural; "PTRM" trim warnings.
* **JSBSim `c172ap.xml`** (LGPL, reference for an attitude-based structure) **[verified: fetched]**: wing leveller PID on φ `kp 50, ki 5, kd 17` (per rad → aileron norm); heading hold: heading error clipped ±30° → bank command 1:1 (0.01745 rad/°) → lag 0.5 s → roll PID `kp 6, ki 0.13, kd 6`; altitude hold: error clipped ±100 ft → lag 1 s → `ḣ_cmd = 0.12 ft/s per ft` (SL, scheduled to 0.028 at 12 000 ft) → ḣ error → PID `kp 0.01, ki 0.00015, kd 0.0003` → elevator ±1 with anti-windup trigger when elevator saturates (deadband ±23°).

### 5.2 Our design: attitude-based cascade (recommended)

```
 lateral mode ──► roll command φ_c (limit ±25°, ±22° APR, rate ≤ 5°/s) ──► roll loop ──► aileron (±0.5)
   HDG : φ_c = Kψ·wrap180(ψ_sel − ψ)                      Kψ = 1.0 °/°, i.e. 20° off → 20° bank
   NAV : ψ_c = course + intercept(xtk or cdi) ; then as HDG using TRACK error (wind-corrected)
   APR : as NAV with LOC gains; GS armed → captures vertical
   ROL : φ_c = φ at engage (|φ| < 6° → 0)   LVL: φ_c = 0, θ_c = 0 (blue button)
 vertical mode ──► VS command ḣ_c ──► pitch command θ_c (limit +15°/−10°) ──► pitch loop ──► elevator (±0.5) + autotrim
   ALT : ḣ_c = clamp(Kh·(h_sel − h), ±1 000 fpm)          Kh = 8 fpm/ft (100 ft → 800 fpm)
   VS  : ḣ_c = ḣ_sel (±1 500 fpm, 100 fpm steps)
   FLC : θ_c from airspeed error (see below), climb or descend decided by ḣ sign allowed
   GS  : ḣ_c = ḣ_path + Kgs·gsDots      ḣ_path = −GS_fpm·tan(3°)
   PIT : θ_c = θ at engage (NOSE UP/DN ±0.5° steps)
```

Inner loops (all in degrees / deg·s⁻¹ / normalised surface; run at the FDM rate, 100–200 Hz):

```ts
// roll: aileron = Kp(φc − φ) + Ki∫(φc − φ) − Kd·p
const ROLL = { Kp: 0.025, Ki: 0.004, Kd: 0.010, out: 0.5, rate: 1.0, iLim: 0.15 };
// pitch: elevator = Kp(θc − θ) + Ki∫(θc − θ) − Kd·q  (+ sign so nose-up error → elevator up (negative in FDM, apply sign))
const PITCH = { Kp: 0.045, Ki: 0.010, Kd: 0.020, out: 0.5, rate: 1.0, iLim: 0.20 };
// VS → pitch: θc = θ_trim + Kvs(ḣc − ḣ) + Kivs∫,  θ_trim = current θ at mode engage (bumpless)
const VS2PITCH = { Kvs: 0.006 /* deg per fpm: 500 fpm error -> 3° */, Ki: 0.0008, lim: [-10, 15], rate: 2 /*deg/s*/ };
// FLC: θc = θ_trim − Kias(IASc − IAS) − Kiias∫ ; fast-climb protection: θc ≤ θ for IAS < IASc − 5
const FLC = { Kias: 0.4 /* deg per kt */, Ki: 0.02, lim: [-10, 15], rate: 1.5 };
// NAV intercept (GPS): ψ_c = DTK + clamp(Kx·xtk_nm, ±45°) with Kx = 60°/nm en route, 120°/nm terminal, 300°/nm approach
// LOC: ψ_c = course + clamp(Kloc·locDots·distFactor, ±30°), Kloc = 12°/dot (×0.5 inside 2 nm), + integral 0.05°/s per dot
// GS: Kgs = 350 fpm/dot, ḣ_c ∈ [−1 500, +200] fpm, GS capture when |gsDots| < 0.5 and LOC captured
```

Why these magnitudes: a C172 rolls at ~20°/s with full aileron and the AP servo has roughly half authority, so `Kp 0.025/deg` gives full servo authority at 20° bank error and a 1.5–2 s time constant; `Kd 0.010 per deg/s` damps the roll mode (τ_roll ≈ 0.6 s for the 172, doc 02 §2.3). In pitch the 172's short period is ~3 rad/s, well damped; `Kp 0.045/deg` with `Kd 0.02` gives ~5 s pitch capture without overshoot. JSBSim's `kp 6/rad = 0.105/deg` for roll is 4× hotter and relies on its 0.5 s lag; start from ours and tune with the step tests in §5.5. All gains are per *normalised* surface; they scale with `qbar` in reality, so multiply `Kp` by `(100 kt / IAS)²` clamped to [0.5, 2] (gain scheduling) to keep the loops uniform from 70 to 160 kt.

### 5.3 Anti-windup, bumpless transfer, limits

* Integrators use **clamping + back-calculation**: `i += Ki·e·dt; if (|u_unsat| > out) i −= (u_unsat − u_sat)·dt/Tt` with `Tt = 1 s`; integrators are limited to `iLim` and **reset on mode change** and on AP disengage.
* Bumpless engage: on AP/FD engage set `φ_c = φ`, `θ_trim = θ`, `ḣ_sel = round(ḣ, 100)`, `h_sel` unchanged, and seed integrators with the current surface deflection (so no step). On mode switch, seed the new outer loop at the current command (ALT→VS: `ḣ_sel = current ḣ`).
* Rate limits: `φ_c` 5°/s, `θ_c` 2°/s, surfaces 1.0 /s (servo); surface authority ±0.5 (pilot can always override: add stick directly, and disconnect AP when |stick| > 0.6 for 0.5 s — CWS-like).
* Altitude capture (ALTS armed): capture when `|h_sel − h| ≤ max(50 ft, ḣ²/(2·a_cap))` with `a_cap = 0.05 g = 96 fpm/s` → 1 000 fpm captures 86 ft out; use 1.3× margin **[computed]**. Alerter: tone + flashing selected altitude at 1 000 ft before and ±200 ft deviation (KAP 140 bands) **[verified FG]**.
* Autotrim: when the AP holds |elevator| > 0.03 for > 2 s, move trim at 0.02 /s in the relieving direction (keeps the servo centred; on disconnect the aircraft stays trimmed — the "AP OFF" lurch is small, like the real aircraft).
* Protections (GFC 700 has none in the 172; MSFS "assist" does): optional envelope: disconnect AP with "AP OFF" if IAS < 60 or > 160 KIAS, |φ| > 45°, |θ| > 30°, |nz| > 2.5 g (FG uses servo-force and g monitors).

### 5.4 Mode logic (state machine)

```
Lateral: ROL | HDG | NAV(arm→act) | APR(arm→act) | BC | LVL
Vertical: PIT | VS | ALT | FLC | GS(arm→act) ; ALTS always armed when h_sel ≠ h and mode ∈ {VS, FLC, PIT}
Events: AP toggle, FD toggle, HDG, NAV, APR, ALT, VS, FLC, NOSE UP/DN, LVL, CWS, knob changes, GA (go-around: wings level + 7° nose up, FD only)
Rules: pressing an active mode's key reverts to default (lateral ROL, vertical PIT); NAV arms until |cdi| < 1 dot (GPS: 1 nm xtk & closing), then captures;
       APR arms LOC (as NAV) and GS; GS captures from below when |gsDots| < 0.5 after LOC capture; ALT pressed = hold current altitude (rounded 10 ft);
       LVL overrides everything (blue button) — AP on, wings level, zero VS; AP disconnect keeps FD modes.
Annunciation: status box text, green active, white armed, flash 10 s on change; "AP" red flashing 5 s + tone on disconnect.
```

### 5.5 Flight director command bars

`FD.φ = lowpass(φ_c, 0.5 s)`, `FD.θ = lowpass(θ_c, 0.5 s)`; single-cue bars are drawn as an inverted V at `(θ_FD − θ)·pxPerDeg` vertically and rotated by `(φ_FD − φ)` relative to the aircraft wedge, so flying the wedge into the bars zeros both errors. With AP off the FD still runs the outer loops (modes) — the pilot is the inner loop. Validation steps (headless): HDG 90° step at 110 kt: bank reaches 25° in ~4 s, heading settles within ±2° with < 5% overshoot in < 60 s; ALT +1 000 ft from level: VS 1 000 fpm within 10 s, capture with < 30 ft overshoot; APR: LOC capture from a 30° intercept at 8 nm without oscillation, GS tracking within 0.3 dot in 10 kt gusts.

---

## 6. HUD overlay (external views) and MSFS-like toolbar

* **Flight info strip** (MSFS: top-centre when outside the cockpit, doc 01 §7.3): `IAS 112 KT | ALT 3 500 FT | HDG 283° | VS +500 | WIND 280/10 ↗ | THR 75% | FLAPS 10 | GEAR | TRIM` plus "AP" and mode letters when engaged; rendered as a DOM flexbox with `font-variant-numeric: tabular-nums`, 14–16 px, dark translucent pill; update via `requestAnimationFrame` but write text only when the quantised value changes (DOM writes are the cost).
* **Assist overlays**: landing path gates (3D meshes in the scene, not HUD), route ribbon, taxi ribbon (blue), POI labels (DOM labels projected with `Vector3.project` → CSS `transform: translate3d`, hidden when behind the camera/occluded by depth test against a low-res depth read is unnecessary; use terrain line-of-sight only).
* **Toolbar** (mouse-to-top reveal, 48 px icons, tooltips): ATC · Camera · Checklist · Basic Controls · AI Control · Fuel & Payload · Nav Log · Objectives · Travel To · VFR Map · Weather · (Replay) · Settings. Each opens a draggable, resizable panel (`position: fixed`, pointer events captured; pass-through to the sim canvas when clicking outside). Keyboard: `Scroll Lock` opens ATC; the remaining panel keys follow doc 01 §15.6.
* **VFR map**: our own 2D canvas slippy map using the imagery/terrain tiles from doc 03 (same provider abstraction), overlays: airports (OurAirports shards), navaids, route, aircraft, range rings; drag/zoom; click an airport → info/"Travel to".
* **Checklist panel**: list with checkbox per item, "eye" button that focuses the camera on the control's hit-box and highlights it (doc 01 §5.1), "auto-complete" toggles that execute the item (sets the switch). Content in §8 as JSON.
* **ATC panel**: numbered options (1–9 keys), transcript with subtitles bottom-left even when the panel is closed, frequency header, "AI radio comms" auto-reply toggle. Content in §9.
* Layering: `#webgl` (z 0) → `#hud` (z 10, `pointer-events: none`) → `#toolbar/#panels` (z 20) → `#modal` (z 30). All UI uses CSS `env()`-safe 16 px gutters and scales with `--ui-scale`.

---

## 7. Data sources (navaids, airports, frequencies) — verified this session

OurAirports daily dumps (public domain; docs at `https://ourairports.com/data/`). Canonical URLs are on GitHub Pages (`https://davidmegginson.github.io/ourairports-data/<file>.csv`, blocked from this container but documented in the repo README **[verified]**); the same files are served from `https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/<file>.csv` with **`access-control-allow-origin: *`**, `cache-control: max-age=300`, `content-type: text/plain` **[verified 2026-11-02]**. Note `frequencies.csv` does not exist; the file is **`airport-frequencies.csv`** **[verified 404 vs 200]**.

| File | Size | Rows | Header (exact) |
|---|---|---|---|
| `navaids.csv` | 1 524 931 B | 11 008 | `id,filename,ident,name,type,frequency_khz,latitude_deg,longitude_deg,elevation_ft,iso_country,dme_frequency_khz,dme_channel,dme_latitude_deg,dme_longitude_deg,dme_elevation_ft,slaved_variation_deg,magnetic_variation_deg,usageType,power,associated_airport` |
| `airports.csv` | 12 755 750 B | 86 330 | `id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,iso_country,iso_region,municipality,scheduled_service,icao_code,iata_code,gps_code,local_code,home_link,wikipedia_link,keywords` |
| `runways.csv` | 3 973 691 B | 48 405 | `id,airport_ref,airport_ident,length_ft,width_ft,surface,lighted,closed,le_ident,le_latitude_deg,le_longitude_deg,le_elevation_ft,le_heading_degT,le_displaced_threshold_ft,he_ident,he_latitude_deg,he_longitude_deg,he_elevation_ft,he_heading_degT,he_displaced_threshold_ft` |
| `airport-frequencies.csv` | 1 302 359 B | 30 390 | `id,airport_ref,airport_ident,type,description,frequency_mhz` |

`navaids.csv` facts **[verified by script]**: types NDB 6 609, VOR-DME 2 601, VORTAC 744, TACAN 442, VOR 308, DME 167, NDB-DME 137 — **no ILS/LOC/GS/marker rows**; `frequency_khz` is in kHz (116 800 = 116.80 MHz; NDB 190–1 290; some `−1` placeholders; one VOR-DME row has 11 495 — treat < 100 000 for VHF types as bad); `usageType` ∈ {BOTH 6 318, TERMINAL 2 578, LO 1 866, RNAV 176, HI 43, blank 27}; `power` ∈ {HIGH 3 889, LOW 3 627, MEDIUM 3 461, blank/UNKNOWN 31}; `magnetic_variation_deg` on 11 000 rows (epoch unknown — do not use for today), `slaved_variation_deg` on 3 205 rows (station declination; use for VOR radials); `dme_channel` on 4 084, DME coordinates only on 225; `elevation_ft` on 7 165 (fill from terrain tiles when blank); `associated_airport` on 7 375; **idents are not unique** (6 022 distinct of 11 008, e.g. "SAU" is Sausalito US, Sauveterre FR and Siauliai LT) — key by `id`, search by ident + nearest. Example: `93531,"San_Francisco_VOR-DME_US","SFO","San Francisco","VOR-DME",115800,37.6195,-122.374,13,"US",115800,"105X",,,,17.001,14.423,"BOTH","MEDIUM","KSFO"`.

`airport-frequencies.csv` `type` values seen at KSFO **[verified]**: `APP, ATIS, AWOS, CLD, DEP, GND, MISC, TWR, UNIC` (+ `CTAF`, `ARCAL`, `AFIS`, `RDO` elsewhere); KSFO: TWR 120.5, GND 121.8, CLD 118.2, ATIS 113.7 (note: an ATIS on a VOR frequency — real), NORCAL APP 128.325/133.95/134.5, DEP 120.9/135.1, UNICOM 122.95.

Build pipeline (`scripts/build-navdata.mjs`, Node 22, no deps; run in CI monthly together with doc 03's airports build):
1. Fetch the four CSVs (Pages URL, fall back to raw GitHub); parse with a 40-line RFC-4180 parser (fields contain commas and quotes).
2. `navaids.json`: VHF navaids only (VOR, VOR-DME, VORTAC, DME, TACAN → 4 262 rows) with `{id, ident, name, type, freqMHz, lat, lon, elevFt, country, dmeChannel, stationDecl, usage, power, airport}`; ≈ 420 KB raw / ~110 KB gzipped. NDBs as a separate optional file (~500 KB).
3. `ils.json`: synthesised per §4.4 from `runways.csv` joined to `airports.csv` type ∈ {large, medium} and surface ∈ {ASP, ASPH, CON, CONC, PEM, BIT}, `closed = 0`, length ≥ 4 000 ft → ~6 000 runway ends; ≈ 700 KB → shard by 10° cell with airports.
4. `frequencies/<cell>.json`: grouped by `airport_ident`, type normalised to `ATIS|AWOS|CLD|GND|TWR|APP|DEP|CTAF|UNIC|FSS|MISC`.
5. Keep `id` as the stable key; emit a `meta.json` with the dump date and row counts; fail CI if any file shrinks by > 5 % (upstream glitch guard).

US-only extras (all public domain): FAA NASR 28-day CSV (ILS, airspace, fixes/airways), FAA CIFP (ARINC-424 procedures) — stretch goals for real approaches. X-Plane's `earth_nav.dat` (gateway.x-plane.com) has worldwide ILS but its licence (GPL/free-for-sim use) must be checked before bundling **[memory, verify]**.

---

## 8. Cessna 172S checklists (POH Section 4, condensed; wording paraphrased **[memory]** — POH mirrors such as the [UD 172S checklist](https://www.dbq.edu/media/Academics/Aviation/Forms/Cessna-172S---Normal-and-Emergency-Checklists.pdf) and [LIA C172S](https://longislandaviators.com/wp-content/uploads/2024/10/LIA-C172S-CHECKLIST.pdf) were unreachable here; the 172R Section 4 mag-check limits are confirmed **[search]**)

Store as JSON `{phase, items: [{text, response, control?: hitboxId, autoAction?: () => void, check?: () => boolean}]}` so the toolbar checklist can highlight and auto-complete.

| Phase | Items (text — response) |
|---|---|
| **Before starting engine** | Preflight inspection — COMPLETE · Passenger briefing — COMPLETE · Seats, belts, harnesses — ADJUST & LOCK · Brakes — TEST & SET · Circuit breakers — CHECK IN · Electrical equipment — OFF · Avionics (BUS 1 & 2) — OFF · Fuel selector — BOTH · Fuel shutoff valve — ON (push full in) |
| **Starting engine** (fuel injected) | Throttle — OPEN ¼ in · Mixture — IDLE CUT-OFF · Propeller area — CLEAR · Master (ALT & BAT) — ON · Beacon — ON · Aux fuel pump — ON · Mixture — FULL RICH until fuel flow stable 3–5 s, then IDLE CUT-OFF · Aux fuel pump — OFF · Ignition — START (release when engine fires) · Mixture — ADVANCE smoothly to RICH when engine fires · Oil pressure — CHECK (rise within 30 s, 60 s cold) · Nav lights — ON as required · Avionics (BUS 1 & 2) — ON · Radios — ON · Flaps — RETRACT |
| **Before taxi / taxi** | Taxi light — ON · Brakes — CHECK on roll · Flight instruments — CHECK (TC, AI, HI turning correctly) · Autopilot — OFF |
| **Before takeoff (run-up)** | Parking brake — SET · Seats, belts — CHECK · Cabin doors — CLOSED & LATCHED · Flight controls — FREE & CORRECT · Flight instruments — CHECK & SET (altimeter QNH, HI to compass, HDG bug) · Fuel quantity — CHECK · Mixture — RICH (lean above 3 000 ft DA) · Fuel selector — BOTH · Throttle — 1 800 RPM · Magnetos — CHECK (drop ≤ 150 RPM each, ≤ 50 RPM differential) · Vacuum gauge — CHECK (4.5–5.5 in Hg) [steam] / Engine indications — CHECK green [G1000] · Ammeter/volts — CHECK · Throttle — 1 000 RPM or less · Throttle friction — ADJUST · Radios/avionics — SET (COM, NAV, XPDR ALT) · Autopilot — OFF · Elevator trim — SET for takeoff · Flaps — 0–10° · Strobes — ON · Brakes — RELEASE |
| **Normal takeoff** | Flaps — 0–10° · Throttle — FULL OPEN · Mixture — RICH (above 3 000 ft lean for max RPM) · Elevator — LIFT NOSE WHEEL at 55 KIAS · Climb — 70–80 KIAS · Flaps — RETRACT after obstacles |
| **Short-field takeoff** | Flaps — 10° · Brakes — HOLD · Throttle — FULL · Brakes — RELEASE · Rotate — 51 KIAS · Climb — 56 KIAS until obstacles cleared · Flaps — RETRACT after 60 KIAS |
| **Enroute climb** | Airspeed — 70–85 KIAS (Vy 74) · Throttle — FULL · Mixture — RICH below 3 000 ft, lean for max RPM above |
| **Cruise** | Power — 2 100–2 700 RPM (≤ 80 %) · Elevator trim — ADJUST · Mixture — LEAN (lean-assist / 50 °F rich of peak) · Fuel — monitor, BOTH |
| **Descent** | Power — AS DESIRED · Mixture — ADJUST (enrich as altitude decreases) · Altimeter — SET QNH · Fuel selector — BOTH · Flaps — AS DESIRED (0–10° ≤ 110 KIAS, 10–30° ≤ 85 KIAS) |
| **Before landing** | Seat backs — UPRIGHT · Seats, belts — SECURE · Fuel selector — BOTH · Mixture — RICH · Landing/taxi lights — ON · Autopilot — OFF |
| **Normal landing** | Airspeed — 65–75 KIAS flaps up · Flaps — AS DESIRED · Airspeed — 60–70 KIAS flaps FULL · Trim — ADJUST · Touchdown — MAIN WHEELS FIRST · Landing roll — LOWER NOSE WHEEL GENTLY · Braking — MINIMUM REQUIRED (short field: 61 KIAS, flaps FULL, brakes heavy, flaps retract) |
| **Balked landing** | Throttle — FULL OPEN · Flaps — RETRACT to 20° · Climb — 55 KIAS · Flaps — 10°, then UP above 60 KIAS/clear of obstacles |
| **After landing** | Flaps — UP · Strobes — OFF · Landing light — OFF · Transponder — GND/STBY · Mixture — LEAN for taxi |
| **Securing airplane** | Parking brake — SET · Avionics — OFF · Electrical equipment, autopilot — OFF · Mixture — IDLE CUT-OFF (pull full out) · Ignition — OFF · Master — OFF · Control lock — INSTALL · Fuel selector — LEFT or RIGHT (prevents cross-feeding) · Chocks/tie-downs — INSTALL |

Emergency (for the Assistance menu): engine failure in flight — airspeed 68 KIAS (best glide), fuel shutoff ON, selector BOTH, aux pump ON, mixture RICH, ignition BOTH (START if prop stopped); engine fire on start — continue cranking, mixture cut-off, throttle full, fuel shutoff OFF.

---

## 9. ATC: scripted controllers with Web Speech voices

### 9.1 Scope and structure

MSFS flow (doc 01 §8): ATIS → (Clearance) → Ground → Tower → Departure → Centre/flight following → Approach → Tower → Ground. Model each airport as a set of **controller roles** backed by `airport-frequencies.csv`: `ATIS/AWOS`, `CLD`, `GND`, `TWR`, `APP/DEP` (merged as "Radar"), `CTAF/UNIC` (uncontrolled: self-announce, no replies). Controlled if the airport has a `TWR` frequency. One global "Center" when > 30 nm from any towered field.

State machine per flight (events in brackets): `PARKED` —[request taxi]→ `TAXI` (ribbon to the active runway hold-short) —[report ready]→ `HOLD_SHORT` —[cleared]→ `TAKEOFF` —[airborne + 1 nm]→ `DEPARTURE` (handoff to Radar) —[> 10 nm or request]→ `ENROUTE` (flight following optional, altitude/traffic calls) —[within 25 nm of destination]→ `APPROACH` (Radar: pattern entry/vectors; uncontrolled: CTAF) —[within 10 nm]→ `TOWER` —[on final ≤ 5 nm, runway clear]→ `CLEARED_TO_LAND` —[touchdown]→ `ROLLOUT` —[exit runway]→ `TAXI_IN` —[at parking]→ `PARKED`. Go-around if not cleared by 1 nm final or runway occupied (random 3 %).

Active runway: the runway end with the greatest headwind component `max_i cos(wind_dir − heading_i)·wind_speed`, tie → longest; calm (< 5 kt) → airport's preferred (longest) runway. Pattern side: left unless `runways.csv`/airport note says otherwise (no data; assume left). Pattern altitude: field elevation + 1 000 ft.

### 9.2 Phraseology templates (FAA style; AIM Chapter 4 §4-2/4-3 and the Pilot/Controller Glossary **[memory]**)

Spelling conventions: digits individually ("one two zero point niner"), "niner", altitudes in group form ("three thousand five hundred", "one zero thousand"), wind "two eight zero at one zero", altimeter "three zero one two", runway "two eight right", callsign full on first call then type + last three ("Skyhawk three alpha bravo"). Implement a `speakable(text)` that expands numbers and ICAO letters; keep a `display(text)` with normal numerals for subtitles.

```
ATIS   : "{airport} information {letter}, {time}Z. Wind {dir} at {spd}. Visibility {vis}. {sky}. Temperature {T}, dew point {Td}.
          Altimeter {QNH}. {ILS runway {rwy} approach in use.} Landing and departing runway {rwy}. Advise on initial contact you have {letter}."
GND req: P "{airport} Ground, {callsign}, {location} with information {letter}, VFR to {dest}, request taxi."
GND    : C "{cs}, {airport} Ground, runway {rwy}, taxi via {twys}{, hold short of runway {xrwy}}."   P readback: "Runway {rwy} via {twys}, hold short {xrwy}, {cs}."
TWR req: P "{airport} Tower, {cs}, holding short runway {rwy}, ready for departure{, request {left/right} downwind departure}."
TWR    : C "{cs}, {airport} Tower, wind {dir} at {spd}, runway {rwy}, cleared for takeoff{, fly runway heading | {turn} approved}."
          P "Runway {rwy}, cleared for takeoff, {cs}."       (or C "{cs}, hold short runway {rwy}, traffic on {n} mile final.")
Handoff: C "{cs}, contact {facility} {freq}."   P "{freq}, {cs}."
DEP    : P "{facility}, {cs}, {alt} climbing {target}."  C "{cs}, {facility}, radar contact, squawk {code}, proceed on course, VFR altitude your discretion."
          C "{cs}, traffic, {clock} o'clock, {n} miles, {direction}bound, {type}, {alt}." P "Looking for traffic, {cs}." / "Traffic in sight, {cs}."
Term   : C "{cs}, radar service terminated, squawk VFR, frequency change approved."  P "Squawk VFR, {cs}."
Inbound: P "{airport} Tower, {cs}, {n} miles {dir}, {alt}, inbound full stop with {letter}."
TWR    : C "{cs}, {airport} Tower, enter {left/right} {downwind|base} runway {rwy}, report {midfield|two mile final}."
Land   : C "{cs}, wind {dir} at {spd}, runway {rwy}, cleared to land." P "Runway {rwy} cleared to land, {cs}."
          C "{cs}, go around, fly runway heading, climb and maintain {alt}."   C "{cs}, cleared touch and go runway {rwy}." / "cleared for the option"
Exit   : C "{cs}, turn {left/right} {twy}, contact Ground {freq}."  GND: "{cs}, taxi to {parking} via {twys}."
CTAF   : P "{airport} traffic, {cs}, {n} miles {dir}, inbound, will enter {left} downwind runway {rwy}, {airport}." ; "...turning base runway {rwy}..." ; "...clear of runway {rwy}..."
Emerg  : P "Mayday mayday mayday, {cs}, engine failure, {position}, {alt}, {souls} souls on board." C "{cs}, roger mayday, {nearest airport} {dir} {n} miles, wind..., say intentions."
```

Taxi routing: without taxiway data (OSM `aeroway=taxiway` via doc 03 §7 is optional), route along the apron edge to the runway's hold-short point and name it "via alpha"; render the blue ribbon.

### 9.3 Voice: Web Speech API

* Support **[verified: caniuse `speech-synthesis.json`]**: Chrome ≥ 33 (current 156–159 "y" with note 2), Edge, Firefox 49+ (current 159–162 "y"), Safari 7+ (26.6–27.x "y"), iOS Safari, Android Chrome. Note 2: *"Speech Synthesis in Chrome since version 55 stops playback after about 15 seconds on Windows 7 & 10, and Ubuntu 14.04"* — still listed. Workarounds **[search]**: keep utterances short (< ~200 characters; split transmissions at sentence boundaries and queue them), and on desktop Chrome call `speechSynthesis.pause(); speechSynthesis.resume()` every 10 s while speaking (not on Android/Edge voices, where it breaks playback).
* Voices load asynchronously: call `getVoices()` and listen to `voiceschanged`; pick `lang.startsWith('en')`, prefer `localService` voices (lower latency, no 15 s bug reports), assign a distinct voice per role (Ground/Tower/Radar/ATIS) and per aircraft (pilot read-backs in a different voice) — at least 2 voices; vary `rate` 1.05–1.25 (ATC cadence) and `pitch` 0.9–1.1 per controller; ATIS `rate 1.0`.
* Autoplay policy: the first `speak()` must follow a user gesture (click/keypress) — arm the ATC voice on the first toolbar click; `cancel()` before a new transmission from the same role; fall back to text-only when `!('speechSynthesis' in window)`.
* "Radio" effect: TTS output cannot be routed through WebAudio, so bracket each transmission with a squelch-open click (10 ms noise burst, band-pass 300–3 000 Hz) and squelch-tail, and mix a faint pink-noise bed on the COM channel while a transmission is active; duck the engine audio by 3 dB. If true filtering is wanted later, a WASM TTS (e.g. Piper via onnxruntime-web, MIT; ~20 MB voices) yields PCM you can filter — out of scope for v1.
* Timing: controller reply latency 1.5–4 s random; "AI radio comms" auto-selects the correct option after 2 s and speaks the read-back; subtitles stay 6 s (ATIS loops).

---

## 10. TypeScript interfaces

```ts
// ---------- instruments ----------
export interface PitotStaticState {
  pitotBlocked: boolean; pitotDrainBlocked: boolean; staticBlocked: boolean; alternateStatic: boolean; pitotHeat: boolean;
  qcFrozenPa?: number; psFrozenPa?: number;
}
export interface GyroState { spin: number /*0..1*/; powered: boolean; driftDeg: number; tumble: number }

export interface InstrumentReadings {
  // six pack
  iasKt: number; tasKt: number; casKt: number;
  attitude: { pitchDeg: number; rollDeg: number; valid: boolean; flag: boolean };
  altimeter: { indicatedFt: number; pressureAltFt: number; settingInHg: number; settingHPa: number; modeCFt: number };
  turn: { rateStd: number /* 1 = 3°/s */; ballWidths: number /* -1.5..1.5 */ };
  heading: { dgDeg: number; bugDeg: number; bugErrorDeg: number; compassDeg: number; magVarDeg: number };
  vsiFpm: number;
  // engine & systems
  rpm: number; mapInHg?: number; fuelFlowGph: number; oilTempF: number; oilPressPsi: number; egtF: number; chtF?: number;
  fuelGal: [number, number]; suctionInHg: number; ampsA: number; voltsV: number; oatC: number;
  flapsDeg: number; trimNorm: number; hobbsHours: number; tachHours: number;
  annunciators: { lowVolts: boolean; lowFuelL: boolean; lowFuelR: boolean; oilPress: boolean; vacuum: boolean; pitotHeatOff: boolean; stallWarn: boolean };
  // trend/derivatives used by glass displays
  iasTrendKtPer6s: number; altTrendFtPer6s: number; headingTrendDegPer6s: number;
}

export interface InstrumentConfig {
  asiLagS: number; altimeterLagS: number; vsiLagS: number; ballLagS: number;
  gyro: { spinUpS: number; spinDownS: number; minVacuumInHg: number; dgDriftDegPerMin: number; aiMaxRollErrDeg: number; aiMaxPitchErrDeg: number };
  positionError: { flapsDeg: number; kias: Float64Array; kcas: Float64Array }[];
  compassDeviationDeg: Float64Array; // 12 entries, every 30°
}
export interface Instruments {
  config: InstrumentConfig; pitotStatic: PitotStaticState; gyros: { ai: GyroState; dg: GyroState; tc: GyroState };
  setAltimeter(inHg: number): void; setHeadingBug(deg: number): void; alignDG(): void; cageAI(c: boolean): void;
  update(dt: number, fdm: FDMOutputs, state: FDMState, env: Environment, electrical: ElectricalState): InstrumentReadings;
}

// ---------- navigation ----------
export interface LatLon { lat: number; lon: number }
export type NavaidType = 'VOR' | 'VOR-DME' | 'VORTAC' | 'DME' | 'TACAN' | 'NDB' | 'NDB-DME';
export interface Navaid extends LatLon { id: number; ident: string; name: string; type: NavaidType; freqMHz: number; elevFt: number;
  dmeChannel?: string; stationDeclDeg?: number; rangeNm: number; airport?: string }
export interface Ils extends LatLon { id: string; ident: string; airport: string; runway: string; freqMHz: number; courseTrueDeg: number;
  loc: LatLon; widthDeg: number; gsAntenna: LatLon & { altM: number }; gsAngleDeg: number; thresholdAltM: number; markers?: { type: 'O'|'M'|'I'; pos: LatLon }[]; synthetic: boolean }

export interface NavRadioState {
  index: 1 | 2;
  activeMHz: number; standbyMHz: number; obsDeg: number;                      // tuned & course
  station?: Navaid | Ils; isLoc: boolean; ident?: string; identAudio: boolean;
  inRange: boolean; signalQuality: number; flag: 'TO' | 'FROM' | 'OFF';
  cdiDots: number;            // -2..+2 (+ = course to the right, fly right)
  cdiDeg?: number;            // VOR only, -10..10
  radialDeg?: number;         // VOR radial the aircraft is on (magnetic)
  gs: { available: boolean; inRange: boolean; dots: number /* -2..+2, + = fly up */ };
  dme: { available: boolean; inRange: boolean; distanceNm: number; groundSpeedKt: number; eteMin: number; hold: boolean };
  backCourse: boolean; marker: 'O' | 'M' | 'I' | null;
}
export type GpsPhase = 'OCN' | 'ENR' | 'TERM' | 'DPRT' | 'APR' | 'MAPR';
export interface GpsLeg { from: LatLon & { ident?: string }; to: LatLon & { ident: string }; dtkDeg: number; distNm: number; flyOver?: boolean }
export interface GpsState {
  position: LatLon; altFt: number; groundSpeedKt: number; trackDeg: number;
  flightPlan: GpsLeg[]; activeLegIndex: number; directTo?: GpsLeg; obsMode: boolean; obsCourseDeg?: number;
  phase: GpsPhase; fullScaleNm: number; xtkNm: number; cdiDots: number; dtkDeg: number; brgDeg: number; disNm: number; eteS: number;
  turnAnticipation?: { toTrackDeg: number; inS: number }; cdiSource: 'GPS' | 'NAV1' | 'NAV2'; autoCdiSwitch: boolean;
}
export interface AdfState { freqKHz: number; station?: Navaid; inRange: boolean; relativeBearingDeg: number; bfo: boolean; identAudio: boolean }
export interface ComRadioState { index: 1 | 2; activeMHz: number; standbyMHz: number; spacing: 25 | 8.33; receiving: boolean; transmitting: boolean; volume: number }
export interface TransponderState { code: number; mode: 'OFF' | 'STBY' | 'ON' | 'ALT' | 'GND'; ident: boolean; identUntil: number }

// ---------- autopilot / flight director ----------
export type LateralMode = 'ROL' | 'HDG' | 'NAV' | 'APR' | 'BC' | 'LVL';
export type VerticalMode = 'PIT' | 'VS' | 'ALT' | 'FLC' | 'GS' | 'GP' | 'GA';
export interface AutopilotTargets { headingDeg: number; altitudeFt: number; vsFpm: number; iasKt: number; courseDeg: number; pitchDeg: number; rollDeg: number }
export interface AutopilotLimits { bankDeg: number; bankAprDeg: number; pitchUpDeg: number; pitchDownDeg: number; rollRateDegS: number; pitchRateDegS: number;
  servoAuthority: number; servoRate: number; vsMaxFpm: number; iasMinKt: number; iasMaxKt: number; engageIasMinKt: number; engageIasMaxKt: number }
export interface PidGains { kp: number; ki: number; kd: number; iLim: number; out: number; tt: number }
export interface AutopilotGains { roll: PidGains; pitch: PidGains; vs2pitch: { k: number; ki: number }; flc: { k: number; ki: number };
  hdg2roll: number; altCaptureFpmPerFt: number; gpsInterceptDegPerNm: Record<GpsPhase, number>; locDegPerDot: number; gsFpmPerDot: number; qbarScheduling: boolean }
export interface AutopilotState {
  apEngaged: boolean; fdOn: boolean; ydOn?: boolean;
  lateral: LateralMode; lateralArmed?: LateralMode; vertical: VerticalMode; verticalArmed?: VerticalMode | 'ALTS' | 'ALTV';
  targets: AutopilotTargets;
  commands: { rollDeg: number; pitchDeg: number; vsFpm: number; aileron: number; elevator: number; trimRate: number }; // FD bars = rollDeg/pitchDeg
  annunciation: { flashUntil: number; disconnectUntil: number; altAlert: 'none' | '1000' | 'deviation'; messages: string[] };
  integrators: { roll: number; pitch: number; vs: number; flc: number; loc: number };
  lastModeChangeT: number;
}
export interface Autopilot {
  limits: AutopilotLimits; gains: AutopilotGains; state: AutopilotState;
  press(key: 'AP' | 'FD' | 'HDG' | 'NAV' | 'APR' | 'BC' | 'ALT' | 'VS' | 'FLC' | 'LVL' | 'NOSE_UP' | 'NOSE_DN' | 'CWS' | 'GA' | 'DISC'): void;
  setTarget<K extends keyof AutopilotTargets>(k: K, v: AutopilotTargets[K]): void;
  update(dt: number, fdm: FDMOutputs, state: FDMState, nav: { nav1: NavRadioState; nav2: NavRadioState; gps: GpsState }, pilot: FDMInputs): { aileron: number; elevator: number; trimRate: number };
}

// ---------- ATC ----------
export type AtcRole = 'ATIS' | 'CLD' | 'GND' | 'TWR' | 'RADAR' | 'CENTER' | 'CTAF';
export interface AtcOption { key: number; text: string; speak: string; next?: string }
export interface AtcState { phase: string; airport?: string; role: AtcRole; freqMHz: number; atisLetter: string; activeRunway: string; squawk: number;
  options: AtcOption[]; transcript: { t: number; from: 'ATC' | 'PILOT'; role: AtcRole; text: string }[]; autoReply: boolean; voiceReady: boolean }
```

---

## 11. Validation checklist for this module

1. Instrument lags: step the FDM vertical speed 0 → 500 fpm; VSI should show 316 fpm after 2.8 s and ≥ 475 fpm after 8.4 s (τ = 2.8 s). Altimeter after a 0.20 inHg setting change moves 184 ± 2 ft.
2. Gyros: cut vacuum at cruise; AI roll error grows to ~40° only after spin < 0.8 (≈ 36 s at τ_down 180 s), DG lags turns by seconds and then freezes; with power restored the AI re-erects in ≈ 4 s × (1 − spin).
3. Compass: fly a standard-rate turn through north at 15° bank, dip 61°: the card should lag/lead by ≈ 15–20° near N/S, with 5 s overshoot oscillation after rolling out.
4. VOR: from the §4.3 worked example the CDI must centre with OBS 032 FROM and 212 TO; flag OFF within the overhead cone; needle fades with q beyond 1.3× service volume.
5. ILS: on the KSFO 28R synthetic ILS (LOC width 3.12°), an aircraft 350 ft right of the centreline at the threshold reads exactly 2 dots (full scale); at 5 nm from the LOC antenna full scale corresponds to 2·tan(1.558°)·5 nm ≈ 1 650 ft total width; GS reads 2 dots at ±0.7°; descending on a 3° path at 90 kt ground speed gives ≈ 478 fpm.
6. GPS: KSFO → KOAK D→: DIS 9.46 nm, BRG 050° T (037° M with 12.8° E), ENR scaling 2.0 nm; TERM within 31 nm of KOAK ⇒ immediately 1.0 nm.
7. Autopilot step tests of §5.5; ALT capture overshoot < 30 ft; APR from 30° intercept.
8. Rendering: PFD redraw+upload ≤ 1.5 ms on Chrome/Intel Iris Xe at 30 Hz; ≤ 4 ms on Firefox; steam cockpit adds < 0.2 ms.
9. Web Speech: a 400-character ATIS plays to completion on Chrome/Windows (chunking + keep-alive); voices available after `voiceschanged`; nothing throws when `speechSynthesis` is absent.

## 12. Open questions / items to verify outside this container

* 172S POH Section 2 markings for the **suction gauge (4.5–5.5)**, **fuel-flow arc**, **tachometer arc (2 100–2 700)** and the Section 5 **airspeed calibration table** — only secondary sources reachable **[search/memory]**.
* GFC 700 numbers for the 172 specifically: **bank limit 22° vs 25°**, **VS range (±1 500?)**, **FLC range (70–160?)**, **engage 70/160 KIAS** — the CAP material says 22°, +20/−15 generically; the DA40 supplement says 70/165 **[search]**. Our defaults (25°, ±1 500 fpm, 70–160) are tunable constants.
* G1000 **altitude tape visible range (600 ft)** and **red low-speed band** specifics **[memory]**; exact Garmin colours (none published).
* OurAirports `power` → service volume mapping and the epoch of `magnetic_variation_deg` (unknown; do not use) **[verified it differs from WMM2025]**; whether GitHub Pages sends `access-control-allow-origin: *` (raw GitHub verified; Pages expected) **[doc 03 memory]**.
* AIM 1-1-9 marker distances/tones and GS antenna offsets are from memory and partially confirmed by secondary sources; markers are being decommissioned anyway.
* Licensing: FlightGear sources quoted here are **GPL-2** (behaviour/constants were used, no code copied — keep it that way or reimplement from the formulas above); `mag_compass.cxx` is explicitly public domain; `magvar` is MIT; JSBSim is LGPL-2.1 (constants only). X-Plane nav data licence unverified.
* Web Speech: whether the Chrome 15 s cut-off still reproduces on current Chrome (caniuse still carries the note) **[verified listing, behaviour unverified]**; Safari voice quality/latency on iOS.
* Three.js CanvasTexture upload cost on Safari/M-series and Firefox — profile the 1024×768 PFD at 30 Hz before committing to approach A; approach C (SDF text) is the fallback.

## 13. Source index

Verified in-session: OurAirports CSVs and README via `raw.githubusercontent.com/davidmegginson/ourairports-data/main/` (headers, sizes, CORS, row statistics); FlightGear `src/Instrumentation/{gyro,attitude_indicator,heading_indicator,turn_indicator,vertical_speed_indicator,altimeter,airspeed_indicator,slip_skid_ball,mag_compass,navradio,marker_beacon,dme}.cxx` via `raw.githubusercontent.com/FlightGear/flightgear/next/`; FlightGear c172p `Models/Interior/Panel/Instruments/kap140/{kap140-autopilot,kap140-proprules}.xml` via `raw.githubusercontent.com/c172p-team/c172p/master/`; JSBSim `aircraft/c172x/c172ap.xml` via `raw.githubusercontent.com/JSBSim-Team/jsbsim/master/`; npm `magvar@2.0.0` tarball (`registry.npmjs.org`); caniuse `features-json/speech-synthesis.json` (`raw.githubusercontent.com/Fyrd/caniuse/main/`). Search summaries (secondary): [Angle of Attack V-speeds](https://www.angleofattack.com/what-are-v-speeds/), [SE Oklahoma V-speed charts](https://www.se.edu/aviation/wp-content/uploads/sites/4/2023/10/V-Speed-Charts.pdf), [AirPlains STC supplement (markings)](https://txwg.cap.gov/media/cms/AFM_Suppl__STC_SA2196CE_AirPlains_C_21839006FDB25.pdf), [172R POH on ManualsLib (mag check, markings)](https://www.manualslib.com/manual/1447153/Cessna-172r.html?page=180), [G1000 Pilot's Guide excerpts on ManualsLib](https://www.manualslib.com/manual/1392149/Garmin-G1000.html?page=36), [Garmin AFCS status box web help](https://www8.garmin.com/manuals/webhelp/GUID-7317DC85-4516-4684-BBAF-FD7BE84D5E86/EN-US/GUID-6917A46E-A84B-41EE-86D0-EB979327E29D.html), [CAP GFC 700 training overview](https://www.gocivilairpatrol.com/media/cms/GFC_700_Training_Overview2_7C03137697E94.pdf), [CAP StanEval GFC700](https://www.gocivilairpatrol.com/media/cms/CAP_StanEval_May_2024_73124baeec1e6.pdf), [DA40 GFC 700 AFM supplement](https://static.garmincdn.com/pumac/G1000:DiamondDA40_40FLegacySysSWVersions_AirplaneFlightManualSupplement_GFC700AFCSDA40_DA40F_.pdf), [FlightGear KAP140 wiki](https://wiki.flightgear.org/Kap140), [Boldmethod ILS](https://www.boldmethod.com/learn-to-fly/systems/how-an-ils-works), [CFI Notebook ILS](https://cfinotebook.net/notebook/avionics-and-instruments/instrument-landing-system), [Wikipedia marker beacon](https://en.wikipedia.org/wiki/Marker_beacon), [FAA NAVAID service volumes briefing](https://www.faa.gov/air_traffic/flight_info/aeronav/acf/media/Briefings/NAVAID_Service_Volumes.pdf), [Pilot Institute VOR service volumes](https://pilotinstitute.com/types-of-vor-service-volumes/), [FAA NASR subscription](https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/2026-10-01), [three.js discourse: CanvasTexture per-frame cost](https://discourse.threejs.org/t/performance-issue-with-canvastexture-and-needsupdate-on-every-frame-lottieloader-use-case-scenario/50288), [three.js discourse: Firefox/Safari canvas upload](https://discourse.threejs.org/t/canvas-texture-update-cause-performance-issue-in-firefox-and-safari/7441), [Chrome 15 s TTS bug thread](https://github.com/phetsims/utterance-queue/issues/60), [dev.to cross-browser speech synthesis](https://dev.to/jankapunkt/cross-browser-speech-synthesis-the-hard-way-and-the-easy-way-353), [FlightSim handbook VSI lag](https://flightsimbooks.com/flightsimhandbook/CHAPTER_02_25_Vertical_Speed_Indicator.php), [Experimental Aircraft heading indicators](https://www.experimentalaircraft.info/articles/heading-indicators.php), [FlightGear FG1000 (display resolution)](https://wiki.flightgear.org/Project_Farmin/FG1000), [AVSIM G1000 font thread](https://www.avsim.com/forums/topic/584109-update-g1000-improved-v2/page/2/), [msfs-avionics-mirror](https://raw.githubusercontent.com/microsoft/msfs-avionics-mirror/main/README.md), [NAV CANADA VFR phraseology](https://www.navcanada.ca/en/vfr-phraseology.pdf), [FAA Safety common radio phrases](https://www.faasafety.gov/files/events/NM/NM09/2026/NM09141454/Common_Pilot-ATC_Radio_Phrases.pdf).
