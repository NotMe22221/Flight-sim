# src/audio — procedural Web Audio

Everything is synthesized at runtime (no sample assets): a Lycoming IO-360-style piston engine
with propeller, airframe wind / buffet / rain / ground roll, C172 warnings, UI sounds and
radio squelch, plus Web Speech API voices. Research and design values:
`docs/research/06-audio-and-input.md` PART A (A1–A9).

## Using it

```ts
import { AudioSystem } from './audio';

const audio = new AudioSystem({ config: c172Config, events: bus });   // implements AudioMixer
flyButton.onclick = () => audio.resume();                             // MUST be in a user gesture

// every render frame
audio.setControls(snapshot.inputs);          // starter + throttle (not in AircraftState)
audio.setSurface(world.env.surface);         // 'paved' | 'grass' | 'water' | 'unknown'
audio.setListener(cameraPosNED, cameraVelNED); // optional: exact exterior distance/Doppler
audio.update(dt, snapshot.aircraft, snapshot.camera, snapshot.weather);
// or simply: audio.updateSnapshot(dt, snapshot)   (also mutes while paused)

audio.setMarker('outer' | 'middle' | 'inner' | null);  // from the nav receiver
audio.speak('Cessna one seven two, cleared to land runway two eight right.', 'atc');
```

`EventBus` subscriptions (when `events` is passed): `aircraft:touchdown` → thump + chirp,
`autopilot:changed` (engaged → disengaged) → AP-disconnect two-tone, `flight:reset` → stop speech
and marker. Headless (Node, tests, smoke test, no Web Audio): every call is a silent no-op and
nothing throws; `ready` stays false.

## Graph

```
 crank Hz (ConstantSource = rpm/60 · Doppler) ─ fan-out ─► cycle oscs ×½ · prop osc ×blades · cadence ×cyl/2 · ring ×8·cyl/2
 ┌─ EngineSynth ─────────────────────────────────────────────────────────────┐
 │ cycle PeriodicWaves (bright/dull xfade by MAP) ─┐                           │
 │ pink → LP 180 Hz rumble ────────────────────────┴► catch env → exhaust     │
 │   peaks 120/350/600 Hz → LP 5 kHz ───────────────────────────────┐         │
 │ pink → BP 400–1200 Hz intake · white → HP 2.5 kHz × ring(8·f0) mech│        │
 │ saw 70–110 Hz → BP 1.2 kHz × cadence AM (starter) · crackle ticks ├► out ──┼─► engine bus ─┐
 │ PropellerLayer: blade-pass PeriodicWave + pink BP vortex hiss ────┘         │               │
 └────────────────────────────────────────────────────────────────────────────┘               │
 EnvironmentSynth: wind LP + whistle BP + buffet rumble → buffet AM; rain HP + drops;           │
   roll LP × wheel/bump AM; tyre hiss; one-shot thump/chirp ───────────► environment bus ─┐     │
   flap motor (saw+square → BP 1.1 kHz) ─────────────────────────────► cockpit bus ─┐     │     │
 Warnings: stall horn, clacker, marker tones, AP / altitude chimes ──► cockpit bus ─┤     │     │
           UI clicks/switch/warn/confirm/error ─────────────────────► ui bus ──┐    │     │     │
 radio squelch click + static around ATC speech ────────────────────► atc bus ─┤    │     │     │
                                                                               │    ▼     ▼     ▼
                                                                               │  cabin  ViewStage: engine LP (cabin 1.2 kHz | air absorption) → duck
                                                                               │  (0.35   env LP (cabin 5 kHz | air absorption) → distance → pan
                                                                               ▼  outside)    │
                                                      master (−6 dBFS) ◄───────┴──────┴───────┘ → limiter (−12 dB, 4:1) → destination
 speechSynthesis ──► (browser) — cannot be routed through Web Audio; volume = master × atc
```

## Parameter table

| Layer | Law (drive) | Source |
|---|---|---|
| Firing frequency | f₀ = rpm/60 · cyl/(strokes/2) — 2400 rpm, 4 cyl → 80 Hz | §A2.1 |
| Pulse train | one PeriodicWave at the 4-stroke cycle (rpm/120) with `cyl` unequal pulses (±8 % amp, ±0.4 % timing) + explicit crank order 0.25 | §A2.2/A2.4 |
| Harmonic roll-off | A_k = table (1, .55, .42, .30, .20, .14, .10, .07), −12 dB/oct beyond k = 8; load law A_k·k^(−0.3(1−load)) via bright/dull crossfade | §A2.2 |
| Loudness | (0.25 + 0.75·x^1.5)·(0.55 + 0.45·load), x = rpm/rated, load = MAP fraction; monotonic, clamped 0..1 | §A2.5 |
| Exhaust resonance | peaking 120 Hz Q3 +9 dB, 350 Hz Q2.5 +6 dB, 600 Hz Q2 +4 dB, LP 5 kHz | §A2.3 |
| Intake | pink → BP (400 + 800x) Hz Q 0.8, gain 0.12·(0.3 + 0.7·throttle)·√x | §A2.2 |
| Mechanical | white → HP 2.5 kHz × 8·f₀ ring mod, gain 0.05·x | §A2.2 |
| Idle lope | 1.3 + 0.47 Hz LFOs → ±26 cents and 12 % AM, fading out 600 rpm above idle | §A2.2 |
| Start / stop | starter whine saw 70→110 Hz, BP 1.2 kHz, gain 0.15, AM at compression rate; cough-and-catch envelope 0.6 s; rundown ticks 1.2 s | §A2.6 |
| Propeller tone | BPF = blades·rpm/60 (2 blades @2400 → 80 Hz), 6 harmonics k^−1.2; gain 0.22·clamp((M_tip−0.25)/0.55)^2.5·(0.55 + 0.45·thrust) | §A3 |
| Prop vortex | pink → BP St·U/h (St 0.2, U = 0.75·v_tip, h 15 mm), gain 0.05·x³ | §A3 |
| View balance | prop ×0.7 cockpit / ×1.6 outside; engine LP 1.2 kHz cockpit, 12 kHz·e^(−(d−200)/2500) outside; inverse distance ref 15 m | §A1.4/A3/A6 |
| Doppler | (c − v_l)/(c − v_s), clamped 0.5..2, applied to the crank control and noise cutoffs | §A6 |
| Wind | v = IAS/70 (≤1.4); gain v²·(0.6 + 0.15·flaps/30) ≤ 1 (∝ IAS²); LP 300 + 2500v²; whistle BP 1200 + 1500v Hz, −12 dB | §A4 |
| Buffet | intensity ramps over the last 2° before α_stall, ≥0.3 with stall warning, 1 stalled, × clamp(IAS/20); 9.3 + 13.1 Hz AM depth 0.25·k, LP 70 Hz rumble 0.45·k | §A4 |
| Rain | intensity (rate/25 mm/h)^0.6; white → HP 3 kHz, 0.25·i·(0.3 + 0.7v); drop clicks 0.5·√i; snow silent | §A4 |
| Ground roll | s = wheel/40 m/s; LP (150 + 250s)·surface; gain 0.35·s^1.5·surface (grass ×1.6, LP ×0.7, 2.7 Hz bumps); wheel AM at v/(2πr) | §A5.4 |
| Touchdown | sine 55→35 Hz / 0.12 s, gain clamp(|vs|/3, 0.1, 1); pink LP 300 Hz 60 ms; chirp white BP 2.2 kHz Q3, 50–120 ms, clamp(gs/40 + |drift|/5) | §A5.4 |
| Flap motor | saw 140 Hz + square 280 Hz → BP 1.1 kHz Q2, gain 0.12 (cockpit bus); −6 % pitch sag at start, +3 % at stop | §A5.2 |
| Stall horn | saw + square (+7 ct) ≈ 1.95–2.2 kHz, 6 Hz ±10 ct vibrato, BP 2.3 kHz → HP 300 Hz; gated by stall warning; 0.35·(0.35 → 1 as α → α_stall) | §A5.1 (UNVERIFIED pitch) |
| Overspeed clacker | 4 Hz, 3 ms noise clicks → BP 2 kHz (jets only; the C172 has none) | §A5.3 |
| Marker beacons | OM 400 Hz 2 dashes/s; MM 1300 Hz dot-dash 95/min; IM 3000 Hz 6 dots/s | ICAO Annex 10 |
| AP disconnect / altitude alert | 1200/900 Hz two-tone × 3 (1.4 s) / C6 + E6 bell chime | — |
| UI | click (2 ms BP 2.5 kHz + 20 ms 180 Hz), switch (2 clicks 35 ms), warn (3 × 880 Hz), confirm (660 → 990 Hz), error (220 Hz square) | §A5.5 |
| Buses | engine 0.8, environment 0.7, cockpit 1.0, ui 0.6, atc 0.9, master 0.5; limiter −12 dB knee 20 ratio 4 | §A1.4 |
| Speech | ATC rate 1.05 pitch 0.9; pilot 1.0/1.0; copilot 1.0/1.12; en-US preferred; ≤160-char chunks at sentence boundaries | §A5.6 |

## Rules this module follows

- **Autoplay**: the AudioContext is created lazily in the first `resume()` (call it from a click /
  key handler). The graph re-resumes on later gestures and on `visibilitychange` while
  'suspended' / 'interrupted' (iOS), plays a 1-sample silent buffer to unlock iOS and sets
  `navigator.audioSession.type = 'playback'` where available. A 'closed' context is rebuilt.
- **No zipper noise**: audible params are never assigned through `.value`; continuous control
  uses `SmoothParam` (`setTargetAtTime`, τ 20–120 ms, skipping changes below a tolerance so
  steady flight schedules ~no automation), envelopes use `setValueAtTime` / ramps on fresh nodes.
  Tests enforce this with a guard on the mock `AudioParam.value` setter.
- **No per-frame allocation**: update paths reuse preallocated inputs/scratch; transient nodes are
  only created for discrete events (touchdown, UI, chimes, squelch) and disconnect themselves in
  `onended`.
- **One rpm control**: a single ConstantSource carries rpm/60 · Doppler and fans out (gain
  scalers) into every tonal partial, so pitch moves coherently and glitch-free (§A1.3).

## CPU budget

Persistent graph = 104 nodes: 18 oscillators, 7 looping buffer sources (3 shared noise buffers:
white 4 s, pink 4 s, crackle 2 s ≈ 1.9 MB at 48 kHz), 24 biquads, 52 gains, 1 constant source,
1 stereo panner, 1 compressor (engine 46, environment 31, warnings 13, view stage 6, buses 8).
Rough estimate from per-node render costs in Chromium: ≈ 40–60 µs per 128-frame quantum
⇒ ~2 % of one core at 48 kHz (doc target 1–3 %; not yet profiled in a browser). The main-thread
cost of `update()` is ~60 cheap comparisons and only a handful of `setTargetAtTime` calls per
frame. Idle voices (flap motor, stall horn, marker tone) could be created on demand if profiling
ever shows a need.

## Known limitations

- `speechSynthesis` output cannot be routed through Web Audio (no radio band-pass on the voice);
  squelch/static are synthesized around it and its volume follows master × atc.
- `AircraftState` carries neither the starter switch, the throttle lever, the surface type nor
  the camera's world position: call `setControls`, `setSurface`, `setListener` (tower / flyby
  cameras otherwise use a 150 m co-moving estimate without Doppler).
- No jet (turbofan) voice yet (§A8); jets get the piston synth driven by `rpm`.
- Stall-horn pitch and C172 idle character are design values, to be checked against a CC0
  recording with an FFT (§A5.1).

## Tests

`npx vitest run src/audio` — Node only, against `testing/mockAudioContext.ts` (records every
automation call, guards direct `.value` writes, controllable clock that fires `ended`).

Checked once in real Chrome (headless Chrome for Testing 153, OfflineAudioContext renders of the
actual classes): idle 650 rpm peaks at 22 Hz (firing) + 11 Hz (crank order); 2400 rpm at
80 / 160 / 240 / 320 Hz + 40 Hz; Doppler 1.2 moves the fundamental to 96 Hz; exterior view
+3.3 dB (prop ×1.6); stall horn peak 2170 Hz; wind RMS ×4.4 from 30 → 60 m/s IAS (gain ×4);
cranking whine 102 Hz; a live `AudioSystem` reaches 'running' with no console errors.
