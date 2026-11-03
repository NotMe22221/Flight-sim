# src/atc — menu-driven scripted ATC

MSFS-style ATC (docs/research/01 §8, docs/research/05 §9): numbered options (keys 1–9, 0),
FAA phraseology, an ATIS built from the sim weather, and a deterministic state machine that
follows the flight from the ramp to the ramp. **Pure logic** — no DOM, no Three.js, no timers,
no `Date.now`, no `Math.random`: time advances only through `update(dt)`, and the reply
latency and squawk codes come from a seeded generator, so the same inputs always produce the
same transcript. Speech and subtitles leave through callbacks.

## Wiring

```ts
import { AtcController } from './atc';

const atc = new AtcController({
  callsign: 'N172FS', aircraftType: 'Cessna', nav: navDb,
  emit: (m) => bus.emit('atc:message', m),                       // { from, text, frequencyMHz }
  emitOptions: (options) => bus.emit('atc:options', { options }), // only when the list changes
  speak: (text, voice) => audio.speak(text, voice),              // spelled-out text, 'atc' | 'pilot'
});
atc.reset(navDb.getAirport('KSFO') ?? null);   // or null: nearest airport within 3 nm / en route if airborne
// every frame (after the FDM step):
atc.update(dt, snapshot.aircraft, snapshot.weather, snapshot.time.utcMs);
// on SimAction 'atcOption1'..'atcOption9' / 'atcOption0':
atc.select(n);                                  // 1..9, 0 = 10th; false while a reply is pending
```

Read-only state for the ATC panel: `phase`, `frequencyMHz` (COM the pilot is on), `options`,
`awaitingReply`, `squawk`, `landingClearance`, `patternLeg`, `airportIcao`, `runwayIdent`,
`atisLetter`, `metar`.

Subtitles (`text`) use digits ("runway 28R", "120.5"); speech (`speak`) is spelled the way it is
said ("runway two eight right", "one two zero point five", "niner"). ATIS speech is ~600
characters — the audio side should split at sentence boundaries (Chrome's 15 s TTS cut-off,
research 05 §9.3).

## Files

| File | Purpose |
|---|---|
| `phraseology.ts` | `Spoken {text, speech}` builders: digits, phonetic alphabet, altitudes (group form, FL ≥ 18 000), altimeter, heading, runway, frequency, wind, temperature, Zulu time, squawk, miles, compass words |
| `callsign.ts` | `makeCallsign('N172FS', 'Cessna')` → full "November One Seven Two Foxtrot Sierra" / short "Cessna Two Foxtrot Sierra" |
| `compose.ts` | `say` template tag (builds text and speech together), `joinSpoken`, `sentence` |
| `surfaceObs.ts` | `WeatherState` → METAR-rounded observation (wind, vis, FEW/SCT/BKN/OVC in ft AGL, T/Td via Magnus, altimeter), flight category |
| `atis.ts` | `buildAtis` (ATIS or AWOS), `metarLine`, sky/visibility/weather phrases |
| `atisTracker.ts` | ATIS letter: deterministic start per airport, +1 every hour and on content change (≥ 60 s apart) |
| `field.ts` | Facilities from `airport.frequencies` (ATIS/AWOS, CLD, GND, TWR, DEP/APP, CTAF → 122.9 fallback), facility names, pattern altitude, `runwaysInUse` (nav `runwayInUse` + parallels, calm → longest), `patternSideFor` |
| `geometry.ts` | Runway frame (reuses `activities/runwayFrame.relativeToRunway`), `classifyPatternLeg`, `isEstablishedOnFinal`, `choosePatternEntry`, hold-short box |
| `radio.ts` | `RadioQueue`: immediate and delayed transmissions in sim time |
| `messages.ts` | All pilot / controller / CTAF / readback templates |
| `session.ts` | `AtcSession`: mutable state, callsign abbreviation, reply scheduling, per-airport contexts |
| `actions.ts`, `patternActions.ts` | What each option does (pilot call → controller reply → state change) |
| `monitors.ts` | Automatic detection: liftoff/touchdown, hold short, handoff, inbound, legs, landing clearance, go-around, exit, parked |
| `menu.ts` | Options for the current state |
| `AtcController.ts` | Public class, update loop, option publishing |

## State machine

```
            request taxi (GND)                stopped ≤ 250 m from a           ready for departure (TWR)
  PARKED ─────────────────────▶ TAXI_CLEARED ───────────────────────▶ HOLDING_SHORT ─────────────────────▶ CLEARED_TAKEOFF
    ▲   ATIS / VFR clearance      "taxi to runway 28R,   runway end ≥ 2 s (also at start      ◀── "unable" (hold short)      │
    │   (no phase change)          hold short of 28R"    when spawned on the runway)                                         │ airborne ≥ 1 s
    │                                                                                                                         ▼
    │ stopped, engine off 3 s                                     closed traffic ─────────────────────────────────── DEPARTING
  TAXI_IN                                                                │                                                │ > 3 nm or > 2 000 ft AGL:
    ▲ clear of runway → "taxi to parking" (GND)                           │                                                │ "contact Departure 120.9" /
    │                                                                    ▼                                                ▼ "frequency change approved"
  LANDED ◀── touchdown (full stop) ─────────────────────────────────── PATTERN ◀── TWR: "enter right downwind …" ── INBOUND ◀── ENROUTE
    "exit runway when able,              leg detection, reports,             (entry by geometry)          ≤ 12 nm, closing    (flight following,
     contact Ground" (< 20 kt)            landing clearance at ≤ 3 nm final,                               and heading for a   ATIS, destinations)
                                          go-around, touch-and-go loop ───┐                                  towered field (or
                                                                          │                                  "prepare to land at …")
                                                        ▲                 │
                                                        └─────────────────┘
```

* **Readbacks**: every instruction that needs one is offered as option 1 ("Read back: …").
  The pilot's transmission goes out immediately; requests get the controller's reply
  1.5–2.75 s of sim time later (`REPLY_DELAY_MIN_S`/`MAX_S`), and the state changes when the
  reply goes out. Selections are refused while a reply is pending.
* **Unsolicited calls** (made once, guarded by flags/phase changes, and only to a pilot tuned
  to that controller — nobody calls an aircraft that never contacted the tower): departure
  handoff, landing clearance when established on final within 3.2 nm, go-around (after a
  landing clearance, below 500 ft, climbing > 1.5 m/s for 2 s and ≥ 30 m above the lowest
  point — a glidepath correction is not a go-around), "exit runway when able, contact Ground"
  below 10 m/s ("remain this frequency" when the tower has no ground frequency), "frequency
  change approved" when leaving the pattern.
* **Flight following ends on request**: on an arrival (automatic or picked from the menu) the
  INBOUND menu offers "Request landing at <field>" to the radar controller ("radar service
  terminated, squawk VFR, contact <field> Tower …", or "change to advisory frequency approved"
  at an untowered field) and "Cancel flight following". Approaching a towered field does not
  end radar service by itself — the aircraft may be passing over it.
* **Go-around → re-clearance**: after a go-around (or touch-and-go) the next landing clearance
  waits until the aircraft has flown a crosswind/downwind/base leg (`flags.armed`).
* **Untowered fields** (no TWR frequency): the same phases, driven by CTAF self-announcements
  ("Half Moon Bay traffic, Cessna 2FS, …, Half Moon Bay.") and the same geometry; nobody
  replies.
* **Robustness**: liftoff from any ground phase → DEPARTING (or PATTERN for closed traffic);
  touchdown from any airborne phase → LANDED at the airport within 3 nm (TAXI_IN without a
  field when it is an off-field landing); a touch-and-go that stops becomes a full stop;
  arrivals that turn away beyond 15 nm (or 5 nm beyond a farther destination picked from the
  menu) revert to ENROUTE; leaving the pattern ends closed traffic; a start counts as holding
  short only when lined up on the runway (not beside it); a later stop at another runway end
  while holding short makes that the departure runway; a readback not given before the next
  call is dropped; parking ends the exchange (the next call is a full-callsign initial contact)
  and a reset forgets the ATIS letter heard.

## Phrases (examples from the KSFO test transcript)

```
ATIS  San Francisco International information Uniform. 1856Z. Wind 270 at 12 gusts 18. Visibility 10. Few clouds at 1,200,
      ceiling 20,000 broken. Temperature 18, dew point 11. Altimeter 30.05. Landing and departing runways 28L and 28R.
      Advise on initial contact you have information Uniform.
P     San Francisco Ground, N172FS, at the ramp, with information Uniform, request taxi, VFR departure.
GND   Cessna 2FS, San Francisco Ground, taxi to runway 28L, hold short of runway 28L.
P     Taxi to runway 28L, hold short of runway 28L, Cessna 2FS.
P     San Francisco Tower, N172FS, holding short runway 28L, ready for departure.
TWR   Cessna 2FS, San Francisco Tower, wind 270 at 12 gusts 18, runway 28L, cleared for takeoff.
TWR   Cessna 2FS, contact San Francisco Departure 120.9.
DEP   Cessna 2FS, San Francisco Departure, squawk 3603, radar contact 2 miles northwest of San Francisco, altimeter 30.05, maintain VFR.
P     San Francisco Departure, Cessna 2FS, request landing at San Francisco.
DEP   Cessna 2FS, radar service terminated, squawk VFR, contact San Francisco Tower 120.5.
P     San Francisco Tower, N172FS, 11 miles north, 3,000, inbound for landing, full stop, with information Uniform.
TWR   Cessna 2FS, San Francisco Tower, enter right downwind runway 28R, report midfield downwind. Information Victor now current, altimeter 30.05.
TWR   Cessna 2FS, wind 270 at 12 gusts 18, runway 28R, cleared to land.
TWR   Cessna 2FS, go around, fly runway heading, climb and maintain 1,000, make right traffic runway 28R.
TWR   Cessna 2FS, exit runway when able, contact Ground 121.8.
GND   Cessna 2FS, San Francisco Ground, taxi to parking.
CTAF  Half Moon Bay traffic, Cessna 2FS, turning left base runway 30, Half Moon Bay.
```

Conventions: callsign in full on first contact with each facility, abbreviated (type + last
three) once the controller has abbreviated it; CTAF calls use the short form. Winds from ATIS
and tower are **magnetic** (FAA practice; WMM declination at the field, converted from the
observed direction and rounded once), the METAR line is true. FAA JO 7110.65 §2-4-17 number
forms: "wind two seven zero at one five gusts three five", frequencies spoken to two decimals
("one three five point two seven" for 135.275; the subtitle keeps 135.275), "niner", runways
without a leading zero (also in menu labels). Runway in use: nav `runwayInUse` (largest
headwind, ties → longest); below 5 kt the calm-wind runway (the longest, §3-5-1; "wind calm"
is reported below 3 kt); parallels are listed together and the arrival gets the one on its side. Pattern side:
parallel runways use the outer side (L → left, R → right); otherwise towered fields assign
the side the arrival is on and untowered fields use left traffic. Pattern altitude: field
elevation + 1 000 ft. Facility names use the airport's municipality ("San Francisco Tower").

## How to add a phase or an option

1. Add the phase to `AtcPhase` in `types.ts`.
2. Put the pilot call and controller reply in `messages.ts` (use the `say` tag so text and
   speech stay in sync; wrap numbers in the `phraseology.ts` builders).
3. Write the action in `actions.ts`/`patternActions.ts`: `s.pilotSays(facility, cs => …)` then
   `s.atcReplies(facility, cs => …, () => { s.setPhase('NEW_PHASE'); s.expectReadback(…); })`.
   CTAF: `s.announce(ctaf, …)` and change state directly.
4. Offer it in `menu.ts` for the phases where it makes sense (`via(facility)` appends
   "(Tower 120.5)"); keep at least one option per phase.
5. Automatic transitions go in `monitors.ts` → `monitorPhase`; guard unsolicited calls with
   `s.flags.callIssued`/state so they fire once, check `!s.radio.busy`, and keep per-frame code
   allocation-free (use `greatCircleDistance`, the shared `s.rel`, 1 Hz `slowTickS` for
   database queries).
6. Extend the scenario in `AtcController.test.ts` (the `Harness` flies straight segments in a
   runway frame and records messages, options and phases).

## Tuning (`DEFAULT_ATC_TUNING`, override per instance)

| Field | Default | Meaning |
|---|---|---|
| `handoffDistanceM` / `handoffHeightM` | 3 nm / 2 000 ft | tower → departure handoff |
| `inboundRangeM` / `inboundCancelRangeM` | 12 nm / 15 nm | automatic INBOUND (closing > 10 m/s for 3 s, track within 30° of the bearing) / abandon |
| `landingClearanceRangeM` | 3.2 nm | landing clearance when established on final inside this |
| `goAroundMaxHeightM` / `goAroundClimbMs` | 500 ft / 1.5 m/s | go-around detection |
| `stoppedSpeedMs` | 0.5 m/s | "stopped" (hold short after 2 s, parked after 3 s engine off) |
| `patternExitRangeM` | 5 nm | leaving the pattern → ENROUTE |
| `exitRunwaySpeedMs` | 10 m/s | "exit runway, contact Ground" |

Geometry limits: `PATTERN_LIMITS` (2.5 nm lateral, 5 nm final, 3 000 ft, 300 m centreline
corridor widening 0.15 m/m on final, downwind ≥ 300 m abeam, aligned ±45°, downwind ±60° of
the reciprocal), `FINAL_LIMITS` (±20° track, lateral max(75 m, 6°), height below a ~6° wedge
+ 150 m), `HOLD_SHORT_BOX` (−250…+400 m along, ±250 m across).

## Tests (`npx vitest run src/atc`)

* `phraseology.test.ts` — callsigns, niner (and no tree/fife), altitudes, altimeter, headings,
  runways, frequencies, winds, temperatures, Zulu time, squawk, miles, compass words.
* `atis.test.ts` — KSFO 280@12G18 FEW012 BKN200 18/11 A3005 → runways 28L and 28R, exact text
  and speech, METAR line, magnetic wind (270), facilities from the real data, AWOS form,
  letter tracker (hourly, content change, anti-flap).
* `geometry.test.ts` — runway frame, hold-short/on-runway, legs for left and right traffic
  (and mirrored positions rejected), outside cases, established on final, entry choice.
* `AtcController.test.ts` — full KSFO round trip with the real NavDb: phase sequence,
  pilot-before-controller and 1.5–3 s reply delays, non-empty options every frame, options
  emitted only on change, unsolicited calls exactly once, go-around on short final and
  re-clearance, frequencies, spelled-out speech.
* `AtcController.flows.test.ts` — Half Moon Bay CTAF flow (no controller replies), spawn on
  the runway, airborne start, closed traffic with touch-and-go.
* `AtcController.review.test.ts` — regressions from the adversarial review (each failed before
  its fix): 7110.65 frequency/gust forms, menu destinations 15–30 nm away, off-field landing,
  no unsolicited tower calls to a pilot off frequency, tower without ground frequency,
  `select(NaN)`, full callsign after parking, ATIS heard reset, closed traffic ended by leaving
  the pattern, glidepath correction ≠ go-around, label designators, parallel CTAF runway,
  start beside the runway, magnetic wind rounding, readbacks (straight-in, closed-traffic
  takeoff, stale ones dropped), flight following on arrival (no termination when passing a
  field, "request landing", advisory frequency), hold-short re-targeting, 5 kt calm runway.

## Known limitations / proposed contract changes

* No taxiway data: taxi clearances are "taxi to runway X, hold short of runway X"; no taxi
  route or crossing clearances; holding short is detected geometrically.
* No traffic: no sequencing ("number two"), no traffic advisories, no runway-occupied
  go-arounds. Single runway in use for departures and arrivals (no KSFO-style 1L/1R departures).
* Facility names come from the municipality ("San Francisco Departure", not "NorCal
  Departure"); TRACON/Center names and frequencies are not in the data. Some OurAirports
  frequencies are odd (KSFO ATIS 113.7 is the VOR voice channel) and are used as published.
* `src/core/types.ts`: `SimEvents['atc:message']` could carry `speech` and `voice` so the audio
  module can subscribe to the bus instead of a separate `speak` callback; `AudioMixer.speak`
  already accepts `'atc' | 'pilot'`.
* Taxi phraseology predates the 2010 change (7110.65 §3-7-2 is "runway 28L, taxi via …"): with
  no route data the clearance stays "taxi to runway 28L, hold short of runway 28L".
* The controller abbreviates the callsign in its first reply (common US practice; 7110.65
  §2-4-20 also allows replying with the form the pilot used). The pilot only abbreviates after
  that, and goes back to the full callsign on every retune (including listening to ATIS).
* Reply latency counts from the start of the pilot's transmission (speech duration is unknown
  here); the audio queue plays the reply after the pilot's call.
* TAXI_CLEARED / HOLDING_SHORT / CLEARED_TAKEOFF never return to PARKED by themselves (shutting
  down at the hold-short line keeps the departure options; reset to start over).
* Untowered touch-and-go has no menu option. A full-stop landing followed by a new takeoff goes
  to DEPARTING, or to PATTERN if closed traffic was announced and not left.
* The automatic INBOUND only picks the nearest towered field the aircraft heads for (±30°,
  closing > 10 m/s for 3 s, ≤ 12 nm); untowered destinations are chosen from the menu.
* App wiring (src/app/Simulator.ts, not this module): `plugins.atc.update` is fed `this.interp`,
  which holds the replayed pose while the replay controller is active, so a replayed takeoff
  or landing drives the state machine (and the jump back at the end of the replay looks like a
  liftoff/teleport). Skip the ATC update while `replayer.active`. `dt` is the display-frame dt
  (not scaled by time compression): radio latency stays in real seconds, which is intended.
