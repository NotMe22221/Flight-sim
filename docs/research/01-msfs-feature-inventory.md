# 01 — MSFS Feature Inventory: what makes Microsoft Flight Simulator feel like MSFS, and what a web clone must copy

Status: research deliverable, 2026-11-02. Audience: architect + module owners of the Three.js/TypeScript/Vite browser flight sim.
Scope: Microsoft Flight Simulator 2020 (MSFS20) and 2024 (MSFS24). Out of scope here (covered by sibling docs): flight-dynamics equations, terrain/imagery data pipelines, avionics internals, audio, input hardware.

Research caveat: this container's proxy blocks almost every flight-sim site (forums.flightsimulator.com, docs.flightsimulator.com, flyawaysimulation.com, msfsaddons.com, wikipedia, gamesradar, pcgamer, gamepressure, fandom, avsim). Everything below comes from web-search summaries of those pages plus my own prior knowledge of the product. Items marked **[verify]** could not be confirmed from two independent sources and should be checked in-sim or in the SDK docs before anyone treats them as a spec. Items marked **[memory]** are from product knowledge only.

---

## 0. Executive summary: the eight pillars of the "MSFS feel"

Reviews and community discussion keep returning to the same things. A web clone that nails these eight will read as "MSFS-like" even with 1% of the content:

| # | Pillar | What MSFS does | Minimum for a web v1 |
|---|--------|----------------|----------------------|
| 1 | **Living sky** | Ray-marched volumetric clouds with multiple layers, physically based atmosphere, god rays, golden hour, Live Weather from Meteoblue, 9 named presets | Multi-layer volumetric-looking clouds (ray-marched or layered billboards), Hillaire/Bruneton-style sky, time-of-day slider, the 9 preset names and their coverages |
| 2 | **Real planet** | Bing Maps imagery + DEM + Blackshark.ai autogen buildings/trees, ~37k airports, photogrammetry cities streamed from Azure | Free imagery + DEM tiles streamed at runtime, OSM-derived buildings/trees near the player, real runway geometry for a handful of airports |
| 3 | **Approachable realism** | Modern surface-based flight model, but with "All Assists / Middle Ground / True to Life" presets and ~20 individual assists | 6-DOF model with per-surface lift/stall so wings drop asymmetrically; the three presets; auto-rudder, assisted landing path, anti-stall, auto-trim |
| 4 | **Clickable glass cockpit** | Every knob/switch hoverable; G1000 NXi / G3000 full implementations; interactive checklists with "eye" highlighting | C172 G1000-style PFD+MFD (HSI, tapes, map, direct-to, flight plan), a steam-gauge variant, hover tooltips, scroll-wheel knobs |
| 5 | **Cinematic cameras** | Cockpit (freelook + quickviews + instrument views), external chase, drone/showcase with DOF, smart camera, fixed cinematic cams | Cockpit + external chase + drone with the MSFS keys, smooth spring-damper transitions, saveable custom views |
| 6 | **World-map ritual** | Search any airport/city/POI, drop departure/arrival, choose runway or parking (cold & dark), route type, flight conditions, aircraft, then FLY | Same flow, ~2k airports searchable, runway vs parking spawn, weather/time panel, aircraft picker |
| 7 | **Low-friction procedures** | Menu-driven ATC (Scroll Lock), AI copilot, Travel-To, auto-start Ctrl+E, assisted checklists | Ctrl+E auto start, text ATC menu for taxi/takeoff/landing clearances, checklist panel |
| 8 | **Bite-sized goals** | Landing challenges (scored on centerline, smoothness, stopping distance), bush trips, lessons, 2024 career/challenge league | Landing-challenge mode with a leaderboard-style score card, 2–3 guided lessons |

Sources for the pillars: [Engadget on the Azure/Bing/Blackshark pipeline](https://www.engadget.com/flight-sim-interview-ces-2021-ai-photogrammetry-bing-224546632.html), [Windows Central launch coverage](https://www.windowscentral.com/microsoft-flight-simulator-2020-next-generation), [The Register review](https://www.theregister.com/2020/08/17/microsoft_flight_simulator_2020_review/), [OpenCritic aggregate 92 / 98% recommend](https://opencritic.com/game/9793/microsoft-flight-simulator), [MSFS Accessibility page (assist presets)](https://www.flightsimulator.com/accessibility/).

---

## 1. Flight model realism and assistance

### 1.1 Modern vs Legacy flight model

| Setting | MSFS behaviour | Source |
|---|---|---|
| **Legacy** | FSX-style: aircraft is a single force/moment vector driven by lookup tables ("if the aircraft is doing X, look up Y"). Kept for FSX-ported add-ons. | [FSElite Feature Discovery Ep.3](https://fselite.net/content/microsoft-flight-simulator-feature-discovery-series-episode-3-aerodynamics/), [Windows Central Ep.10](https://www.windowscentral.com/microsoft-flight-simulator-has-new-video-feature-discussing-aerodynamics-game) |
| **Modern** | Airframe is tessellated into hundreds–1000+ aerodynamic surfaces (Asobo quoted "1000"; one write-up says 1306), each with its own local airflow, lift, drag, stall. Surfaces stall independently so one wing can drop and a spin can develop. | same |
| **CFD (SU9/SU10, 2022; opt-in per aircraft)** | Optional CPU fluid solver: default 20×20×20 voxel grid around the aircraft, 100 Hz, 3 global passes per iteration. Prop wash hits fuselage/tail and modifies P-factor. | [SDK: Debug Aircraft CFD](https://docs.flightsimulator.com/msfs2024/html/2_DevMode/SimObject_Editor/Debug/Debug_Aircraft_CFD.htm) (blocked here; summary via search), [Stormbirds C172 test](https://stormbirds.blog/2022/04/30/testing-out-the-improved-cessna-172-flight-model-in-msfs/) |
| **Modern propeller** | `use_modern_surfaces` in `flight_model.cfg`: blade is sampled as moving surfaces; torque, P-factor, lift/drag derived from them instead of a point model. | [Forum "New Propeller / CFD / Soft body" list](https://forums.flightsimulator.com/t/new-propeller-cfd-soft-body-simulation-aircraft-list/504719) |
| **MSFS24 additions** | "10,000+ rigid-body surfaces", soft-body (cloth, ropes, balloons, pitot covers), deformable soft ground (snow/sand), per-tyre contact model, helicopter ground effect/VRS/translational lift. | [Steam store page](https://store.steampowered.com/app/2537590/Microsoft_Flight_Simulator_2024/), [MSFS Addons deep-dive](https://msfsaddons.com/2024/09/19/microsoft-flight-simulator-2024-fully-detailed-a-comprehensive-look-at-the-next-gen-sim/) |

Implication for us: a strip-theory / multi-panel model (N panels per wing, each with its own α, CL(α) with post-stall region, local velocity including roll/yaw rates, prop-wash and ground effect) is the cheapest way to get the two behaviours players notice: **asymmetric stall / wing drop** and **P-factor/torque yaw on takeoff**. The FDM doc should budget ≥ 8 spanwise panels per wing, 2 per horizontal tail half, 1–2 fin, 1 fuselage body, run at ≥ 120 Hz fixed step.

### 1.2 Assistance options (the actual MSFS menu)

Presets (MSFS20 and MSFS24): **All Assists**, **Middle Ground**, **True to Life**; each category is expandable for per-item tuning ([MSFS Accessibility](https://www.flightsimulator.com/accessibility/), [MSFS24 Accessibility](https://www.flightsimulator.com/accessibility-msfs-2024/)). Known gotcha: re-selecting a preset silently re-enables assists you turned off ([TheGamer settings guide](https://www.thegamer.com/microsoft-flight-simulator-2024-best-settings-explained-guide/)). Our settings UI must show the effective per-item state after a preset is chosen.

| Category | Option (MSFS name) | What it does | Web v1 implementation |
|---|---|---|---|
| Piloting | **Auto-Rudder** | Couples rudder to aileron; cancels P-factor/crosswind yaw on takeoff and landing; steers on ground ([linnetshowto](https://linnetshowto.com/how-to-enable-disable-auto-rudder-microsoft-flight-simulator-2024/)) | `rudderCmd = clamp(k_coord·aileronCmd − k_yaw·β − k_gnd·headingErr)` with k tuned so ball stays centred |
| Piloting | **Assisted Yoke** | Returns to level flight if the user lets go ([gamepressure realism](https://www.gamepressure.com/microsoft-flight-simulator/realism/z2d860)) | If abs(stick) < deadzone for > 1 s, blend in wing-leveller + pitch-hold |
| Piloting | **Assisted Takeoff** [verify exact name] | Manages rotation and initial climb | Pitch-rate limiter + auto-rotate at Vr |
| Piloting | **Assisted Landing** | Controls throttle, pitch, gear and flaps on final; also "steering assistance" | Glideslope+speed hold coupled to flare logic below ~50 ft AGL |
| Piloting | **Assisted Checklist** [verify] | Copilot performs checklist items | Checklist panel "auto-complete" button |
| Piloting | **AI Anti-Stall Protection** [memory] | Limits α so the aircraft cannot stall | α-limiter on elevator command |
| Piloting | **AI Auto-Trim** [memory] | Trims continuously | `trim += k·elevatorHold·dt` |
| Notifications | Flying tips, software tips, objectives, ATC messages [memory] | Toasts | Toast system with per-type toggles |
| Navigation aids | **Route & Waypoints** | 3D route ribbon and waypoint markers in the world | World-space polyline + billboards |
| Navigation aids | **Landing Path** | Floating gates on final + target speed ("these also indicate the proper velocity") | Rectangles every 0.25 nm on a 3° path to the threshold, colour = speed error |
| Navigation aids | **Taxi Ribbon** | Blue ribbon on taxiways to assigned runway/gate | Path on taxiway graph |
| Navigation aids | Landmark/city/airport/fauna/POI **markers**, **Smart Camera** | Screen-space labels; auto-aim camera | Screen-space labels with distance; camera target list |
| Failure & damage | **Crash Damage**, **Aircraft Stress Damage**, **Engine Stress Damage**, **Icing Effect** [memory] | Crash ends flight vs. ignore; over-G/over-speed damage; icing accretion | Crash detection with "restart/ignore"; VNE/G limits; icing = weight + CL penalty |
| Aircraft systems | **Gyro Drift**, **Unlimited Fuel** [memory] | Heading gyro precession; infinite fuel | Random-walk gyro error; fuel flag |
| User experience | **ATC voices** (Azure online vs Windows offline TTS), **ATC assistance / subtitles**, **AI Radio Communications** [memory] | Natural TTS when online; copilot answers ATC | Web Speech API TTS; "copilot handles radio" toggle |
| Visual helpers (MSFS24) | Landmark, city, airport, pre-flight-inspection markers; tow-plane assistance for gliders | | n/a for v1 |

Preset mapping to copy: *All Assists* = everything on; *Middle Ground* = auto-rudder on, assisted yoke off, landing path on, crash damage off, anti-stall off, markers on; *True to Life* = everything off, crash damage on, gyro drift on [memory; verify against in-sim defaults].

### 1.3 How the community describes the "feel" (and the design targets it implies)

Collected from [the long forum critique "All that is wrong with the MSFS flight model"](https://forums.flightsimulator.com/t/all-that-is-wrong-with-the-msfs-flight-model-inertia-stalling-pitch-authority-trim-sensitivity/379936), [a Steam stall thread](https://steamcommunity.com/app/1250410/discussions/4/3960307437816603414/), [The Register review](https://www.theregister.com/2020/08/17/microsoft_flight_simulator_2020_review/), [AVSIM MSFS24 dynamics thread](https://www.avsim.com/forums/topic/654326-msfs-2024-flight-dynamics-and-groundwater-handling-thread/), [TechRadar MSFS24 review](https://www.techradar.com/gaming/microsoft-flight-simulator-2024-review), [Stormbirds "state of the sim"](https://stormbirds.blog/2025/01/03/state-of-the-sim-how-is-microsoft-flight-simulator-2024-right-now-buy-it-now-or-wait/):

| What players praise | What players complain about | Design target for our FDM | Acceptance test |
|---|---|---|---|
| "Delightfully authentic", smooth, light GA aircraft "pretty good" | — | Smooth, damped response; no jitter | 60 Hz render, FDM ≥ 120 Hz fixed step with interpolation; no visible stepping on trim changes |
| Independent-wing stall exists in principle | Default aircraft "won't reach an accelerated stall", no wing drop, no rudder needed in C152 stall, "will start descent instead of stalling while holding full back stick" | Post-stall CL curve must actually be reached at full aft stick at 1 g and in a 60° bank; wing drop from small asymmetry (slip, prop-wash, turbulence) | At 1 g, full aft elevator from 1.3 Vs produces buffet (shake) within 3 s and a nose/wing drop; in a 2-g turn the stall occurs at √2·Vs ± 5% |
| — | Control-surface deflection appears to scale with speed so full elevator at high speed is weak; "pitch authority" too low | Model hinge-moment–limited deflection only if we also model the pilot force limit; otherwise full deflection at all speeds with correct q-scaling of moments | 250 kt full-elevator produces ≥ limit-load g within 1 s |
| — | Trim rate accelerates the longer you hold the key ("real electric trim is constant rate") | Constant trim rate: full travel in T_trim seconds (C172 electric trim ≈ 10–15 s [verify]), no acceleration | Hold trim key 5 s → exactly 5/T_trim of travel |
| — | "Inertia": aircraft feels like it rotates about its CG with no momentum; attitude changes too crisp | Correct moments of inertia from published Ixx/Iyy/Izz; rate damping from surfaces, not an artificial damper | Release stick in a 30° bank → roll rate decays, not snaps |
| MSFS24 ground handling "much more inertia/momentum", aircraft rocks on its gear with engine running | MSFS20 ground handling "awful"/"shopping carts"; crosswind landings "utterly broken"; excessive grip; abrupt static→kinetic friction; weak weathervaning | Per-tyre Pacejka-lite side force with static/kinetic blend, oleo spring-damper with visible rock, nosewheel steering with speed-dependent authority, weathervaning from fin side force | Crosswind landing at 12 kt: aircraft weathervanes into wind on touchdown unless rudder applied; taxi at 20 kt in a 90° turn skids rather than snapping |
| — | Rudder authority coming off a stall turn "excessive"; stall-spin a "rough imitation" | Fin effectiveness drops in post-stall wake; spin requires yaw + stall | Full rudder at Vs with full aft stick → incipient spin within 2 turns, recoverable with PARE |
| — | Controller sensitivity curves matter more than the model; spring-centred sticks exaggerate twitchiness | Expose sensitivity/deadzone curves per axis exactly like MSFS (Sensitivity −/+, Dead zone, Neutral, Extremity dead zone) | Settings UI has those four sliders per axis |
| — | Cockpit camera "head anchored to a tripod"; doesn't react to accelerations | Spring-mass-damper head model with g-load and turbulence inputs (see §6) | Head sinks 1–2 cm at 2 g, bobs in turbulence |

Comparative context: X-Plane advocates cite blade-element stalls/spins/crosswind as better; recent comparisons say the gap "is entirely dependent on the aircraft" and that MSFS24 narrowed it ([Jon Beckett](https://jonbeckett.substack.com/p/how-does-x-plane-12-really-compare), [q8pilot comparison](https://q8pilot.com/briefings/xplane-12-vs-msfs-2024)). Our panel method sits conceptually between the two; the acceptance tests above are what players will actually try in the first five minutes.

---

## 2. World: terrain, imagery, photogrammetry, autogen

Numbers MSFS marketing and interviews use (we will be judged against them, so quote them honestly in our README):

| Item | MSFS20 | MSFS24 | Source |
|---|---|---|---|
| Base imagery | Bing Maps aerial/satellite, ~2–2.5 PB processed through Azure | same + higher-res updates | [Engadget](https://www.engadget.com/flight-sim-interview-ces-2021-ai-photogrammetry-bing-224546632.html) |
| Buildings | ~1.5 B (fan wiki) / "2 B" (Engadget interview) procedurally extruded by Blackshark.ai from 2-D imagery | same pipeline, improved | [Engadget Azure AI](https://www.engadget.com/microsoft-flight-simulator-azure-ai-machine-learning-193545436.html), [PCGamesN](https://www.pcgamesn.com/microsoft-flight-simulator/map) |
| Trees | ~2 trillion, 2020 trees were projected billboards ("fake 3D") | true 3D meshes with branches/leaves, seasonal colour & bare winter trees, 30 biomes, 3-D ground (grass, crops) | [GameRant interview](https://gamerant.com/microsoft-flight-simulator-2024-interview-details-2020-improvements/), [PC Gamer 30 biomes](https://www.pcgamer.com/games/sim/more-details-on-ms-flight-simulator-2024-including-full-3d-landscapes-in-30-biomes/) |
| Airports | ~37,000 (all real airports), 30/35/40 hand-crafted by edition at launch, Standard later 91 | all airports with ground services; ~2,000 glider fields, ~10,000 heliports | [SourceForge listing](https://sourceforge.net/app/microsoft-flight-simulator-2020/), [Flying Mag preview](https://www.flyingmag.com/microsoft-flight-simulator-2024-preview-advanced-audacious-leap-forward/) |
| Cities/towns | ~2 M | same | same |
| Photogrammetry | Dozens of major cities (Barcelona, Berlin, SF, Seattle, NYC …) streamed; absent cities get autogen | expanded | [TechCrunch](https://techcrunch.com/?p=2023914) |
| Streaming | Terrain, imagery, weather, traffic streamed from Azure; offline fallback is low-res | nearly everything incl. aircraft streamed; local cache | [FlyAway 2020-vs-2024](https://flyawaysimulation.com/ask/answers/msfs-2020-vs-2024-differences/) |
| Terrain tech talk | GDC 2022 "Designing the Terrain System of Flight Simulator: Representing the Earth" (Lionel Fuentes), deck published by Asobo | — | [Asobo GDC 2022](https://www.asobostudio.com/news/asobo-gdc-2022) |

Data-licence note for the clone: Bing Maps imagery and Meteoblue weather are proprietary and cannot be used. Free runtime tiles with permissive terms exist (e.g., OpenStreetMap ODbL for buildings/roads, Esri World Imagery under its own terms, Sentinel-2 CC BY-SA 3.0 IGO, AWS Terrain Tiles / Copernicus DEM public). Details and tile schemes are in the terrain doc; this doc only fixes the *behaviour* to replicate:

1. Imagery and DEM streamed by quadtree LOD; nearest ~2 km must be sharp (MSFS at low altitude reads ~0.3–0.5 m/px in good areas).
2. Buildings extruded from footprints with height heuristics; trees instanced from landcover; both appear within ~5–10 km and fade in without popping.
3. Earth curvature and horizon haze visible from FL300.
4. Runways, taxiways, aprons as proper geometry with lights at night; everything else may be imagery.

---

## 3. Weather, clouds, sky, time of day

### 3.1 Live weather
Meteoblue supplies MSFS's global model; refresh is roughly every 6 h globally with faster regional updates ([Meteoblue on Wikipedia](https://en.wikipedia.org/wiki/Meteoblue), [Virtual Flight guide](https://virtual-flight.com/blog/mastering-weather-flight-simulation-guide/)). The sim blends model data with METAR at airports [memory]. Our equivalent: NOAA/FAA aviationweather.gov METAR/TAF (US Gov, public domain) and Open-Meteo (CC BY 4.0) for winds aloft; interpolate between stations; refresh every 15–30 min.

### 3.2 Built-in presets (indices 0–8; custom presets start at 9)
Order and names, per [FlyAway presets guide](https://flyawaysimulation.com/ask/answers/msfs-2024-weather-presets/) and the [SDK WPR docs](https://docs.flightsimulator.com/msfs2024/flighting/content-configuration/mission-xml-files/weather-xml-wpr-file-properties/index.md):

| Idx | Preset | Suggested clone parameters (base/top AGL, coverage) |
|---|---|---|
| 0 | Clear Skies | no layers, vis 60 nm, wind calm |
| 1 | Few Clouds | 1 layer cumulus 3,500–5,500 ft, cov 0.2 |
| 2 | Scattered Clouds | cumulus 3,000–6,000 ft, cov 0.45 |
| 3 | Broken Clouds | stratocumulus 2,500–6,500 ft, cov 0.7 |
| 4 | High Level Clouds | cirrus 25,000–30,000 ft, cov 0.5 |
| 5 | Overcast | stratus 2,000–6,000 ft, cov 1.0, vis 10 nm |
| 6 | Rain | 1,500–8,000 ft cov 0.95, precip 4 mm/h, vis 5 nm |
| 7 | Snow | 1,500–7,000 ft cov 0.95, temp −3 °C, snow cover on, vis 3 nm |
| 8 | Storm | cumulonimbus 1,500–30,000 ft cov 0.8, precip 10 mm/h, thunderstorm 1.0, gusts +15 kt |

Then **Live Weather** and **Custom** entries. (Parameter values above are my proposals, not MSFS's internal values.)

### 3.3 Custom weather parameters (the editable model)
From the WPR schema and the in-sim panel ([SDK WPR](https://docs.flightsimulator.com/msfs2024/flighting/content-configuration/mission-xml-files/weather-xml-wpr-file-properties/index.md), [AVSIM "Weather presets your way"](https://www.avsim.com/forums/topic/586659-weather-presets-your-way/), [FlyAway wind guide](https://flyawaysimulation.com/ask/answers/msfs-2020-wind-turbulence-settings/)):

```ts
interface CloudLayer { baseM: number; topM: number; coverage: number /*0..1*/; density: number /*0..1*/; scattering: number /*0.1..1.0, UI max ≈ 0.5*/; }
interface WindLayer  { altM: number; dirDeg: number; speedKt: number; gustKt: number; }
interface Weather {
  clouds: CloudLayer[];          // MSFS UI exposes 3 layers [verify], files allow more
  winds: WindLayer[];            // UI allows several; community presets use up to 6
  precipMmPerHr: number;         // UI slider 0..10; files accept 100
  thunderstorm: number;          // 0..1 (lightning probability)
  humidityPct: number;           // 0..100 (controls haze)
  pressureHpa: number;           // QNH at MSL; file stores hPa
  tempC: number;                 // MSL temperature; file stores kelvin
  aerosolDensity: number;        // 0..1 visibility/haze [memory]
  snowCover: number;             // 0..1 ground snow [memory]
  visibilityNm?: number;         // MSFS24 exposes visibility directly
}
```
Community notes worth copying: altitude is stored in metres and shown in feet; cloud layers have a minimum thickness so very thin layers are impossible; scattering midpoint 0.5 is effectively the visual max; radar returns need precipitation, not just cloud.

### 3.4 Cloud and sky rendering (what the eye expects)
MSFS renders ray-marched volumetric clouds with distance-dependent detail, a "Volumetric Clouds" quality setting with Low/Medium/High/Ultra, light shafts, cloud shadows on terrain, and in-cloud grey-out ([Virtual Flight](https://virtual-flight.com/blog/mastering-weather-flight-simulation-guide/), [FlyAway clouds answer](https://flyawaysimulation.com/ask/answers/flight-simulator-clouds-not-covering-whole-sky/)). The 2019 GeekWire piece describes Asobo modelling "how light is scattered by hazy skies" and clouds "built with multiple layers of moisture" ([GeekWire](https://www.geekwire.com/2019/microsoft-flight-simulator-cloud/)). No Asobo cloud-rendering paper exists; the sky doc should default to Hillaire 2020 (scalable sky/aerial perspective LUTs) + Schneider/Nubis-style ray-marched clouds at quarter resolution with temporal reprojection.

Web budget: half- or quarter-res cloud pass, 48–64 steps primary, 4–6 light steps, blue-noise jitter, temporal reprojection. Must support: flying *through* a layer (grey-out + rain on canopy), cloud shadows, and sunset colouring on cloud bottoms (that single effect is what every MSFS screenshot sells).

### 3.5 Time of day and seasons
World Map "Flight Conditions" has **Live time** vs a **custom time slider** with date; sunrise/sunset/night lighting, star field, moon phases, city lights. MSFS20 had no seasons except snow from live weather (REX AccuSeason mod filled the gap); MSFS24 adds foliage seasons and bare winter trees ([Steam discussion](https://steamcommunity.com/app/2537590/discussions/1/598539106885131663/), [Seasons Enhanced mod thread](https://forums.flightsimulator.com/t/seasons-2024-enhanced-by-bijan-released/456640)). v1: date+time slider, correct sun/moon ephemeris, night city lights from imagery/OSM; seasons = Could.

---

## 4. Aircraft roster: archetypes that matter

### 4.1 What ships
MSFS20: 20 / 25 / 30 aircraft at launch (Standard / Deluxe / Premium Deluxe), later ~37 / 42 / 47 with free updates ([GameRevolution](https://www.gamerevolution.com/guides/656135-microsoft-flight-simulator-2020-planes-list-complete-standard-deluxe-premium), [Windows Central list](https://www.windowscentral.com/list-microsoft-flight-simulator-planes)). Deluxe adds DA40-TDI, DV20, Baron G58, C152 Aerobat, C172 (steam gauges); Premium Deluxe adds 787-10, Cirrus SR22, Citation Longitude, Pitts, Shock Ultra, plus 5 more hand-crafted airports.
MSFS24: 70 / 80 / 95 / 125 (Standard / Deluxe / Premium Deluxe / Aviator), including helicopters (H125, H225), gliders, balloons, airships, CL-415, S-64 Aircrane ([Windows Central MSFS24 list](https://www.windowscentral.com/gaming/xbox/microsoft-flight-simulator-2024-list-of-every-aircraft), [FSElite](https://fselite.net/content/all-aircraft-featured-in-microsoft-flight-simulator-2024/), [Neowin editions](https://www.neowin.net/amp/microsoft-flight-simulator-2024-will-have-four-editions-including-a-19999-aviator-edition/)).

### 4.2 Archetypes, ranked by how much "MSFS-ness" they carry

| Rank | Archetype (MSFS exemplar) | Why it matters | Avionics | v1? |
|---|---|---|---|---|
| 1 | **Cessna 172 Skyhawk G1000** | Default trainer; every tutorial, lesson and first flight uses it; the glass cockpit is the screenshot | G1000 NXi (Working Title) | **Must** |
| 2 | **Cessna 152 / 172 steam gauges** | Flight Training uses the C152; players who want "real" instruments | Six-pack + KX155-style radios + GNS430 | **Must** (reuse 172 airframe with steam panel) |
| 3 | **Daher TBM 930** | The "fast GA" hero of Bush/landing challenges; shows off G3000 touch controllers | G3000 | Should |
| 4 | **Airbus A320neo** | The airliner everyone tries on day one; FBW, FMS, autoland; FlyByWire A32NX is the most popular mod ever | Airbus PFD/ND/ECAM/MCDU | Could (simplified: PFD, ND, FCU autopilot, no MCDU) |
| 5 | **Cub / XCub / Savage Cub** | Bush trips, taildragger ground handling, STOL | Steam | Should (same panel engine as C152) |
| 6 | **Boeing 747-8 / 787-10** | Spectacle; long haul | Boeing PFD/ND/FMC | Won't v1 |
| 7 | **Cirrus SR22 / DA40 / DA62 / Baron G58 / Bonanza G36** | GA variety, twins | G1000 variants | Could (G1000 reuse) |
| 8 | **Citation CJ4 / Longitude** | Bizjets; CJ4 is the other Working Title showcase | Pro Line 21 / G5000 | Won't v1 |
| 9 | Helicopters (H125, Cabri), gliders (DG1001, LS8), balloons (MSFS24) | New in 2024; different physics | — | Won't v1 |

Recommendation: ship v1 with **two airframes, three panels** — C172 (G1000), C172 (steam), and a Cub-class taildragger — all reusing one panel-rendering engine and one FDM configuration schema. Add a TBM-class turboprop in v1.1 for speed and the G3000 look.

---

## 5. Cockpit interaction and avionics

### 5.1 Interaction system
- **Lock** (default on consoles; "Lock" highlights the control under the cursor in blue and shows prompts; hold interaction key + use the displayed increase/decrease input) vs **Legacy** (hover + scroll wheel on knobs, click-drag levers, no blue highlight). Setting path: Options › General › Accessibility › Cockpit Interaction System ([FlyAway VR interaction](https://flyawaysimulation.com/ask/answers/cockpit-interaction-microsoft-flight-simulator-vr/), [FlyAway mouse in 2024](https://flyawaysimulation.com/ask/answers/use-mouse-controls-msfs-2024/), [PMDG forum on removing blue highlight](https://forum.pmdg.com/forum/main-forum/general-discussion-news-and-announcements/336516-anybody-found-a-way-of-removing-this-msfs2024)).
- Tooltips: hover shows control name and current value (e.g., "HEADING BUG 270°"); MSFS24 adds a "tooltip assistance" toggle ([GameRant](https://gamerant.com/msfs-microsoft-flight-simulator-2024-hud-display-tooltip-assistance-guide/)).
- Knob convention: scroll = small step, Ctrl+scroll or the outer ring = large step; left click = decrease, right click = increase on some knobs [memory].
- Interactive checklist (toolbar) with an **eye icon** that pans the camera to and highlights the control for each line, and an "auto-complete" option (Assisted Checklist) [memory].

Web implementation: raycast against named hit-boxes (`hb_hdg_knob`, `hb_alt_knob`, `sw_master`, `lvr_throttle`), hover tooltip with value, wheel = ±1 step, shift+wheel = ×10, click toggles; cursor changes to hand/rotate icon exactly like MSFS. Clickable parts must include: master/alt/avionics switches, magneto/start key, lights, fuel pump, pitot heat, flaps lever, trim wheel, throttle/mixture, parking brake, COM/NAV radios, transponder, heading/altimeter knobs.

### 5.2 G1000 (the glass cockpit everybody recognises)
Working Title's **G1000 NXi** became the default in MSFS20 and MSFS24. Features that define it: all 23 ARINC-424 leg types, coupled VNAV with altitude constraints, missed approach auto-loaded, HSI map inset, METAR on map, weather radar, user holds, MFD Nearest page (airports/intersections/VOR/NDB), traffic map ([MSFS Addons release](https://msfsaddons.com/2021/07/28/working-title-releases-garmin-g1000-nxi-in-the-msfs-marketplace/), [update 1](https://msfsaddons.com/2021/09/05/working-title-g1000-nxi-updated-with-weather-radar-improved-ap-user-holds-and-more/), [update 2](https://msfsaddons.com/2021/10/20/working-title-g1000-nxi-updated-with-new-rnav-approaches-metar-information-map-panning-and-more), [FSElite feature episode](https://fselite.net/content/msfs-feature-discovery-series-episode-13-garmin-g1000-nxi/)). Source code is public in [microsoft/msfs-avionics-mirror](https://raw.githubusercontent.com/microsoft/msfs-avionics-mirror/main/README.md) (MIT) — a legitimate reference for behaviour and layout, not for art.

Physical layout to replicate (standard Garmin G1000, from the Garmin pilot's guide [memory]):
- **PFD**: airspeed tape (left) with V-speed bugs and trend vector; attitude indicator with flight director; altitude tape (right) with selected-altitude bug; VSI; HSI (bottom) with CDI (GPS magenta / VLOC green), bearing pointers, wind vector; inset map; softkeys (12 across the bottom): `[ ] INSET [ ] PFD OBS CDI ADF/DME XPDR IDENT TMR/REF NRST ALERTS`.
- **MFD**: engine strip (left ~1/5 width: RPM, FFLOW, oil, fuel qty, EGT lean), moving map with terrain/topo, flight plan window, softkeys `ENGINE [ ] MAP DCLTR SHW CHRT CHKLIST`.
- **Bezel controls**: NAV knob + NAV freq swap, COM knob + swap, HDG knob (push = sync), ALT knob (outer thousands / inner hundreds), CRS/BARO knob, RANGE joystick (pan), **Direct-to (D→)**, FPL, PROC, MENU, CLR, ENT, FMS knob (outer = cursor field, inner = character), AP keys `AP FD HDG ALT NAV VNV APR BC VS FLC NOSE UP/DN`.
- Direct-to flow: press D→ → identifier field → FMS inner knob to type → ENT → "ACTIVATE?" ENT. Flight plan: FPL → add waypoint with FMS knob → ENT. PROC → Select Approach → runway/ILS → LOAD or ACTIVATE.

### 5.3 G3000 / G5000 (TBM 930, Longitude, Vision Jet)
Three landscape displays plus two **GTC touch controllers**; touch-driven FMS pages, map range by pinch, airport info pages. Only needed if we ship a TBM-class aircraft.

### 5.4 MSFS24 EFB (Electronic Flight Bag)
Opened with **Tab** or the toolbar tablet icon; tabs for flight planner (dep/dest/runways/procedures/cruise alt → route → push to avionics), weight & balance, airport charts, checklists, weather, performance; replaces many MSFS20 toolbar panels ([Zendesk EFB intro](https://flightsimulator.zendesk.com/hc/en-us/articles/16959472213916-Electronic-Flight-Bag-EFB-introduction), [SimTuts EFB guide](https://simtuts.com/guides/msfs-2024-efb-guide), [FlyAway EFB](https://flyawaysimulation.com/ask/answers/use-efb-msfs-2024/)). For a web sim, an EFB-style tablet panel is a natural single home for planner/weather/checklist — recommended over MSFS20's many floating panels.

---

## 6. Camera system

Modes and defaults ([Zendesk Camera FAQ](https://flightsimulator.zendesk.com/hc/en-us/articles/360016003159-Camera-Video-FAQ), [FlyAway camera controls](https://flyawaysimulation.com/ask/answers/use-camera-controls-microsoft-flight-simulator/), [forum drone guide](https://forums.flightsimulator.com/t/how-to-using-the-drone-cam-tips-tricks/128165), [FRAMED screenshot guide](https://framedsc.com/GameGuides/microsoft_flight_sim.htm), [Flight Sim Workshop 2024 cameras](https://flightsimworkshop.com/msfs-2024-camera-controls/)):

| Mode | MSFS behaviour | Keys (MSFS20 default) | Clone spec |
|---|---|---|---|
| **Cockpit** | Pilot eye point; freelook with mouse (hold right button / middle button) or arrows; zoom with wheel; **Quickviews** snap to left/right/up/rear; **Instrument views** jump to PFD/MFD/radios/overhead; **Freelook Momentum** and **Camera Shake** sliders; MSFS20 also had Head Movement / G-Force Head Movement sliders | End toggles cockpit/external; Ctrl+Space reset (Shift+Space in 2024); Ctrl+↑↓←→ quickviews; Ctrl+1…0 instrument views (Shift+1…0 in 2024) [verify] | Eye point from aircraft config; freelook yaw ±160°, pitch −60/+80; quickview tween 250 ms ease-out; instrument views as named poses; head model: 2nd-order spring (ωn≈6 rad/s, ζ≈0.7) driven by body accel, ±2 cm/g, plus turbulence noise |
| **External / Chase** | Orbit around aircraft, follows it; mouse orbits, wheel zooms; external quickviews | End; Ctrl+arrows | Spring-damper lag on position (τ≈0.3 s) and on heading so the aircraft "swings" in turns; collision-free with ground |
| **Drone / Showcase** | Free camera, aircraft keeps flying (optionally **Follow mode** tethers to aircraft); translation WASD + R/F, rotation on numpad, roll Num7/9, zoom Num+/−, speed F1/F2 (older builds), auto-focus F4, depth-of-field Auto/Manual/Off, **Lock to target** T, follow toggle Tab | Insert toggles drone (2020); Shift+X reported for 2024 [verify] | Same keys; translation speed presets 1–10 m/s … 500 m/s on a log scale; follow mode = offset frame locked to aircraft; DOF post-process |
| **Smart Camera** | Auto-aims at nearest/selected POI or traffic; cycle targets | S (community list) [verify] | Target list = POIs, airports, traffic; slerp 0.5 s |
| **Fixed / Cinematic** | Preset positions (wing, tail, gear, landing cams) and cycling cinematic shots; cycle keys only work while in fixed/instrument view | next/prev fixed camera (unbound by default) | 6–8 fixed cams per aircraft config |
| **Custom cameras** | Save current view to slot; recall | Ctrl+Alt+0–9 save, Alt+0–9 load [memory] | localStorage per aircraft |
| **Home cockpit mode** | Disables camera motion; "world moves around the aircraft" | setting | out of scope |

Common complaint to avoid: camera rolls with bank angle in cockpit with no option to disable ([forum thread](https://forums.flightsimulator.com/t/make-cockpit-camera-rolling-with-bank-angle-optional/447863)) and a "head on a tripod" that ignores accelerations ([forum thread](https://forums.flightsimulator.com/t/more-realistic-head-movement/676026)). Expose both as sliders.

---

## 7. UI and menus

### 7.1 Main menu (MSFS20)
Welcome → **World Map** (free flight), **Activities** (Landing Challenges, Bush Trips, Flight Training, Discovery Flights), **Marketplace**, **Profile**, **Options**. MSFS24 renames/adds: **Free Flight**, **Career**, **Challenge League**, **World Photographer**, **Activities**, **Marketplace** ([fsnews MSFS24](https://fsnews.eu/microsoft-shares-new-information-regarding-msfs2024/)).

### 7.2 World Map flight planner (the ritual to copy exactly)
From [FlyAway World Map](https://flyawaysimulation.com/ask/answers/use-world-map-microsoft-flight-simulator/), [FlyAway built-in planner](https://flyawaysimulation.com/ask/answers/use-built-in-flight-planner-microsoft-flight-simulator/), [forum "Full UI World Map"](https://forums.flightsimulator.com/t/msfs-2024-full-ui-world-map/756577), plus product memory:

1. Globe with imagery; zoom/pan; **search box** (ICAO, airport name, city, POI); **filters** (airports, navaids, POIs, fauna, weather overlay, multiplayer).
2. Click an airport → **Set as Departure / Set as Arrival**; choose **Runway** (spawn on runway, engines running, "ready to fly") or **Parking / Gate / Ramp** (cold and dark).
3. **Route type** dropdown: **Direct – GPS**, **VOR to VOR**, **Low-altitude airways (IFR)**, **High-altitude airways (IFR)**; IFR enables departure (SID), arrival (STAR) and **approach** pickers (ILS/RNAV/VOR by runway) ([forum World Map VFR plans](https://forums.flightsimulator.com/t/world-map-vfr-flight-plans/497099), [forum IFR setup](https://forums.flightsimulator.com/t/ifr-set-up/542780)). Cruise altitude field. Waypoints draggable; add custom user waypoints by clicking the map.
4. **Flight Conditions** panel: Weather (Live / preset / Custom), Time (Live / slider), Multiplayer (Live Players / All Players / Group Only / Off), Air traffic (Real-time online / AI offline / Off).
5. **Aircraft** tile: picker with categories (Airliners, Propellers, Turboprops, Jets, Helicopters…), livery, **Fuel & Payload** (sliders per tank/station, CG envelope diagram), **Failures** (per-system, timed or random), **Nav Log** (legs, headings, distances, ETE, fuel), **ATC** options (callsign, tail number, flight number, "Show tail number").
6. **Fly** button → loading screen with tips → optional MSFS24 walk-around (skippable since SU6 via "Start flight without walkaround").

Also: load/save `.PLN` (and MSFS24 `.FLT`/EFB plans); import from SimBrief/LittleNavmap; Discover tab with featured POIs.

### 7.3 In-flight toolbar (MSFS20) and HUD
Toolbar appears on mouse-to-top; items ([gamepressure toolbar](https://www.gamepressure.com/microsoft-flight-simulator/toolbar/z7d85f), [FlyAway toolbar](https://flyawaysimulation.com/ask/answers/use-microsoft-flight-simulator-toolbar/)):

| Panel | Function | Web v1 |
|---|---|---|
| ATC | Menu-driven comms (also Scroll Lock) | Must (text) |
| Camera | Switch cockpit/external/showcase/drone, save views | Must |
| Checklist | Interactive per-phase checklist with eye highlight and auto-complete | Should |
| Basic Controls | On-screen help for current input device | Could |
| AI Control | "Control aircraft" (AI pilot flies) and "Manage radio comms" toggles | Should (radio), Could (AI pilot) |
| Fuel & Payload | Live sliders (where mode permits) | Should |
| Nav Log | Legs/ETE/fuel | Should |
| Objectives | Activity goals | Must for challenges |
| Travel To | Jump to Cruise / Descent / Approach / Final / Taxi-to-gate [memory for exact list] | Should (Final + Cruise at least) |
| VFR Map | Moving map with route, airports, airspace | Must |
| Weather | Live/preset/custom editor in flight | Must |
| Replay (MSFS24) | Built-in FlightControlReplay, last 5 min | Could |
| EFB (MSFS24) | Tablet | Should (as the home for the above) |
| Custom | Toggle which icons show | Could |

HUD elements (assists): top-centre **flight info strip** (speed, altitude, heading, VS, wind) when outside cockpit, landing-path gates, route ribbon, taxi ribbon, POI labels, notification toasts, "Active Pause" badge, sim-rate badge, ATC subtitles bottom-left [memory].

### 7.4 Settings structure to mirror
General (Graphics: Terrain LOD slider 10–400, Objects LOD, Volumetric Clouds Low→Ultra, Texture resolution, Anisotropic, AA TAA/DLSS/FSR, render scaling; Camera: Freelook momentum, camera shake, cockpit/external zoom; Sound; Traffic; Data: online functionality, Bing data, photogrammetry, rolling cache size; Misc: units imperial/metric/hybrid), Controls (per device profile; Sensitivity −/+, Dead zone, Neutral, Extremity dead zone; search by key or input), Assistance (see §1.2), Accessibility (cockpit interaction Lock/Legacy, subtitles, UI scale).

---

## 8. ATC and radio

MSFS ATC is **menu-driven**: Scroll Lock opens the ATC window; numbered options 1–9; frequencies tune automatically if "ATC assistance" is on. Flow: ATIS → Clearance Delivery (IFR only, sometimes nested under Ground) → Ground taxi (blue taxi ribbon) → Tower takeoff clearance → Departure → Center handoffs → Approach vectors → Tower landing clearance → Ground taxi to parking. VFR can request **flight following** and pattern entry; uncontrolled fields use Unicom/CTAF self-announce options. Voices: **Azure** cloud TTS when online, fallback to Windows offline TTS; many prefer offline for variety ([FlyAway ATC](https://flyawaysimulation.com/ask/answers/use-atc-microsoft-flight-simulator/), [FlyAway taxi](https://flyawaysimulation.com/ask/answers/request-taxi-directions-atc-msfs/), [forum Azure TTS](https://forums.flightsimulator.com/t/atc-text-to-speech-azure-doesnt-seem-to-reconnect/437477), [forum offline vs Azure](https://forums.flightsimulator.com/t/is-it-me-or-sometimes-the-offline-atc-sounds-better-than-the-azure-atc/505042)). Known weaknesses: nonsense altitude assignments on descent, no proper IFR at uncontrolled fields, hand-offs mid-approach ([forum "minor fixes to ATC"](https://forums.flightsimulator.com/t/minor-fixes-to-atc-major-immersion-gains/568444)).

Web v1 spec: a state machine per airport (ATIS, Ground, Tower, Approach/Departure as one "Radar" controller), text menu with 1–9 keys, phraseology templates, Web Speech API `speechSynthesis` for voice (with a 2-voice minimum and radio band-pass filter via WebAudio), ATIS generated from current weather (wind, vis, clouds, temp/dew, QNH, active runway from wind). "AI radio comms" toggle auto-selects the correct reply after 2 s.

---

## 9. Flight planning and navigation in the aircraft

- **GPS Direct-to** (D→) and flight-plan sequencing with auto leg switching (turn anticipation ≈ bank 25°, 0.5–1 nm) [memory].
- **VOR**: CDI with OBS, TO/FROM, DME; ILS: localizer + glideslope on HSI/CDI, marker beacons; approach selectable in World Map and in G1000 PROC.
- **Autopilot** (default C172 G1000 = GFC 700 behaviour): HDG, NAV (GPS/VLOC), APR, ALT, VS, FLC, VNV, FD, AP master, with Z/Ctrl keys below. Autopilot disconnect should show the MSFS-style "AP OFF" message and tone.
- **Nav data**: MSFS ships Navblue data, updated per AIRAC via sim updates; Navigraph is the paid alternative [memory]. We need a free source: FAA NASR (public domain, US only) for airports/navaids/procedures, plus OurAirports (public domain) for worldwide airports/runways/frequencies; details in the airports/nav doc.

---

## 10. Activities: landing challenges, bush trips, lessons, career

### 10.1 Landing Challenges (MSFS20)
Categories **Famous / Epic / Strong Wind**; 24 at launch (8/8/8), 58 by World Update XI ([Fandom list](https://flight.fandom.com/wiki/Microsoft_Flight_Simulator_(2020)/Landing_Challenges), [Windows Central tips](https://www.windowscentral.com/microsoft-flight-simulator-landing-challenge-tips-and-tricks), [forum achievement guide](https://forums.flightsimulator.com/t/100-achievement-guide-for-msfs2020/734917)). Each starts established on final (no startup/taxi). Scored on **distance from centreline**, **touchdown smoothness (vertical speed)** and **stopping distance / time to stop**, with a global leaderboard. Confirmed examples (airport – aircraft – category): Courchevel LFLJ – TBM 930 – Epic; Saint-Barthélemy TFFJ – TBM 930 – Epic; Paro VQPR – A320neo – Epic; Lukla VNLK – Cessna 208B – Epic; Gibraltar LXGB – A320neo – Strong Wind; Innsbruck LOWI – 747-8 – Strong Wind; Sedona KSEZ – C152 – Strong Wind; Funchal/Madeira LPMA – A320neo – Strong Wind; Hachijojima RJTH – A320neo – Famous; Llanada Grande SCGE – C172 – Famous; Nice LFMN – Bonanza G36 – Famous; Rio Galeão SBGL – A320neo – Famous; Nanwalek – C172 ([closed-beta notes](https://www.flightsimulator.com/closed-beta-now-available/)).

Proposed scoring (pseudocode, tuned to feel like MSFS's 0–10,000-ish bands):
```ts
function landingScore(td: Touchdown, rollout: Rollout, rwy: Runway): number {
  const center = 1 - clamp(Math.abs(td.lateralOffsetM) / (rwy.widthM / 2), 0, 1);   // 1 = dead centre
  const smooth = 1 - clamp((Math.abs(td.verticalSpeedFpm) - 60) / 540, 0, 1);         // ≤60 fpm = perfect, ≥600 = 0
  const zone   = 1 - clamp(Math.abs(td.alongTrackM - rwy.aimPointM) / 300, 0, 1);     // 1000-ft aim point
  const stop   = 1 - clamp(rollout.stopDistanceM / (rwy.lengthM - td.alongTrackM), 0, 1);
  const crashed = td.verticalSpeedFpm < -1200 || td.offRunway;
  return crashed ? 0 : Math.round(10000 * (0.30*center + 0.35*smooth + 0.15*zone + 0.20*stop));
}
```

### 10.2 Bush Trips
Launch trio ([Fandom bush trips](https://flight.fandom.com/wiki/Microsoft_Flight_Simulator_(2020)/Bush_Trips), [SegmentNext guide](https://segmentnext.com/microsoft-flight-simulator-2020-bush-trips/)): **Nevada** (Breckenridge → Mariposa-Yosemite, Zlin Savage Cub, 25 legs), **Balkans** (Rijeka → Santorini, C172 G1000, 16 legs, ~8 h), **Patagonia** (Los Cerros → Cochrane, XCub, 14 legs). Later "Discover" series (Denmark C172 6 legs, Norway Bonanza 14 legs, Finland, Iceland, Bordeaux → Mont Blanc, Iberia…); MSFS24 restored bush trips in SU6 (Sweden, Wales, Switzerland) ([SimTuts](https://simtuts.com/guides/msfs-2024-bush-trips-guide)). Mechanics: VFR only, no GPS map by default, a nav-log with written leg descriptions and headings/times, fuel persists between legs, progress saved per leg. Web v1: one 5–8 leg trip over the terrain area we stream best.

### 10.3 Flight Training
MSFS20: **Basic Handling** (8 lessons, C152, Sedona KSEZ area), **Take-off and Landing** (7 lessons, C152), **VFR Navigation** (5 lessons, Flagstaff → Sedona), plus later airliner/bush/IFR courses ([Fandom training](https://flight.fandom.com/wiki/Microsoft_Flight_Simulator_(2020)/Flight_Training), [FlyAway training](https://flyawaysimulation.com/ask/answers/use-flight-training-microsoft-flight-simulator/)). Each lesson: voiced instructor, objective checklist with pass/fail, Travel-To style start mid-air. MSFS24 moves training into **Career** flight school with practical exams.

### 10.4 MSFS24 modes (note, mostly Won't)
**Career** (flight school → certifications → missions: cargo, medevac, firefighting, SAR, up to ATPL; credits + reputation), **Challenge League** (weekly rally races, precision landings, low-altitude challenges, leaderboards; Red Bull Air Race added in SU4), **World Photographer**, **Activities** ([MSFS Addons career](https://msfsaddons.com/2024/09/19/heres-how-the-career-mode-works-in-microsoft-flight-simulator-2024/), [PCGH SU4](https://www.pcgameshardware.de/Microsoft-Flight-Simulator-2024-Spiel-74308/News/Sim-Update-4-1488669/)). Career is reportedly more played than Free Flight ([MSFS Addons](https://msfsaddons.com/2025/03/01/msfs-2024s-career-mode-is-more-popular-than-free-flight-says-microsoft/)) — a hint that *goals* matter as much as fidelity.

---

## 11. Replay
MSFS20 shipped **without** replay (a top wish-list item for four years; FlightControlReplay and Sky Dolly filled the gap). MSFS24 embeds FlightControlReplay in the toolbar: continuous recording of the **last 5 minutes**, scrub/play, free camera during playback, save and load recordings as AI aircraft; criticised as stuttery, no sound, no multiplayer ([MSFS Addons replay](https://msfsaddons.com/2024/12/03/the-replay-mode-in-microsoft-flight-simulator-2024/), [forum replay bug](https://forums.flightsimulator.com/t/msfs-2024-replay-bug-and-sim-getting-hung/684428)). Web: ring buffer of state (pos, quat, surfaces, gear, lights) at 30 Hz × 300 s ≈ 9,000 frames ≈ 1 MB; playback drives the visual model only, drone camera available. Cheap and a visible differentiator vs MSFS20.

---

## 12. Multiplayer and traffic (out of scope, for completeness)
Modes: **Live Players** (forces live weather/time; see pilots with the same settings), **All Players** (everyone within ~200 km regardless of settings), **Group Only**, **Off**; plus **Live Traffic** (real-world ADS-B-derived) vs **AI Offline** traffic and ground vehicles ([Windows Central multiplayer](https://www.windowscentral.com/how-play-multiplayer-microsoft-flight-simulator), [forum quick guide](https://forums.flightsimulator.com/t/how-to-quick-guide-to-msfs-multiplayer/99647)). Won't for v1; architecture should still keep aircraft state in a serialisable struct so a future WebRTC/WebSocket layer can replicate it. A free ADS-B feed (e.g., OpenSky Network, research-only licence) could later provide "live traffic" as a Could.

---

## 13. MoSCoW for a v1 web flight sim

| Priority | Feature | Notes / acceptance |
|---|---|---|
| **Must** | Surface-based 6-DOF FDM with asymmetric stall, P-factor, ground effect, per-tyre ground model, constant-rate trim | §1.3 tests pass |
| **Must** | C172 with G1000-style PFD/MFD (tapes, HSI, map, D→, FPL, PROC-lite, AP) and steam-gauge variant | hover tooltips, scroll knobs |
| **Must** | Streamed real-world terrain (DEM + imagery) with LOD, curvature, horizon haze | sharp within 2 km, no holes |
| **Must** | At least 5 real airports with correct runway geometry/markings/lighting, searchable DB of ≥ 2,000 airports (OurAirports) | spawn on runway or parking |
| **Must** | Volumetric-looking multi-layer clouds, physically based sky, sun/moon/stars, time slider + live time | fly through clouds, sunset colouring |
| **Must** | 9 MSFS weather presets + Custom editor (clouds 3 layers, winds 3 layers, precip, vis, temp, QNH) | preset names identical |
| **Must** | Cameras: cockpit freelook + quickviews + instrument views, chase, drone with MSFS keys, smooth transitions | Keys in §15 |
| **Must** | World Map flow: search → departure/arrival → runway/parking → route (Direct GPS) → conditions → aircraft → Fly | < 10 s to first frame on a warm cache |
| **Must** | Assistance presets All Assists / Middle Ground / True to Life with auto-rudder, assisted yoke, landing path, anti-stall, crash damage toggles | effective state visible |
| **Must** | Ctrl+E auto-start, active pause, sim rate, HUD strip, toasts | |
| **Must** | Landing Challenge mode with scoring and local best scores | ≥ 6 challenges |
| **Must** | Sound: engine RPM-driven loop, wind by IAS, gear/flaps, stall horn, touchdown, ambient; AP disconnect | WebAudio |
| **Must** | Keyboard + mouse-yoke + gamepad + joystick (Gamepad API), per-axis sensitivity curves, rebinding UI with MSFS defaults | works on a numpad-less laptop |
| **Should** | VOR/ILS navigation, approach selection, flight-following-style text ATC with ATIS, taxi ribbon | |
| **Should** | Live weather from METAR/TAF + winds-aloft API | |
| **Should** | Autogen buildings/trees from OSM within 10 km, night lights | |
| **Should** | Taildragger bush aircraft + one bush trip (5–8 legs), interactive checklist with eye highlight | |
| **Should** | Replay (last 5 min), screenshot mode with DOF | |
| **Should** | EFB-style tablet housing map/weather/checklist/nav log/fuel & payload | |
| **Should** | Three guided lessons (basic handling, pattern, landing) with voiced/text instructor | |
| **Could** | TBM-class turboprop with G3000-style touch controller | |
| **Could** | A320-lite (FBW normal law, FCU autopilot, PFD/ND; no MCDU) | |
| **Could** | Seasons/snow cover, cloud shadows on terrain, aircraft shadows in clouds | |
| **Could** | Failures panel (engine, vacuum, pitot, electrical) | |
| **Could** | Web Speech ATC voices with radio filter; AI copilot flying | |
| **Could** | Live ADS-B traffic overlay | |
| **Won't (v1)** | Multiplayer, Career, Challenge League, photogrammetry cities, marketplace/add-ons, helicopters/gliders/balloons, VR, airliners beyond A320-lite, walk-around, soft-body physics |

---

## 14. Definition of Done: "would impress an MSFS player" checklist

Performance and platform
- [ ] 60 fps at 1920×1080 with "Medium" preset on a 2021 laptop iGPU/low-end dGPU class (Iris Xe / GTX 1650 / M1), 30 fps floor on "High"; no frame-time spikes > 50 ms during tile loads.
- [ ] Cold load (empty cache) to World Map < 5 s; Fly → first frame < 10 s on 50 Mbit/s; warm < 3 s.
- [ ] Works in Chrome, Edge, Firefox, Safari 17+ (WebGL2); graceful degradation when a tile host is slow (fallback colour/DEM-only).
- [ ] No backend: all data fetched from public tile/data services or bundled; attribution shown as each licence requires.

Flight feel (the five-minute test)
- [ ] From runway spawn in the C172: full throttle → left-turning tendency needs ~¼ right rudder; rotates ~55 KIAS, climbs ~700 fpm at 74 KIAS, cruises ~110–120 KTAS at 2,400 RPM at 3,000 ft (POH ballpark).
- [ ] Power-off stall at 1 g ≈ 48 KIAS flaps 30 / 55 KIAS clean with buffet, horn ≥ 5 kt before, nose and wing drop; accelerated stall in 60° bank at √2·Vs.
- [ ] Trim: constant rate, trimmed aircraft holds speed hands-off for 30 s within ±5 kt in calm air; phugoid visible and damped.
- [ ] Ground: taxiing with differential brakes/rudder feels weighty; 12-kt crosswind landing weathervanes unless corrected; brakes stop from 60 kt in < 400 m; aircraft rocks on oleos.
- [ ] Turbulence and gusts move the aircraft and the cockpit camera; no "on rails" feel in Storm preset.
- [ ] Auto-rudder, assisted yoke, anti-stall behave as described in §1.2 when enabled, invisible when disabled.

World and sky
- [ ] Real terrain recognisable at home airport (ridgelines, rivers, coastline); imagery sharp enough to read a runway number from 500 ft AGL.
- [ ] Horizon shows curvature and aerial perspective from FL300; night has city lights and airport lighting (PAPI, REIL, edge, approach lights).
- [ ] Clouds: three simultaneous layers, flying through a cloud greys out and wets the canopy, sunset underlights clouds, overcast dims the ground, cloud shadows (Could) — a screenshot in "Scattered Clouds" at golden hour should be shareable without embarrassment next to an MSFS one.
- [ ] Weather presets match their names visually and in METAR-equivalent readout; live weather matches current METAR wind within 5°/3 kt at the chosen airport.

Cockpit and systems
- [ ] Every primary control is clickable with a hover tooltip and value; knobs respond to the wheel; switches click audibly.
- [ ] G1000: tapes, HSI with CDI/bearing pointer, wind vector, inset map with route, MFD map with terrain colours, D→ to any airport/navaid, FPL with ≥ 10 waypoints, APR ILS capture and tracking to 200 ft DH, ALT/VS/FLC/HDG/NAV modes with annunciations and AP-off tone.
- [ ] Steam variant: six-pack with realistic gyro drift (if enabled), turn coordinator ball that reacts to slip.
- [ ] Ctrl+E start, mixture/magneto/master/avionics logic, fuel burn, electrical bus with battery drain if alternator off.

Cameras, UI, goals
- [ ] All camera modes with default keys from §15; transitions are tweened; drone can be left while the autopilot flies.
- [ ] World Map: search by ICAO/name, departure/arrival, runway vs parking (cold & dark), route type, weather/time panel, aircraft picker with weight sliders, Fly.
- [ ] Toolbar/EFB: VFR map, weather, camera, checklist, ATC, objectives; HUD strip when outside; active pause; sim rate 0.25×–8×.
- [ ] ≥ 6 landing challenges with scoring and local leaderboard; ≥ 1 bush trip; ≥ 3 lessons.
- [ ] Settings: graphics presets, Terrain LOD slider, cloud quality, per-axis sensitivity/dead-zone, assistance presets with per-item override, rebindable controls with "reset to MSFS defaults".
- [ ] Replay last 5 min with drone camera.
- [ ] Attribution footer and licence notices for every live data source.

---

## 15. Default keyboard bindings

Column "MSFS20 default" lists Microsoft Flight Simulator's shipped keyboard profile as reported by multiple cheat-sheets ([flyawaysimulation](https://flyawaysimulation.com/ask/answers/msfs-2020-default-keyboard-controls/), [gamesradar](https://www.gamesradar.com/microsoft-flight-simulator-2020-keyboard-controls/), [pcgamer](https://www.pcgamer.com/microsoft-flight-simulator-2020-controls-keyboard-controller/), [allanville](https://aviation.allanville.com/misc/fs20-keyboard-shortcuts), [cheatography](https://cheatography.com/nimasmi/cheat-sheets/microsoft-flight-simulator-2020/), [flightsimbeek PDF](https://www.flightsimbeek.nl/wp-content/uploads/2024/02/MSFS-Keyboard-Commands.pdf), [msfsaddons 2024 keys](https://msfsaddons.com/msfs-2024-faq/keyboard-controls/)). Confidence: **H** = ≥ 3 sources agree; **M** = 1–2 sources or sources differ; **L** = memory. MSFS24 keeps most of these and ships a "Keyboard 2020" preset for the rest ([editorskeys](https://www.editorskeys.com/blogs/news/how-to-restore-microsoft-flight-simulator-2020-key-commands-in-msfs-2024)).

Important for a *laptop* web sim: MSFS puts primary flight controls on the **numeric keypad**, which most laptops lack. Our default must therefore provide a numpad-free alternative. Recommendation: ship MSFS20 defaults verbatim **and** a parallel "Laptop" layer where **Arrow keys = pitch/roll**, **Q/E = rudder** (MSFS uses Num0/NumEnter), **Home/End row untouched**, and **mouse-yoke** toggled with **Y** [our choice, not MSFS]. Arrow keys in MSFS are cockpit look controls (2024) — document the deviation in the controls UI.

### 15.1 Flight controls
| Action | MSFS20 default | Conf | Laptop alt (ours) |
|---|---|---|---|
| Aileron left / right | Num 4 / Num 6 | H | ← / → |
| Elevator nose down / up | Num 8 / Num 2 | H | ↑ / ↓ |
| Rudder left / right | Num 0 / Num Enter | H | Q / E |
| Centre ailerons & rudder | Num 5 | H | — |
| Elevator trim nose down / up | Num 7 / Num 1 | H | Home / End… conflicts with View; use `[` / `]` |
| Aileron trim left / right | Ctrl+Num 4 / Ctrl+Num 6 | H | Ctrl+← / Ctrl+→ |
| Rudder trim left / right | Ctrl+Num 0 / Ctrl+Num Enter | H | Ctrl+Q / Ctrl+E |
| Brakes (both) | Num Del (Num .) | H | B is taken (altimeter) → use `.` (period) |
| Parking brake | Ctrl+Num Del | H | Ctrl+. |
| Flaps up / decrease / increase / full down | F5 / F6 / F7 / F8 | H | same |
| Spoilers toggle / arm | / and Shift+/ | M | same |
| Landing gear toggle | G | H | same |
| Tail-wheel lock | Shift+G | M | same |
| Water rudder | Ctrl+W | M | same |

### 15.2 Engines and systems
| Action | MSFS20 default | Conf |
|---|---|---|
| Throttle cut / decrease / increase / full | F1 / F2 / F3 / F4 | H |
| Propeller low / decrease / increase / high | Ctrl+F1 / Ctrl+F2 / Ctrl+F3 / Ctrl+F4 | M |
| Mixture cut-off / lean / rich / full rich | Ctrl+Shift+F1 / F2 / F3 / F4 | M |
| Engine auto start / auto shutdown | Ctrl+E / Shift+Ctrl+E | H |
| Magnetos (select, then +/−) | M | H |
| Anti-ice toggle | H | H |
| Pitot heat | Shift+H | M |
| Altimeter set to local QNH (Baro sync) | B | H |
| Heading indicator sync to compass | D | M |
| Pushback toggle | Shift+P (then Num1/Num2 to turn) | M |
| Jetway toggle | Ctrl+J | M |
| Cowl flaps open / close | Ctrl+Shift+V / Ctrl+Shift+C | L |

### 15.3 Lights
| Action | MSFS20 default | Conf |
|---|---|---|
| All lights toggle | L | H |
| Landing lights | Ctrl+L (some sheets list Ctrl+I) | M |
| Nav lights | Alt+N | H |
| Beacon | Alt+H | H |
| Strobes | O (some memory says Alt+O) | M |
| Taxi lights | Alt+J | H |
| Panel lights | Shift+Ctrl+L | L |

### 15.4 Autopilot (default C172 G1000 / generic)
| Action | MSFS20 default | Conf |
|---|---|---|
| Autopilot master toggle | Z | H |
| Flight director toggle | Ctrl+F | M |
| Heading hold toggle | Ctrl+H | M |
| Altitude hold toggle | Ctrl+T (one sheet) / Ctrl+Z (memory) | M — pick Ctrl+T, expose in UI |
| NAV (VLOC/GPS) hold | Ctrl+N | M |
| Approach hold | Ctrl+A | M |
| Back-course hold | Ctrl+B | L |
| Airspeed hold (FLC) | Alt+R | M |
| Vertical-speed hold | Ctrl+V | L |
| Wing leveller | Ctrl+V (conflicts; verify) | L |
| Auto-throttle arm / TOGA | Ctrl+Shift+R / Ctrl+Shift+G | L |
| Reference altitude + / − | Ctrl+PgUp / Ctrl+PgDn | M |
| Heading bug + / − | Ctrl+Insert / Ctrl+Delete | M |
| Select heading / altitude / airspeed bug (then +/−) | Shift+Ctrl+H / Shift+Ctrl+Z / Shift+Ctrl+R | M |
| VS reference + / − | Ctrl+Home / Ctrl+End | L |
| NAV/GPS source toggle | Ctrl+Shift+N? | L |

### 15.5 Cameras
| Action | MSFS20 default | MSFS24 change | Conf |
|---|---|---|---|
| Toggle cockpit / external | End | same | H |
| Toggle drone camera | Insert | Shift+X reported | M |
| Reset cockpit view | Ctrl+Space | Shift+Space | H |
| Cockpit look (freelook) | hold right mouse / middle mouse; arrows | arrows | M |
| Cockpit quickview up/right/rear/left | Ctrl+↑ / Ctrl+→ / Ctrl+↓ / Ctrl+← | same | H |
| External quickviews | Ctrl+arrows (in external) | same | H |
| Instrument views 1–10 | Ctrl+1 … Ctrl+0 [verify] | Shift+1 … Shift+0 | M |
| Save / load custom camera | Ctrl+Alt+0–9 / Alt+0–9 | same | L |
| Zoom in / out | Ctrl+Num+ / Ctrl+Num− or wheel | same | L |
| Smart camera toggle | S | same | M |
| Next / previous fixed camera | unbound | unbound | M |
| Drone translate fwd/left/back/right/up/down | W / A / S / D / R / F | same | H |
| Drone pitch up/down, yaw left/right, roll left/right | Num8 / Num2, Num4 / Num6, Num7 / Num9 | same | H |
| Drone reset roll / reset target offset | Space / Num5 | same | M |
| Drone zoom in / out | Num+ / Num− | same | H |
| Drone speed decrease / increase | F1 / F2 | same | M |
| Drone auto-focus toggle | F4 | same | M |
| Drone follow mode toggle / lock next target | Tab / T | Tab is EFB in 2024 (conflict) | M |

### 15.6 UI, time, misc
| Action | MSFS20 default | MSFS24 | Conf |
|---|---|---|---|
| Pause menu | Esc | Esc (some sheets say P) | M |
| Active pause toggle | Pause/Break | same | H |
| Sim rate select (then Num+/Num−) | R | same | H |
| Skip RTC / cutscene | Backspace | same | M |
| ATC window | Scroll Lock | same | H |
| ATC menu option n | 0–9 | same | H |
| Toolbar | mouse to top | same | H |
| EFB | — | Tab | H |
| Toggle VFR map | unbound | unbound | M |
| Screenshot | PrtScn (platform) | same | L |

### 15.7 Recommended gamepad defaults (MSFS Xbox layout, for Gamepad API)
Left stick = pitch/roll; right stick = camera freelook; LT/RT = rudder left/right; A = brakes? (MSFS: RB/LB throttle up/down, A = gear? ) — gamepad defaults vary by sheet [verify]; our proposal: LT/RT rudder, LB/RB throttle −/+, A brakes, B flaps down, X flaps up, Y gear, D-pad = trim/zoom, View = toolbar, Menu = pause, L3 = centre, R3 = reset camera.

---

## 16. Open questions / things to verify in-sim
1. Exact names and default states per assistance preset (All Assists / Middle Ground / True to Life) for every item in §1.2.
2. Exact MSFS20 keys for altitude hold (Ctrl+T vs Ctrl+Z), landing lights (Ctrl+L vs Ctrl+I), strobes (O vs Alt+O), instrument views, custom camera slots.
3. Number of cloud/wind layers exposed in the MSFS custom weather UI (believed 3 clouds; winds several) and whether "aerosol density" and "snow cover" are the exact slider names.
4. Travel-To option list (Cruise / Descent / Approach / Final / Taxi?).
5. MSFS24 drone toggle (Insert vs Shift+X) and pause key (Esc vs P).
6. Whether the GDC 2022 terrain deck covers cloud rendering (forum summary says no).

---

## 17. Source index (all accessed via search summaries on 2026-11-02; most hosts blocked from this container)
- Flight model: [FSElite Ep.3 Aerodynamics](https://fselite.net/content/microsoft-flight-simulator-feature-discovery-series-episode-3-aerodynamics/) · [Windows Central Ep.10](https://www.windowscentral.com/microsoft-flight-simulator-has-new-video-feature-discussing-aerodynamics-game) · [Key.Aero Ep.10](https://www.key.aero/article/microsoft-flight-simulator-episode-10) · [SDK CFD debug](https://docs.flightsimulator.com/msfs2024/html/2_DevMode/SimObject_Editor/Debug/Debug_Aircraft_CFD.htm) · [Forum prop/CFD list](https://forums.flightsimulator.com/t/new-propeller-cfd-soft-body-simulation-aircraft-list/504719) · [Stormbirds C172 CFD](https://stormbirds.blog/2022/04/30/testing-out-the-improved-cessna-172-flight-model-in-msfs/) · [Forum flight-model critique](https://forums.flightsimulator.com/t/all-that-is-wrong-with-the-msfs-flight-model-inertia-stalling-pitch-authority-trim-sensitivity/379936) · [Forum "disappointed"](https://forums.flightsimulator.com/t/personally-disappointed-by-the-flight-model/170891) · [Steam stall thread](https://steamcommunity.com/app/1250410/discussions/4/3960307437816603414/) · [AVSIM MSFS24 dynamics](https://www.avsim.com/forums/topic/654326-msfs-2024-flight-dynamics-and-groundwater-handling-thread/) · [AVSIM 2024 vs 2020 FM](https://www.avsim.com/forums/topic/651279-flight-model-comparison-2024-vs-2020-unexpected-results/) · [FlyAway realism](https://flyawaysimulation.com/ask/answers/how-realistic-microsoft-flight-simulator/)
- Assists: [MSFS Accessibility](https://www.flightsimulator.com/accessibility/) · [MSFS24 Accessibility](https://www.flightsimulator.com/accessibility-msfs-2024/) · [gamepressure realism](https://www.gamepressure.com/microsoft-flight-simulator/realism/z2d860) · [TheGamer MSFS24 settings](https://www.thegamer.com/microsoft-flight-simulator-2024-best-settings-explained-guide/) · [FlyAway nav assist](https://flyawaysimulation.com/ask/answers/change-navigation-assistance-settings-msfs/) · [FlyAway beginner assists](https://flyawaysimulation.com/ask/answers/enable-beginner-assists-msfs-2024/) · [linnetshowto auto-rudder](https://linnetshowto.com/how-to-enable-disable-auto-rudder-microsoft-flight-simulator-2024/) · [AVSIM auto-coordination](https://www.avsim.com/forums/topic/634525-how-to-activate-auto-coordination-in-msfs/)
- World: [Engadget CES 2021](https://www.engadget.com/flight-sim-interview-ces-2021-ai-photogrammetry-bing-224546632.html) · [Engadget Azure AI](https://www.engadget.com/microsoft-flight-simulator-azure-ai-machine-learning-193545436.html) · [PCGamesN](https://www.pcgamesn.com/microsoft-flight-simulator/map) · [TechCrunch](https://techcrunch.com/?p=2023914) · [Asobo GDC 2022](https://www.asobostudio.com/news/asobo-gdc-2022) · [Forum GDC terrain talk](https://forums.flightsimulator.com/t/advanced-graphics-summit-designing-the-terrain-system-of-flight-simulator-representing-the-earth/521236) · [GameRant MSFS24 interview](https://gamerant.com/microsoft-flight-simulator-2024-interview-details-2020-improvements/) · [PC Gamer 30 biomes](https://www.pcgamer.com/games/sim/more-details-on-ms-flight-simulator-2024-including-full-3d-landscapes-in-30-biomes/) · [FSElite 2020 vs 2024](https://fselite.net/content/comparing-microsoft-flight-simulator-2020-to-microsoft-flight-simulator-2024/)
- Weather: [SDK WPR properties](https://docs.flightsimulator.com/msfs2024/flighting/content-configuration/mission-xml-files/weather-xml-wpr-file-properties/index.md) · [FlyAway presets](https://flyawaysimulation.com/ask/answers/msfs-2024-weather-presets/) · [FlyAway weather overview](https://flyawaysimulation.com/ask/answers/weather-live-presets-microsoft-flight-simulator/) · [FlyAway 2020 vs 2024 live weather](https://flyawaysimulation.com/ask/answers/msfs-2020-vs-2024-live-weather/) · [AVSIM presets](https://www.avsim.com/forums/topic/586659-weather-presets-your-way/) · [Forum custom METAR](https://forums.flightsimulator.com/t/editing-weather-custom-metar-input/312515) · [Meteoblue](https://en.wikipedia.org/wiki/Meteoblue) · [GeekWire 2019](https://www.geekwire.com/2019/microsoft-flight-simulator-cloud/)
- Aircraft: [GameRevolution planes](https://www.gamerevolution.com/guides/656135-microsoft-flight-simulator-2020-planes-list-complete-standard-deluxe-premium) · [Windows Central 2020 list](https://www.windowscentral.com/list-microsoft-flight-simulator-planes) · [wiki.gg included aircraft](https://flight.wiki.gg/wiki/Microsoft_Flight_Simulator_(2020)/List_of_included_aircraft) · [Windows Central 2024 list](https://www.windowscentral.com/gaming/xbox/microsoft-flight-simulator-2024-list-of-every-aircraft) · [FSElite 2024 list](https://fselite.net/content/all-aircraft-featured-in-microsoft-flight-simulator-2024/)
- Avionics/cockpit: [MSFS Addons NXi release](https://msfsaddons.com/2021/07/28/working-title-releases-garmin-g1000-nxi-in-the-msfs-marketplace/) · [FSElite NXi episode](https://fselite.net/content/msfs-feature-discovery-series-episode-13-garmin-g1000-nxi/) · [msfs-avionics-mirror](https://raw.githubusercontent.com/microsoft/msfs-avionics-mirror/main/README.md) · [FlyAway cockpit interaction](https://flyawaysimulation.com/ask/answers/cockpit-interaction-microsoft-flight-simulator-vr/) · [Forum Lock vs Legacy Xbox](https://forums.flightsimulator.com/t/cannot-select-legacy-cockpit-interaction-reverts-to-lock-xbox/667061) · [Zendesk EFB](https://flightsimulator.zendesk.com/hc/en-us/articles/16959472213916-Electronic-Flight-Bag-EFB-introduction) · [SimTuts EFB](https://simtuts.com/guides/msfs-2024-efb-guide)
- Cameras: [Zendesk camera FAQ](https://flightsimulator.zendesk.com/hc/en-us/articles/360016003159-Camera-Video-FAQ) · [FlyAway cameras](https://flyawaysimulation.com/ask/answers/use-camera-controls-microsoft-flight-simulator/) · [FlyAway drone](https://flyawaysimulation.com/ask/answers/use-move-drone-camera-microsoft-flight-simulator/) · [Forum quickviews guide](https://forums.flightsimulator.com/t/guide-how-to-use-keys-to-switch-between-quickviews-freelook-camera-also-drone-camera-fixed-views/202050) · [Forum drone tips](https://forums.flightsimulator.com/t/how-to-using-the-drone-cam-tips-tricks/128165) · [FRAMED](https://framedsc.com/GameGuides/microsoft_flight_sim.htm) · [Forum head movement](https://forums.flightsimulator.com/t/more-realistic-head-movement/676026) · [MSFS Physics Camera](https://flightsim.to/addon/114953/msfs-physics-camera)
- UI/ATC/planning: [gamepressure toolbar](https://www.gamepressure.com/microsoft-flight-simulator/toolbar/z7d85f) · [FlyAway toolbar](https://flyawaysimulation.com/ask/answers/use-microsoft-flight-simulator-toolbar/) · [FlyAway World Map](https://flyawaysimulation.com/ask/answers/use-world-map-microsoft-flight-simulator/) · [FlyAway planner](https://flyawaysimulation.com/ask/answers/use-built-in-flight-planner-microsoft-flight-simulator/) · [Forum full-UI World Map](https://forums.flightsimulator.com/t/msfs-2024-full-ui-world-map/756577) · [FlyAway ATC](https://flyawaysimulation.com/ask/answers/use-atc-microsoft-flight-simulator/) · [Forum IFR clearance](https://forums.flightsimulator.com/t/no-option-to-request-ifr-clearance-from-default-atc/448922) · [Forum ATC fixes](https://forums.flightsimulator.com/t/minor-fixes-to-atc-major-immersion-gains/568444)
- Activities/replay/MP: [Fandom landing challenges](https://flight.fandom.com/wiki/Microsoft_Flight_Simulator_(2020)/Landing_Challenges) · [Closed beta notes](https://www.flightsimulator.com/closed-beta-now-available/) · [Windows Central landing tips](https://www.windowscentral.com/microsoft-flight-simulator-landing-challenge-tips-and-tricks) · [Fandom bush trips](https://flight.fandom.com/wiki/Microsoft_Flight_Simulator_(2020)/Bush_Trips) · [Fandom training](https://flight.fandom.com/wiki/Microsoft_Flight_Simulator_(2020)/Flight_Training) · [MSFS Addons replay](https://msfsaddons.com/2024/12/03/the-replay-mode-in-microsoft-flight-simulator-2024/) · [MSFS Addons career](https://msfsaddons.com/2024/09/19/heres-how-the-career-mode-works-in-microsoft-flight-simulator-2024/) · [Windows Central multiplayer](https://www.windowscentral.com/how-play-multiplayer-microsoft-flight-simulator) · [Forum MP quick guide](https://forums.flightsimulator.com/t/how-to-quick-guide-to-msfs-multiplayer/99647)
- Keys: [flyawaysimulation 2020 keys](https://flyawaysimulation.com/ask/answers/msfs-2020-default-keyboard-controls/) · [gamesradar](https://www.gamesradar.com/microsoft-flight-simulator-2020-keyboard-controls/) · [pcgamer](https://www.pcgamer.com/microsoft-flight-simulator-2020-controls-keyboard-controller/) · [allanville](https://aviation.allanville.com/misc/fs20-keyboard-shortcuts) · [cheatography](https://cheatography.com/nimasmi/cheat-sheets/microsoft-flight-simulator-2020/) · [flightsimbeek PDF](https://www.flightsimbeek.nl/wp-content/uploads/2024/02/MSFS-Keyboard-Commands.pdf) · [msfsaddons 2024 keys](https://msfsaddons.com/msfs-2024-faq/keyboard-controls/) · [FlyAway 2024 keys](https://flyawaysimulation.com/ask/answers/default-keyboard-controls-microsoft-flight-simulator-2024/) · [editorskeys 2020 preset in 2024](https://www.editorskeys.com/blogs/news/how-to-restore-microsoft-flight-simulator-2020-key-commands-in-msfs-2024) · [keyboardcontrols.com](https://keyboardcontrols.com/shortcuts/games/microsoft-flight-simulator/)
- Reviews/feel: [OpenCritic](https://opencritic.com/game/9793/microsoft-flight-simulator) · [The Register](https://www.theregister.com/2020/08/17/microsoft_flight_simulator_2020_review/) · [TechRadar MSFS24](https://www.techradar.com/gaming/microsoft-flight-simulator-2024-review) · [Checkpoint MSFS24](https://checkpointgaming.net/reviews/2024/12/microsoft-flight-simulator-2024-review-rough-takeoff-solid-landing/) · [Stormbirds state of the sim](https://stormbirds.blog/2025/01/03/state-of-the-sim-how-is-microsoft-flight-simulator-2024-right-now-buy-it-now-or-wait/) · [Jon Beckett XP12 vs MSFS24](https://jonbeckett.substack.com/p/how-does-x-plane-12-really-compare) · [q8pilot comparison](https://q8pilot.com/briefings/xplane-12-vs-msfs-2024)
