# 06 — Audio (procedural Web Audio) & Input (keyboard / mouse / gamepad / touch)

Research date: 2026-11-02. Target: browser flight sim in the spirit of MSFS, Three.js r0.187 + TypeScript + Vite 7,
laptop GPU, static site. Contracts this document implements against: `src/core/types.ts` —
`AudioMixer`, `InputSnapshot`, `SimAxis`, `SimAction`, `ControlInputs`, `SimEvents`, `AircraftState`, `CameraState`.

Primary sources that could not be reached from the research container (blocked hosts) are marked **UNVERIFIED** and
were cross-checked only through search-engine snippets: `docs.flightsimulator.com`, `developer.mozilla.org`,
`w3c.github.io`, `freesound.org`, `audiokinetic.com`, `geo-fs.com`, `pcgamer.com`, `gamesradar.com`, `flyawaysimulation.com`,
`cheatography.com`, `meadowtools.com`, `core.ac.uk`. GitHub (`github.com`, `raw.githubusercontent.com`) was reachable, so
Chromium's gamepad source and three.js r187 audio source were read directly.

---

## 0. Recommendations (tiered)

| Area | v1 (ship with C172) | v2 | Notes |
|---|---|---|---|
| Engine sound | **Procedural**: combustion pulse train (AudioWorklet) → exhaust resonator (3 peaking biquads) + harmonic bank (PeriodicWave) + filtered noise, all driven by one `rpmHz` AudioParam | Add sample-based RPM loop layer (CC0) crossfaded with the synth for "texture" | Procedural = zero assets, perfect RPM tracking, ~1–2 % of one CPU core |
| Propeller | Harmonic comb at blade-pass frequency + band-passed vortex noise, gain ∝ tip-Mach | Selfridge/Reiss physical model | For a 2-blade prop the BPF equals the 4-cyl firing frequency (RPM/30) — fuse them |
| Wind | Pink noise → LP/BP filters, gain ∝ IAS², buffet AM near stall | Rain layer, open-window/door | |
| Warnings/systems | Synth stall horn, flap motor whine, touchdown thump, tyre rumble, switch clicks | Kenney CC0 UI clicks (optional) | Stall horn pitch is **UNVERIFIED** (no public measurement found) |
| Spatial | Interior bus (dry, low-passed) ↔ exterior bus via `THREE.PositionalAudio` on the aircraft, manual Doppler on `rpmHz` | HRTF for external cams | Web Audio removed built-in Doppler |
| Keyboard | MSFS 2020 "Transversal" layout (table §B2), `KeyboardEvent.code`, our own hold/ramp logic | Rebind UI | MSFS 2024 changed defaults but ships a "Keyboard 2020 Transversal" preset |
| Mouse | Right-drag free-look under Pointer Lock (`unadjustedMovement`), wheel zoom, optional mouse-yoke (GeoFS-style virtual stick) | | |
| Gamepad | Standard-mapping Xbox profile mirroring MSFS defaults; HID joystick presets keyed by `vendor:product` parsed from `Gamepad.id`; always offer "move the axis" calibration | Force feedback / rumble | Axis indices differ per OS/browser — never trust a preset without a user check |
| Touch | Own 150-line virtual stick + throttle slider (Pointer Events), optional tilt | | nipplejs is MIT but unnecessary |

---

# PART A — AUDIO

## A1. Web Audio foundations for a simulator

### A1.1 Autoplay policy (must start on a user gesture)

- Chrome creates an `AudioContext` **suspended** if the page has no user activation; `resume()` only works once the user
  has interacted ([Chromium intent-to-ship, 2018](https://groups.google.com/a/chromium.org/g/blink-dev/c/5Y1BqbGauEs)).
  Safari/iOS behave the same; Safari historically also ignored a developer-initiated `suspend()`
  ([WebAudio/web-audio-api#1802](https://github.com/WebAudio/web-audio-api/issues/1802)).
- Pattern: lazily create the context inside the first `pointerdown`/`keydown`/`touchend` handler, call `ctx.resume()`,
  start a 1-sample silent buffer (unlocks iOS), then remove the listeners
  ([TimvanScherpenzeel unlock gist](https://gist.github.com/TimvanScherpenzeel/c870b35358fb96fa643d9ed1ea606efd)).
  `AudioMixer.resume()` in our contract is exactly this hook; the UI calls it from the "Fly" button.
- Also call `resume()` on `visibilitychange` → visible, and on every `pointerdown` while `ctx.state !== 'running'`
  (some browsers re-suspend after long background tabs).
- **iOS silent switch**: Web Audio (unlike `<audio>`) was muted by the ring/silent switch; WebKit bug
  [237322](https://bugs.webkit.org/show_bug.cgi?id=237322) notes that since iOS 17 you can set
  `navigator.audioSession.type = 'playback'` to use the media channel. Fallback for older iOS: play a looping silent
  `<audio>` element ([feross/unmute-ios-audio](https://github.com/feross/unmute-ios-audio), MIT). **UNVERIFIED** on iOS 18+.
- Use `new AudioContext({ latencyHint: 'interactive' })`; don't force `sampleRate` (lets iOS pick 48 kHz).

### A1.2 Parameter automation (no zipper noise)

Never write `param.value = x` every frame for audible parameters. Use `param.setTargetAtTime(x, ctx.currentTime, tau)`
with `tau = 0.03–0.08 s`; it is a one-pole smoother executed at audio rate. For large jumps (camera switch) use
`linearRampToValueAtTime` over 0.15–0.3 s. Call `cancelScheduledValues` only when re-planning ramps.
Three.js itself does `gain.setTargetAtTime(v, now, 0.01)` in `Audio.setVolume`
([Audio.js r187](https://github.com/mrdoob/three.js/blob/r187/src/audio/Audio.js)).

### A1.3 One parameter drives everything: AudioParam fan-out

`ConstantSourceNode` outputs a signal; connecting it through `GainNode`s into `OscillatorNode.frequency` (which sums
the connected signal with its intrinsic value) gives one smoothed `rpmHz` control for an arbitrary number of harmonics:

```
rpmSrc (ConstantSourceNode, offset = firing Hz) ──► gainK (gain = k) ──► oscK.frequency  (oscK.frequency.value = 0)
                                                 ├─► jitterLfo → jitterGain → oscK.detune   (cents, ±3–8)
                                                 └─► … (every harmonic, the prop comb, the worklet's `rateHz` param)
```

Setting `rpmSrc.offset.setTargetAtTime(f0, t, 0.05)` moves every partial coherently and glitch-free.

### A1.4 Graph / buses (implements `AudioMixer`)

```
sources ─► bus gains ─► interior/exterior stage ─► master GainNode ─► DynamicsCompressorNode ─► ctx.destination
  engine, environment(wind/rain/rumble), cockpit(warnings, switches, flap motor), ui(clicks), atc(speech)
```

- Interior stage (camera `cockpit`): engine+environment pass a `BiquadFilterNode` lowpass **1.6–2.2 kHz, Q 0.7** at
  −8…−12 dB overall ("cabin attenuation"); cockpit/ui/atc buses bypass it.
- Exterior stage (any other `CameraMode`): the engine/environment buses feed a `THREE.PositionalAudio` attached to the
  aircraft `Object3D` via `setNodeSource(node)` (r187 API, [PositionalAudio.js](https://github.com/mrdoob/three.js/blob/r187/src/audio/PositionalAudio.js):
  `panningModel = 'HRTF'`, `setRefDistance`, `setRolloffFactor`, `setDistanceModel`, `setMaxDistance`,
  `setDirectionalCone`). Use `distanceModel 'inverse'`, `refDistance 15 m`, `rolloffFactor 1`, `maxDistance 20 000 m`.
  The `THREE.AudioListener` is a child of the active camera; r187 ramps panner position over `listener.timeDelta`.
- Crossfade interior↔exterior with equal-power gains over 0.25 s on `camera:changed`.
- Compressor: `threshold −12 dB, knee 20, ratio 4, attack 0.003, release 0.25` as a safety limiter only.
- Master default −6 dBFS; per-bus defaults: engine 0.8, environment 0.7, cockpit 1.0, ui 0.6, atc 0.9.

### A1.5 AudioWorklet with Vite

Vite has no first-class AudioWorklet support ([vitejs/vite#15036](https://github.com/vitejs/vite/discussions/15036)).
Working pattern: keep worklet code in a dependency-free `.ts` file, import it with
`import engineWorkletUrl from './worklets/engine.worklet.ts?worker&url'` (Vite bundles it as a separate ES module
chunk without injecting the HMR client) and `await ctx.audioWorklet.addModule(engineWorkletUrl)`. **Verify in dev mode**
(the discussion notes the dev client injection breaks `AudioWorkletGlobalScope`); fallback is a `?url` import of a
pre-built `.js` in `public/`.

### A1.6 Noise generators (worklet or pre-rendered 4 s `AudioBuffer` loops)

Pre-rendering 4 s of noise into an `AudioBuffer` and looping it is cheapest (looping a 4 s buffer is inaudible). Pink
noise, Paul Kellet "refined" filter (±0.05 dB above 9.2 Hz at 44.1 kHz)
([musicdsp.org](https://www.musicdsp.org/en/latest/Filters/76-pink-noise-filter.html)):

```ts
let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
function pink(white: number): number {           // white ∈ [-1, 1)
  b0 = 0.99886*b0 + white*0.0555179;  b1 = 0.99332*b1 + white*0.0750759;
  b2 = 0.96900*b2 + white*0.1538520;  b3 = 0.86650*b3 + white*0.3104856;
  b4 = 0.55000*b4 + white*0.5329522;  b5 = -0.7616*b5 - white*0.0168980;
  const out = (b0+b1+b2+b3+b4+b5+b6 + white*0.5362) * 0.11;
  b6 = white*0.115926;
  return out;
}
// brown (−6 dB/oct): y = (y + 0.02*white) / 1.02;  out = y * 3.5
```

---

## A2. Piston engine synthesis (C172 — Lycoming IO-360-L2A, 4 cyl, 4-stroke, direct drive)

### A2.1 Numbers

| Quantity | Value | Source |
|---|---|---|
| Rated power / RPM | 180 hp @ 2700 RPM (172S); 160 hp @ 2400 RPM (172R derated) | [172R manual](https://www.manualslib.com/manual/1384562/Cessna-172r.html?page=57), [Lycoming O-320 family 2700 RPM](https://en.wikipedia.org/wiki/Lycoming_O-320) |
| Idle RPM | ≈ 600–700 (use `PistonEngineSpec.idleRPM`) | **UNVERIFIED** (typical Lycoming; POH not reachable) |
| Firing frequency f₀ | `RPM/60 × cylinders/2 = RPM/30 Hz` (4 cyl, 4-stroke: 2 firings per revolution) | kinematics |
| Crank order f_c | `RPM/60 Hz` (half-order of f₀ — present because the 4 cylinders are never identical) | kinematics |
| Propeller | McCauley 1A170E/JHA7660, 2 blades, 76 in = 1.930 m (172S) | [172S POH](https://www.befa.org/wp-content/uploads/2019/12/POH-Cessna-172S.pdf) |
| Blade pass frequency | `RPM × 2 / 60 = RPM/30 Hz` — identical to f₀ for this airframe | NTSB spectral analysis of a 172 recording found 78 Hz + 156 Hz "blade passage frequency and harmonic" ⇒ 2340 RPM ([NTSB report](https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/66622/pdf)) |

| RPM | f₀ = BPF (Hz) | f_c (Hz) | Tip speed (m/s) | Tip Mach (static, c = 340) |
|---|---|---|---|---|
| 650 (idle) | 21.7 | 10.8 | 65.7 | 0.19 |
| 1000 | 33.3 | 16.7 | 101 | 0.30 |
| 1500 | 50.0 | 25.0 | 152 | 0.45 |
| 2000 | 66.7 | 33.3 | 202 | 0.59 |
| 2400 | 80.0 | 40.0 | 243 | 0.71 |
| 2700 | 90.0 | 45.0 | 273 | 0.80 |

Tip speed `v_tip = π·D·RPM/60`; helical tip speed in flight `√(v_tip² + V_TAS²)`.

### A2.2 Component model

| Layer | Generator | Shaping | Drive |
|---|---|---|---|
| Combustion pulse train | AudioWorklet impulse generator: 4 cylinder phases 0, 0.25, 0.5, 0.75 of the 2-rev cycle, per-cylinder amplitude ±8 % (fixed random), per-pulse timing jitter ±0.3 % | 3 peaking biquads = exhaust pipe resonances (§A2.3) then LP 6 kHz | `rateHz = f₀`, `load = throttle` (pulse amplitude), `sharpness` |
| Harmonic bank | `PeriodicWave` or 8 sine oscillators at k·f₀, k = 1..8, plus one at 0.5·f₀ (crank order) | amplitude table below; brightness rises with load (MAP) | `rpmHz` fan-out |
| Intake hiss | pink noise loop → BP 400–1200 Hz (Q 0.8) | gain ∝ throttle × (rpm/rpmMax)^0.5 | throttle, rpm |
| Mechanical (valve train / gear) | white noise → HP 2.5 kHz + ring-mod by 8·f₀ | gain ∝ rpm/rpmMax, −18 dB | rpm |
| Exhaust rumble | brown noise → LP 180 Hz | gain ∝ load, −12 dB | throttle |
| Wobble | LFO 0.5–2 Hz random walk → ±1.5 % f₀ at idle, → 0 above 1200 RPM ("lope") | | rpm |

Harmonic amplitudes (relative, at 50 % load; start here, then tune by ear):

| k | 0.5 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| A_k | 0.25 | 1.00 | 0.55 | 0.42 | 0.30 | 0.20 | 0.14 | 0.10 | 0.07 |

Load law: `A_k(load) = A_k × (0.6 + 0.4·load) × k^(−0.3·(1−load))` — leaner, duller at low manifold pressure
(cite: typical "on-load / off-load" split used by sample-based engines, [Audiokinetic](https://www.audiokinetic.com/engine-sound-modeling-from-sampling-to-granular-synthesis-in-wwise)).

### A2.3 Exhaust resonance (where the "character" comes from)

A pipe of length L behaves as a quarter-wave resonator: `f_n = (2n−1)·c_exh / (4L)`, with hot-exhaust speed of sound
`c_exh = √(γ R T) ≈ √(1.4·287·800 K) ≈ 567 m/s`. For L ≈ 1.2 m: 118, 354, 590 Hz. Model as 3 `BiquadFilterNode`
`peaking` filters: 120 Hz (Q 3, +9 dB), 350 Hz (Q 2.5, +6 dB), 600 Hz (Q 2, +4 dB), followed by `lowpass` 5 kHz.
Tune by ear against a recording; a `ConvolverNode` with a 0.3 s synthetic IR (decaying noise through the same peaks) is an
optional richer alternative (used by [VinZu17/Engine-Sound-Simulator](https://github.com/VinZu17/Engine-Sound-Simulator), MIT).

### A2.4 Pulse train as a `PeriodicWave` (no worklet fallback)

Rectangular pulse of duty `d` (0.12–0.25; wider = softer): Fourier coefficients `a_0 = d`,
`b_n = 0`, `a_n = (2/(nπ))·sin(nπd)`. Build once per duty with
`ctx.createPeriodicWave(real, imag, { disableNormalization: false })` and run one `OscillatorNode` at f₀; retune by
swapping waves (precompute d ∈ {0.12, 0.18, 0.25}). The classic WaveShaper/offset trick is documented in
[WebAudio-PulseOscillator](https://github.com/pendragon-andyh/WebAudio-PulseOscillator).

### A2.5 `EngineSynth` (TypeScript sketch)

```ts
// src/audio/engineSynth.ts — no Three.js imports; takes an AudioContext and returns an output AudioNode.
export interface EngineSynthParams { rpm: number; throttle: number; mixture: number; running: boolean; starter: boolean; load: number /*0..1 MAP fraction*/; }

const HARMONICS: Array<[k: number, amp: number]> = [[0.5,0.25],[1,1],[2,0.55],[3,0.42],[4,0.30],[5,0.20],[6,0.14],[7,0.10],[8,0.07]];

export class EngineSynth {
  readonly output: GainNode;
  private rpmHz: ConstantSourceNode;          // firing frequency in Hz
  private harmonicGains: GainNode[] = [];
  private worklet?: AudioWorkletNode;         // combustion pulses (optional)
  private intake: BiquadFilterNode; private intakeGain: GainNode;
  private mech: BiquadFilterNode;  private mechGain: GainNode;
  private rumble: BiquadFilterNode; private rumbleGain: GainNode;
  private resonators: BiquadFilterNode[];
  private wobble: OscillatorNode; private wobbleGain: GainNode;
  private tau = 0.05;

  constructor(private ctx: AudioContext, private cylinders: number, pinkLoop: AudioBuffer, brownLoop: AudioBuffer, workletReady: boolean) {
    const t = ctx.currentTime;
    this.output = new GainNode(ctx, { gain: 0 });
    this.rpmHz = new ConstantSourceNode(ctx, { offset: 0 }); this.rpmHz.start();

    // exhaust resonator chain (shared by pulses + harmonics)
    this.resonators = [[120,3,9],[350,2.5,6],[600,2,4]].map(([f,q,g]) =>
      new BiquadFilterNode(ctx, { type: 'peaking', frequency: f, Q: q, gain: g }));
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 5000, Q: 0.7 });
    this.resonators.reduce((a, b) => (a.connect(b), b)).connect(lp); lp.connect(this.output);
    const exhaustIn = this.resonators[0];

    // harmonic bank driven by rpmHz fan-out
    for (const [k, amp] of HARMONICS) {
      const osc = new OscillatorNode(ctx, { type: 'sine', frequency: 0 });
      const mult = new GainNode(ctx, { gain: k }); this.rpmHz.connect(mult).connect(osc.frequency);
      const g = new GainNode(ctx, { gain: amp * 0.18 }); osc.connect(g).connect(exhaustIn);
      osc.start(); this.harmonicGains.push(g);
    }
    // idle wobble: LFO → rpmHz.offset modulation in Hz
    this.wobble = new OscillatorNode(ctx, { type: 'sine', frequency: 1.3 });
    this.wobbleGain = new GainNode(ctx, { gain: 0 });
    this.wobble.connect(this.wobbleGain).connect(this.rpmHz.offset); this.wobble.start();

    if (workletReady) { // see §A2.2; params: rateHz (a-rate), load, jitter
      this.worklet = new AudioWorkletNode(ctx, 'combustion-pulses', { numberOfInputs: 0, parameterData: { cylinders } });
      this.rpmHz.connect(this.worklet.parameters.get('rateHz')!);
      this.worklet.connect(exhaustIn);
    }
    // noise layers
    const mk = (buf: AudioBuffer) => { const s = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true }); s.start(); return s; };
    this.intake = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 700, Q: 0.8 });
    this.intakeGain = new GainNode(ctx, { gain: 0 }); mk(pinkLoop).connect(this.intake).connect(this.intakeGain).connect(this.output);
    this.mech = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 2500, Q: 0.7 });
    this.mechGain = new GainNode(ctx, { gain: 0 }); mk(pinkLoop).connect(this.mech).connect(this.mechGain).connect(this.output);
    this.rumble = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 180, Q: 0.9 });
    this.rumbleGain = new GainNode(ctx, { gain: 0 }); mk(brownLoop).connect(this.rumble).connect(this.rumbleGain).connect(this.output);
  }

  /** Call once per render frame with the latest AircraftState. */
  update(p: EngineSynthParams, dopplerRatio = 1): void {
    const t = this.ctx.currentTime, tau = this.tau;
    const f0 = (p.rpm / 60) * (this.cylinders / 2) * dopplerRatio;   // 4 cyl → rpm/30
    this.rpmHz.offset.setTargetAtTime(f0, t, tau);
    const x = Math.min(1, p.rpm / 2700);
    const master = p.running || p.starter ? 0.25 + 0.75 * Math.pow(x, 1.5) : 0;
    this.output.gain.setTargetAtTime(master, t, 0.1);
    // load shapes harmonic brightness
    HARMONICS.forEach(([k, amp], i) =>
      this.harmonicGains[i].gain.setTargetAtTime(amp * 0.18 * (0.6 + 0.4 * p.load) * Math.pow(k, -0.3 * (1 - p.load)), t, tau));
    this.wobbleGain.gain.setTargetAtTime(p.running ? 0.015 * f0 * Math.max(0, 1 - (p.rpm - 650) / 600) : 0, t, tau);
    this.intakeGain.gain.setTargetAtTime(0.12 * p.throttle * Math.sqrt(x), t, tau);
    this.intake.frequency.setTargetAtTime(400 + 800 * x, t, tau);
    this.mechGain.gain.setTargetAtTime(0.04 * x, t, tau);
    this.rumbleGain.gain.setTargetAtTime(0.10 * p.load, t, tau);
    this.worklet?.parameters.get('load')!.setTargetAtTime(p.load, t, tau);
  }
}
```

Worklet core (`combustion-pulses`): a phase accumulator `phase += rateHz/sampleRate`; on each wrap emit a 2-sample
impulse scaled by `cylAmp[i] * (0.4 + 0.6*load)` with a one-pole LP at 3 kHz to soften; `i = (i+1) % cylinders`
with firing order 1-3-2-4 (identical acoustically to any order at this level). Jitter: add `±0.003·randn` to the
wrap threshold.

### A2.6 Start / stop sequences (drive from `EngineState` + `ControlInputs.starter`)

- **Starter**: while `starter && !running`: a motor whine (sawtooth 70→110 Hz through BP 1.2 kHz, gain 0.15) plus the
  pulse train at the **cranking** rate (f₀ for ≈ 150–250 RPM ⇒ 5–8 Hz pulses) with `load = 0.1`. The FDM's RPM already
  ramps during start, so the synth needs no special casing beyond the whine.
- **Catch**: on `engine:started` event, 0.3 s burst of extra rumble gain (+6 dB) and brighter harmonics decaying to normal.
- **Shutdown** (`engine:stopped`): follow RPM to zero; add a 1.5 s "tick" layer (sparse random clicks, 3–5 Hz) for
  cooling/afterfire flavour — optional.

---

## A3. Propeller layer

- **Tonal (Gutin/loading noise)**: harmonics at `m·BPF`, `BPF = RPM·B/60`. Amplitude decays with order roughly like the
  engine table; for 2 blades BPF = f₀ so simply boost k = 1, 2, 3 of the harmonic bank by `+3..+6 dB × propGain` rather
  than adding oscillators. Loudness rises steeply with tip Mach (loading noise ∝ high powers of tip speed); game law:
  `propGain = clamp((M_tip − 0.25)/0.55, 0, 1)^2.5` using helical tip Mach from `ac.atmosphere.speedOfSound`.
- **Broadband (vortex shedding / trailing-edge noise)**: Strouhal relation `f_s = St·U/h`, `St ≈ 0.2`, `h` ≈ blade
  trailing-edge thickness (0.01–0.02 m), `U` ≈ 0.75-radius section speed ⇒ 1.5–4 kHz hiss. Implement as pink noise → BP
  centred at `f_s` (Q 1), gain ∝ `(RPM/2700)^3`. This mirrors the compact-source decomposition of Selfridge, Moffat &
  Reiss, *Physically Derived Sound Synthesis Model of a Propeller*, Audio Mostly 2017, DOI 10.1145/3123514.3123524
  ([Napier repository](https://napier-repository.worktribe.com/output/3011204/physically-derived-sound-synthesis-model-of-a-propeller)) — full equations not retrieved (**UNVERIFIED** details).
- Exterior cameras: the prop dominates (gain ×1.6 vs interior where exhaust dominates ×0.7).

## A4. Wind / slipstream / buffet

- Source: pink loop → `lowpass` with cutoff `fc = 300 + 2500·v²` and `bandpass` (whistle) at `1.2 kHz + 1.5 kHz·v`
  (Q 0.5, −12 dB), where `v = clamp(IAS / 70 m/s, 0, 1.4)`.
- Gain: aerodynamic noise grows with a high power of speed (dipole sources ∝ U⁶ in intensity); perceptually a
  `gain = 0.6·v²` with a hard cap works. Add `+0.15·flapDeg/30` and `+0.1·gearDown` (C172: fixed gear → constant).
- **Stall buffet**: when `ac.aero.alpha > α_buffet` (≈ 1–2° before `stalled`) or `warnings.stall`, amplitude-modulate the
  wind bus with a random-walk LFO 8–14 Hz, depth up to 0.5 — plus optional gamepad rumble (§B5.8).
- **Rain** (`weather.precipitationType === 'rain'`): white noise → HP 3 kHz, gain ∝ intensity × (0.3 + 0.7·v), with
  sparse random "drop" clicks at 20–60 Hz rate. Snow: silence.
- **Ground roll**: see §A5.4 (tyre rumble).

## A5. Warnings, systems, UI

### A5.1 Stall warning horn (C172 = pneumatic reed in the left wing leading edge)

No published frequency measurement was found; forum reports agree the reed tone **rises in pitch and volume** as the
aircraft slows ([AOPA "How it works: stall horn"](https://www.aopa.org/news-and-media/all-news/2016/december/flight-training-magazine/how-it-works-stall-horn),
[PoA thread](https://www.pilotsofamerica.com/community/threads/hearing-stall-warning-horn.132109/)). Certification
(FAR 23.207) requires onset between 5 and 10 kt above stall. **UNVERIFIED design values** — measure a CC0 recording with an
FFT before shipping: fundamental ≈ 500 Hz at onset → ≈ 700 Hz near the break, reedy timbre (odd harmonics).

Synthesis: `sawtooth` + `square` (detuned +7 cents) → `bandpass` 900 Hz Q 1.5 → `highpass` 300 Hz; vibrato 6 Hz ±10 cents;
`intensity = clamp((1.10·Vs − CAS)/(0.10·Vs), 0, 1)` with Vs from `limits.Vs1Kt/VsoKt` by flap setting, or simply
`warnings.stall ? 1 : 0` smoothed; `f0 = 500 + 200·intensity`, gain `0.5·intensity`. Cockpit bus (not positional).

### A5.2 Flap motor (electric, C172) and gear motor (future retractable)

While `surfaces.flapDeg` is moving (compare to target detent): `sawtooth` 140 Hz + `square` 2×, → BP 1.1 kHz Q 2 →
gain 0.12 interior / 0.03 exterior; pitch sags 6 % in the first 0.3 s (load) and rises 3 % in the last 0.2 s. Duration
comes from `AircraftConfig.controls.flaps.transitS`. Gear motor: same recipe at 90 Hz, louder (0.2), with a "clunk"
(`A5.4` thump recipe, −6 dB) at the end of travel.

### A5.3 Overspeed / gear / other
- Overspeed (`warnings.overspeed`): C172 has none; for jets use a "clacker": 4 Hz click train of 2 ms noise bursts → BP 2 kHz.
- Gear warning horn (future): intermittent 400 Hz square, 0.5 s on / 0.5 s off when `throttle < 0.15 && !gearDown && AGL < 300 m`.
- Low fuel / master caution chime: 2-note sine 880 → 660 Hz, 0.12 s each.

### A5.4 Touchdown thump, tyre chirp, rumble (events + continuous)

On `aircraft:touchdown { verticalSpeedMs, lateralDriftMs }`:
- Thump: sine with `frequency` 55 → 35 Hz over 0.12 s (exponential ramp), `gain = clamp(|vs|/3, 0.1, 1)`, decay
  `setTargetAtTime(0, t+0.02, 0.15)`. Add brown-noise burst (60 ms) through LP 300 Hz.
- Chirp/skid: white noise → BP 2.2 kHz Q 3, 50–120 ms, gain ∝ `clamp(groundSpeed/40 + |lateralDrift|/5, 0, 1)`.

Continuous while `onGround`:
- Tyre rumble: brown loop → LP `150 + 250·s` Hz, gain `0.35·s^1.5`, `s = clamp(groundSpeed/40 m/s)`; `surface === 'grass'`
  → gain ×1.6 and LP ×0.7 plus a 2–4 Hz random "bump" AM.
- Wheel rotation bump: periodic pulse at `f_wheel = v / (2π·tyreRadius)` (C172 main tyre r ≈ 0.22 m ⇒ 21.7 Hz at 30 m/s).
  Implement by sweeping the pulse worklet at `rateHz = f_wheel` into a BP 90 Hz, gain 0.08·s.
- Brake squeal (optional): when `brakeLeft/Right > 0.6 && v > 5`: sine 3.2 kHz with 10 Hz AM, gain 0.03.

### A5.5 Switch / button clicks (synth or CC0 samples)

Synth: 2 ms white-noise burst → BP 2.5 kHz Q 1 (gain 0.4) + 20 ms sine 180 Hz (gain 0.3) = "click";
"switch" = two clicks 35 ms apart with the second at 1.8 kHz; "warn" = 3 × 880 Hz 60 ms; "confirm" = 660→990 Hz;
"error" = 220 Hz square 120 ms. Alternatively Kenney *Interface Sounds* (~100 clips) and *UI Audio* (~50 clips), **CC0**
([Godot asset listing](https://godotengine.org/asset-library/asset/793), [kenney.nl](https://kenney.nl/assets/interface-sounds)) —
verify the pack's own `License.txt` before committing it to `public/audio/`.

### A5.6 Speech (`AudioMixer.speak`)

`speechSynthesis.speak(new SpeechSynthesisUtterance(text))`; voices load asynchronously (`voiceschanged`); pick an
`en-US` voice, `rate 1.05`, `pitch 0.9` for ATC; duck the `atc` bus −6 dB on engine while speaking; `speechSynthesis.cancel()`
implements `stopSpeaking`. Not routed through Web Audio (no radio-filter possible) — acceptable for v1.

## A6. Doppler and distance for external cameras

The spec removed PannerNode Doppler (`setVelocity`, `dopplerFactor`) because it only ever worked on buffer sources and
glitched ([web-audio-api#455](https://github.com/WebAudio/web-audio-api/issues/455),
[Blink intent-to-deprecate](https://groups.google.com/a/chromium.org/g/blink-dev/c/-1SI1GoHYO8)). Do it manually:

```
r̂   = unit(listenerPos − sourcePos)                      // source → listener
v_s = dot(aircraftVelNED, r̂)   (source speed toward listener, m/s)
v_l = dot(listenerVelNED, r̂)   (listener speed away from source)
ratio = clamp((c − v_l) / (c − v_s), 0.5, 2.0),  c = ac.atmosphere.speedOfSound
```

Apply `ratio` to `rpmHz` (every synth partial follows), to noise-layer filter cutoffs, and to `playbackRate` of any
sample loops; smooth with `tau = 0.05`. Chase/cockpit cameras move with the aircraft ⇒ ratio ≈ 1; tower/flyby cameras
produce the classic pass-by. Distance attenuation is handled by `PositionalAudio` (§A1.4); add an air-absorption
`lowpass` with `fc = 12 kHz · exp(−d/2500 m)` for d > 200 m.

## A7. Sample-based alternative / hybrid

**Licensing.** Freesound offers exactly three licences: **CC0** (no credit), **CC BY** (credit required: title, author,
link), **CC BY-NC** (credit + no commercial use) ([Freesound FAQ](https://freesound.org/help/faq/)). Filter to CC0 for
anything we bundle; keep a `public/audio/CREDITS.md` regardless. Freesound API v2 search supports a `filter` parameter —
license values are `"Creative Commons 0"`, `"Attribution"`, `"Attribution Noncommercial"` ([API docs](https://freesound.org/docs/api/),
**UNVERIFIED** exact strings; site unreachable). Previews are MP3/OGG; original downloads need OAuth2. Kenney packs are CC0.

**RPM layering** (industry practice per [Audiokinetic loop-based engine design](https://www.audiokinetic.com/en/loop-based-car-engine-design-with-wwise-part-2)):
loops ordered min→max RPM in a blend track with crossfades and a pitch curve so the pitch is continuous across loops.

- Anchors for the C172: 650, 1000, 1500, 2000, 2400, 2700 RPM (6 loops × 3–4 s, 48 kHz mono OGG ≈ 2 MB; decoded ≈ 5 MB).
- For rpm between anchors `a < b`: `x = (rpm−a)/(b−a)`, equal-power gains `gA = cos(xπ/2)`, `gB = sin(xπ/2)`,
  `playbackRate_A = rpm/a`, `playbackRate_B = rpm/b` (ratio stays within ≈ 0.8–1.3 ⇒ < ±450 cents, no artefacts).
  Detune in cents is `1200·log2(rpm/anchor)`.
- Seamless loops: render each loop with a 50 ms equal-power tail/head crossfade offline; set `loopStart/loopEnd` on the
  `AudioBufferSourceNode` (`THREE.Audio.setLoopStart/End` exist in r187).
- Hybrid: samples at −6 dB under the synth give "texture"; the synth guarantees tracking and start/stop behaviour.

MSFS itself drives Wwise RTPCs from sim variables (engine RPM, N1/N2, throttle) — SDK page
[Engine Audio Setup](https://docs.flightsimulator.com/msfs2024/html/4_Sound/Aircraft_Audio/Engine_Audio_Setup.htm) (**UNVERIFIED**, host blocked).

## A8. Jet engine (future `TurbofanEngineSpec`)

Reference numbers (CFM56-7B, 737NG): N1 100 % = **5157 rpm** (one source; another says 5175), N2 100 % = **14 460 rpm**,
**24 fan blades** ([CFM56-7B overview](https://www.scribd.com/document/390966216/CFM-56-7B-pdf)). Fan BPF at 100 % N1 ≈
24 × 5157/60 ≈ **2063 Hz**; at idle N1 ≈ 20 % ⇒ ≈ 410 Hz. Shaft-order spacing N1/60 ≈ 86 Hz at 100 %. Buzz-saw
(multiple pure tones at shaft-order multiples) appears when fan tips go supersonic; fan D ≈ 1.55 m ⇒ tip speed
π·1.55·86 ≈ 418 m/s (M ≈ 1.2) at 100 %, onset around N1 ≈ 80 % ([buzz-saw patent](https://patents.google.com/patent/US4732532)).

Layers (same architecture as the piston synth; Farnell's *Designing Sound* (MIT Press 2010) builds its jet from
filtered noise plus resonant tones in exactly this way):

| Layer | Generator | Law |
|---|---|---|
| Fan whine | `PeriodicWave` harmonics 1–4 of `BPF_fan = N1rpm·24/60` | gain ∝ N1², ×1.5 when exterior front hemisphere (`setDirectionalCone(60, 180, 0.4)`) |
| Buzz-saw | comb of 10–20 sines at `m·N1rpm/60`, random fixed amplitudes | gain = clamp((M_tip − 0.95)/0.3) |
| Core whine | sine at `N2rpm/60 × 38` (HPC stage-1 blade count **UNVERIFIED**; ≈ 8–9 kHz at 100 %) | gain ∝ N2, −20 dB |
| Jet mixing | pink → LP `fc = 200 + 1800·N1²` Hz | gain ∝ N1⁴ (Lighthill U⁸ in intensity), dominant at the rear |
| Spool | N1/N2 first-order lags from the FDM (`spoolTauS`); audio just follows | — |
| Start | starter whine (saw 60→400 Hz over 20 s) → light-off rumble burst at N2 ≈ 20–25 % → idle N2 ≈ 60 %, N1 ≈ 20 % (**typical**, UNVERIFIED) | |

## A9. Implementation checklist & budget

- One `AudioEngine implements AudioMixer`; `update(dt, ac, camera, weather)` reads: `engine.rpm`, `engine.running`,
  `engine.manifoldPressureInHg/maxMAPinHg` (load), `inputs.throttle`, `aero.ias`, `aero.alpha`, `warnings.stall`,
  `surfaces.flapDeg`, `onGround`, `groundSpeedMs`, `gear[i].normalForceN`; subscribes to `aircraft:touchdown`,
  `engine:started/stopped`, `camera:changed`, `aircraft:flaps`, `aircraft:gear`.
- Node count ≈ 45 persistent nodes + transient one-shots; CPU ≈ 1–3 % on a laptop. Update params at render rate; the
  one-pole `setTargetAtTime` smoothing hides frame-rate jitter.
- Unit tests (Node, no DOM): harmonic tables, Doppler ratio, pink-noise spectrum slope (≈ −3 dB/oct over 100 Hz–5 kHz),
  crossfade sums to unity power. Playwright: context resumes after click, no `console.error` from `addModule`.

---

# PART B — INPUT

## B1. Principles and contracts

- `InputManager.poll(dt)` runs first in the frame (see `docs/DESIGN.md` main loop) and fills an `InputSnapshot`
  (`axes: Record<SimAxis, number>`, edge `actions: SimAction[]`, level `held: Set<SimAction>`, `pointerDx/Dy`, `mouseYoke`).
  The Simulator maps axes/actions to `ControlInputs` (throttle 0..1, pitch/roll/yaw −1..1 with **+pitch = nose up / stick back**).
- All devices are normalised to the same `SimAxis` space; the manager arbitrates per axis by **most-recent activity**
  (if the stick moved in the last 0.5 s it owns `pitch`; otherwise keyboard ramps may drive it) — this is how MSFS
  behaves when two devices share an axis.
- Bindings are data (JSON), rebindable at runtime, persisted in `localStorage['fs.bindings.v1']`, keyed per device.

## B2. Keyboard — MSFS 2020 default layout

Use `KeyboardEvent.code` (physical key: `Numpad7`, `NumpadDecimal`, `NumpadEnter`, `F1`, `KeyG`…) so bindings survive
layouts and NumLock; `code` is unaffected by NumLock whereas `key` flips between digits and navigation. Ignore
`e.repeat === true` for edge actions (we implement hold behaviour ourselves) and `preventDefault()` for F1–F12, Space,
arrows, Tab and Backspace while the canvas has focus. Clear `held` on `window.blur` and `visibilitychange`.
Left and right Ctrl are distinct `code`s; treat both as the "Ctrl" modifier (an MSFS thread notes Ctrl+Num Del only
worked with *left* Ctrl for some users — [Steam discussion](https://steamcommunity.com/app/1250410/discussions/0/2919976282209353783/)).

Default table (MSFS 2020 "Keyboard Transversal"). **✓** = agreed by ≥ 2 independent lists found during research
([flyawaysimulation](https://flyawaysimulation.com/ask/answers/msfs-2020-default-keyboard-controls/),
[gamesradar](https://www.gamesradar.com/microsoft-flight-simulator-2020-keyboard-controls/),
[pcgamer](https://www.pcgamer.com/microsoft-flight-simulator-2020-controls-keyboard-controller/),
[allanville](https://aviation.allanville.com/misc/fs20-keyboard-shortcuts),
[cheatography](https://cheatography.com/nimasmi/cheat-sheets/microsoft-flight-simulator-2020/),
[forum default-bindings PDF](https://forums.flightsimulator.com/uploads/short-url/kwtAlqUrKiEqaZZNUJz8CXhTVKS.pdf));
**~** = single source or recollection — **verify in-sim** before copying into the help overlay.

| Group | Action (`SimAction`/`SimAxis`) | MSFS 2020 default | Conf. |
|---|---|---|---|
| Primary | `pitch` nose down / nose up | Num 8 / Num 2 | ~ (numpad also slews when slew mode is on ✓) |
| | `roll` left / right | Num 4 / Num 6 | ~ |
| | `yaw` left / right | Num 0 / Num Enter | ✓ |
| | centre ailerons & rudder | Num 5 | ~ |
| Trim | `trimNoseDown` / `trimNoseUp` | Num 7 / Num 1 | ✓ |
| | `rudderTrimLeft` / `rudderTrimRight` | Ctrl+Num 0 / Ctrl+Num Enter | ✓ |
| | `aileronTrimLeft` / `aileronTrimRight` | Ctrl+Num 4 / Ctrl+Num 6 | ~ |
| Throttle | `throttleCut` / `throttleDec` / `throttleInc` / `throttleFull` | F1 / F2 / F3 / F4 | ✓ |
| Propeller | low / dec / inc / high (`propeller`) | Ctrl+F1 / Ctrl+F2 / Ctrl+F3 / Ctrl+F4 | ✓ |
| Mixture | `mixtureLean`(cut-off) / `mixtureDec` / `mixtureInc` / `mixtureRich` | Ctrl+Shift+F1 / F2 / F3 / F4 | ~ |
| Flaps | `flapsRetract` / `flapsUp`(one notch) / `flapsDown`(one notch) / `flapsFull` | F5 / F6 / F7 / F8 | ✓ |
| Gear | `gearToggle` | G | ✓ |
| Spoilers | toggle / arm | Num / ; Shift+Num / | ~ |
| Brakes | `brakesHold` (both) / left / right | Num Del (Num .) / Num * / Num − | ✓ |
| | `parkingBrakeToggle` | Ctrl+Num Del | ✓ |
| Engine | `engineAutoStart` / `engineShutdown` | Ctrl+E / Ctrl+Shift+E | ✓ |
| | `magnetosNext` (cycle) ; Both/Left/Right/Off/Start | M ; Shift+Alt+F / S / D / Q / G | ✓ |
| Lights | `lightsAll` (or interior) | L | ~ (lists disagree) |
| | `lightsLanding` | Ctrl+L (some lists: Ctrl+I) | ~ |
| | `lightsNav` / `lightsBeacon` / `lightsStrobe` / `lightsTaxi` | Alt+N / Alt+H / O / Alt+J | ✓ |
| Autopilot | `apToggle` (master) ; on / off | Z ; Alt+Z / Shift+Alt+Z | ✓ |
| | `apHdg` / `apAlt` / `apNav` / `apApr` | Ctrl+H / Ctrl+T / Ctrl+N / Ctrl+A | Ctrl+T, Ctrl+N, Ctrl+A ✓ ; Ctrl+H ~ |
| | `fdToggle` | Ctrl+F | ~ |
| Instruments | `altimeterStd`/sync (set barometer) | B | ~ |
| Camera | `cameraCockpit`↔`cameraExternal` toggle | End | ✓ |
| | `cameraDrone` | Insert | ✓ |
| | smart camera | S | ✓ |
| | `cameraReset` (cockpit) | Ctrl+Space (2024: Shift+Space) | ✓ |
| | look around (cockpit) / quick views / translate | Arrows / Ctrl+Arrows / Alt+Arrows | ~ |
| | load / save custom camera n | Alt+0–9 / Ctrl+Alt+0–9 ; cycle K / Shift+K | ✓ |
| | `zoomIn` / `zoomOut` | mouse wheel ; Num + / Num − (drone) | ✓ |
| | free look | hold right mouse button + move | ~ |
| Sim | `toggleMenu` (pause menu) / active pause | Esc / Pause | ✓ |
| | `slewToggle` | Y | ✓ |
| | `timeFaster` / `timeSlower` | R then Ctrl+Num + / Ctrl+Num − (lists disagree) | ~ |
| | `toggleAtc` | Scroll Lock | ~ |

Not in MSFS by default (ours): `Alt+M` mouse-yoke toggle (~ unused in MSFS), `F11` HUD, `F12` screenshot, `Shift+R` repair/refuel.

MSFS 2024 ships a different default preset ("Keyboard 2024 Transversal") plus a "Keyboard 2020 Transversal" preset that
restores the above ([flyawaysimulation 2024](https://flyawaysimulation.com/ask/answers/default-keyboard-controls-microsoft-flight-simulator-2024/),
[Editors Keys](https://editorskeys.com/blogs/news/how-to-restore-microsoft-flight-simulator-2020-key-commands-in-msfs-2024)); reported 2024 changes
(flaps on V/B-style keys, parking brake Ctrl+Space, reset view Shift+Space) conflict between sources — **UNVERIFIED**; we
target the 2020 layout and may add a "2024" preset later.

## B3. Making keyboard flying feel smooth (ramps, taps, auto-centre)

Discrete keys must not step the control. Per keyboard-driven axis keep a *virtual stick* `s ∈ [−1,1]`:

| Axis | Tap step | Hold ramp (per s) | Release return (per s) | Smoothing τ |
|---|---|---|---|---|
| pitch / roll | 0.15 | 2.5 (full in 0.4 s) with 0.15 s ease-in | 3.0 (auto-centre; option "sticky" = 0) | 0.08 s |
| yaw | 0.20 | 3.0 | 4.0 | 0.06 s |
| brakes (keys) | — | 4.0 (full in 0.25 s) | 6.0 | 0.03 s |
| throttle (F2/F3) | ±0.03 | 0.40 | hold value | 0.10 s |
| mixture / propeller | ±0.05 | 0.50 | hold | 0.10 s |
| trim (Num 7/1) | ±0.01 | 0.25, accelerating ×2 after 1 s | hold | — |

```ts
export class KeyAxis {
  private v = 0; private held = 0; private heldFor = 0;
  constructor(private tap: number, private ramp: number, private ret: number, private autoCentre: boolean) {}
  press(dir: 1 | -1) { if (this.held === 0) this.v = clamp(this.v + dir * this.tap, -1, 1); this.held = dir; this.heldFor = 0; }
  release() { this.held = 0; }
  step(dt: number): number {
    if (this.held !== 0) { this.heldFor += dt; const ease = Math.min(1, this.heldFor / 0.15);
      this.v = clamp(this.v + this.held * this.ramp * ease * dt, -1, 1); }
    else if (this.autoCentre) { const d = this.ret * dt; this.v = Math.abs(this.v) <= d ? 0 : this.v - Math.sign(this.v) * d; }
    return this.v;
  }
}
// then: target = keyAxis.step(dt); out += (target - out) * (1 - Math.exp(-dt / tau));  // one-pole smoothing
```

Also offer an **assist** (`AssistanceOptions.autoRudder` already exists) and a "keyboard sensitivity" slider scaling
`ramp` 0.5×–2×. Sim-rate/pause keys are edge actions; brakes and rudder keys populate `held`.

## B4. Mouse

### B4.1 Free-look (cockpit) and orbit (external) — Pointer Lock

On right-button `pointerdown` over the canvas: `canvas.requestPointerLock({ unadjustedMovement: true })` (raw deltas, no
OS acceleration — supported in Chromium ≥ 88, Safari ≥ 18.4; falls back with `NotSupportedError`, so retry without the
option) ([MDN Pointer Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API)). While
`document.pointerLockElement === canvas`, accumulate `movementX/Y` into `pointerDx/Dy`; the camera applies
`yaw −= dx·0.0025 rad`, `pitch −= dy·0.0025 rad` (clamp pitch ±80°, invert-Y option). Exit lock on right-button `pointerup`
(MSFS behaviour: the view stays where you left it; `Ctrl+Space` recentres). Wheel: `cameraZoom` axis — cockpit FOV
30°–90° in 5° steps (default 60–70°), chase distance ×1.1 per notch. Middle button: reset view.
Pointer Lock requires a user gesture and may show a browser banner; `pointerlockchange`/`pointerlockerror` must be handled.

### B4.2 Mouse-as-yoke (virtual stick)

GeoFS calls this "the mouse acts like a joystick": `M` enables mouse control, `K`/`J` switch to keyboard/joystick,
sensitivity and an exponential curve are adjustable, and by default roll and yaw are mixed
([GeoFS instructions](https://www.geo-fs.com/pages/instructions.php), [GeoFS wiki](https://geofs.fandom.com/wiki/Tutorials/Controls)).
MSFS has no built-in mouse yoke; the usual add-on captures the pointer, and a left-click engages/disengages
([community add-on](https://flightsim.to/addon/98739/airjb-mouse-controlled-virtual-joystick-msfs)).

Design (mode toggled by `Alt+M`, state exposed as `InputSnapshot.mouseYoke`):
1. Engage: left-click on the canvas → Pointer Lock → virtual stick `p = (0,0)` → HUD crosshair + box.
2. Each `mousemove`: `p += (movementX, movementY) / R` with `R = 250 px` for full deflection (sensitivity slider
   150–600 px); clamp to the unit square; apply the same curve/deadzone pipeline as a gamepad (§B5.5).
3. Output `roll = curve(p.x)`, `pitch = curve(p.y)` (mouse down = nose up, i.e. pulling back; invert option), optional
   `yaw = 0.3·roll` auto-coordination when `assists.autoRudder`.
4. Hold `Space` (or middle button) for *spring-to-centre*: `p → 0` at 4/s (GeoFS has no spring; MSFS add-ons differ).
5. Disengage: left-click again or `Esc` (Pointer Lock exit also disengages). Right-drag still free-looks.
An **absolute** variant (stick = cursor offset from screen centre, no pointer lock) is simpler on trackpads; offer both
(`mouseYokeMode: 'relative' | 'absolute'`).

## B5. Gamepad API (Xbox pads, joysticks, HOTAS)

### B5.1 Standard Gamepad mapping (`gamepad.mapping === 'standard'`)

| Index | Button | Index | Button | Axis | Meaning |
|---|---|---|---|---|---|
| 0 | A (bottom) | 8 | View / Back | 0 | left stick X (−1 left) |
| 1 | B (right) | 9 | Menu / Start | 1 | left stick Y (−1 up) |
| 2 | X (left) | 10 | L3 | 2 | right stick X |
| 3 | Y (top) | 11 | R3 | 3 | right stick Y |
| 4 | LB | 12–15 | D-pad up/down/left/right | | |
| 5 | RB | 16 | Guide/Xbox | | |
| 6 | LT (analog `.value` 0..1) | 7 | RT (analog) | | |

(W3C Gamepad "Standard Gamepad" layout; Chromium's remappers fill exactly these slots —
[gamepad_standard_mappings.cc](https://github.com/chromium/chromium/blob/main/device/gamepad/gamepad_standard_mappings.cc).)

**Default Xbox profile = MSFS 2020 default** ([flyawaysimulation Xbox defaults](https://flyawaysimulation.com/ask/answers/default-xbox-controls-msfs-2020/)):
left stick → `pitch`/`roll`; right stick → `lookYaw`/`lookPitch`; LT/RT → `yaw` left/right (`yaw = RT.value − LT.value`);
A/B → `throttleInc`/`throttleDec` (held = ramp 0.4/s); X → `brakesHold`; LB/RB → `flapsUp`/`flapsDown`;
D-pad up/down → `trimNoseDown`/`trimNoseUp`, left/right → `rudderTrimLeft/Right` (~ MSFS uses D-pad for trim/views, **UNVERIFIED**);
View (8) → `cameraNext`; Menu (9) → `toggleMenu`; Y → `gearToggle`; R3 → `cameraReset`; L3 → `parkingBrakeToggle`.

### B5.2 Identifying devices: parsing `Gamepad.id`

Formats differ per browser ([Enichan's gist](https://gist.github.com/Enichan/de1618d2c481523bd0c1123800bfe747),
[w3c/gamepad#199](https://github.com/w3c/gamepad/issues/199), [MDN Gamepad.id](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad/id)):

- Chrome/Edge/Opera: `"Logitech Dual Action (STANDARD GAMEPAD Vendor: 046d Product: c216)"`, XInput pads: `"Xbox 360 Controller (XInput STANDARD GAMEPAD)"` (no VID/PID).
- Firefox: `"046d-c216-Logitech Dual Action"`, XInput: `"xinput"`.
- Safari: `"46d-c216-Logicool Dual Action"` (leading zeros dropped).

```ts
export function parseGamepadId(id: string): { vendor?: string; product?: string; name: string; xinput: boolean } {
  const xinput = /^\s*xinput\s*$/i.test(id) || /\(xinput standard gamepad\)\s*$/i.test(id);
  const v = /vendor:?\s*([0-9a-f]{1,4})(?:[^0-9a-f]|$)/i.exec(id)?.[1];
  const p = /product:?\s*([0-9a-f]{1,4})(?:[^0-9a-f]|$)/i.exec(id)?.[1];
  const ff = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-\s*(.*?)\s*$/i.exec(id);
  const pad4 = (s?: string) => s?.toLowerCase().padStart(4, '0');
  return { vendor: pad4(v ?? ff?.[1]), product: pad4(p ?? ff?.[2]), name: (ff?.[3] ?? id.replace(/\s*\(.*\)/, '')).trim(), xinput };
}
// deviceKey = xinput || mapping === 'standard' ? 'std' : `${vendor}:${product}` ; fall back to the raw id string.
```

Known VID:PID (USB ID databases; Chromium's `gamepad_id_list.cc` lists many of these as known non-XInput HID devices —
[gamepad_id_list.cc](https://github.com/chromium/chromium/blob/main/device/gamepad/gamepad_id_list.cc)):

| Device | VID:PID | Axes (HID usages) | Notes |
|---|---|---|---|
| Logitech Extreme 3D Pro | `046d:c215` | X, Y, Rz (twist), Slider (throttle), Hat; 12 buttons | listed in Chromium id table ([meadowtools](https://meadowtools.com/devices/joystick-tester/extreme-3d-pro)) |
| Thrustmaster T.16000M | `044f:b10a` | X, Y, Rz, Slider, Hat; 16 buttons | [DeviceHunt](https://devicehunt.com/view/type/usb/vendor/044F/device/B10A) |
| Thrustmaster TWCS throttle | `044f:b687` | Z (throttle), Rx/Ry mini-stick, rocker, sliders | [DeviceHunt](https://devicehunt.com/view/type/usb/vendor/044F/device/B687) |
| Thrustmaster T.Flight HOTAS X | `044f:b108` | X, Y, Rz, Slider (throttle), rocker | [DeviceHunt](https://devicehunt.com/view/type/usb/vendor/044F/device/B108) |
| Thrustmaster T.Flight Rudder / T-Rudder | `044f:b678` / `044f:b679` | X, Y (toe brakes), Rz (rudder) | ~ ([the-sz USB IDs](https://www.the-sz.com/products/usbid/index.php?v=044f&p=&n=)) |
| Thrustmaster HOTAS Warthog stick / throttle | `044f:0402` / `044f:0404` | | ~ |
| Logitech F310/F510/F710 (D-mode) | `046d:c216/c218/c219` | remapped to standard by Chromium `MapperLogitechDInput` | [gamepad_standard_mappings_win.cc](https://github.com/chromium/chromium/blob/main/device/gamepad/gamepad_standard_mappings_win.cc) |
| Xbox / XInput pads (incl. T.Flight HOTAS One on Windows) | XInput | `mapping: 'standard'` | throttle on a HOTAS One shows up as a stick axis — needs user calibration |
| Honeycomb Alpha / Bravo, Saitek X52 | **UNVERIFIED** IDs | | rely on the calibration wizard |

### B5.3 Axis order is platform-specific — never hard-code it

- **Windows (Raw Input) and macOS (IOKit) in Chromium**: `axes[index]` with `index = HID usage − 0x30`:
  X→0, Y→1, Z→2, Rx→3, Ry→4, Rz→5, Slider→6, Dial→7, Wheel→8, **Hat Switch (0x39)→9**; unused slots read 0
  ([raw_input_gamepad_device_win.cc](https://github.com/chromium/chromium/blob/main/device/gamepad/raw_input_gamepad_device_win.cc) `axis_index = UsageMin − kAxisMinimumUsageNumber`,
  [gamepad_device_mac.mm](https://github.com/chromium/chromium/blob/main/device/gamepad/gamepad_device_mac.mm) "axis index corresponds to the usage ID").
  ⇒ Extreme 3D Pro / T.16000M: stick `axes[0]`,`axes[1]`, twist `axes[5]`, throttle `axes[6]`, hat `axes[9]`.
- **Hat as an axis**: value = −1 for up increasing clockwise in steps of 2/7 to +1 (up-left); centred gives an
  out-of-range constant (3.2857 when the HID null state is 15 on a 0–7 range, 1.2857 when it is 8)
  ([Babylon.js forum](https://forum.babylonjs.com/t/what-would-be-a-good-generic-way-to-add-point-of-view-hat-input-on-babylon-genericpad/21825),
  [godot#45734](https://github.com/godotengine/godot/issues/45734)). Chromium's own decoder uses: up `[-1,-0.7) ∪ [0.95,1]`,
  right `[-0.75,-0.1)`, down `[-0.2,0.45)`, left `[0.4,1]`, nothing when `|v| > 1` or `v == 0` at start-up
  ([DpadFromAxis](https://github.com/chromium/chromium/blob/main/device/gamepad/gamepad_standard_mappings.cc)).
- **Linux (joydev)**: axes follow the kernel's `ABS_*` order; for the Extreme 3D Pro typically X, Y, Rz, Throttle, Hat0X,
  Hat0Y = `axes[0..5]` (hat as two ±1 axes) — **UNVERIFIED**, differs from Windows.
- Firefox's ordering can differ again. Therefore presets are only *suggestions*; the first time a non-standard device
  appears, show the **calibration wizard**: "move pitch… roll… twist/rudder… throttle" and record `{axisIndex, min, max,
  inverted}` from the observed extremes (require |Δ| > 0.5 to accept).

### B5.4 Polling and lifecycle

- `navigator.getGamepads()` returns a snapshot array (may contain `null`s); poll it every frame from `poll()`. Chrome
  only exposes a pad after the user presses a button/moves an axis on it (`gamepadconnected` fires then); listen to
  `gamepadconnected`/`gamepaddisconnected` to show a toast and load the profile for `deviceKey`.
- Use `gamepad.timestamp` to detect activity (axis arbitration, §B1); `gamepad.index` is stable for the session.
- Buttons: `.pressed` (threshold ≈ 0.5), `.value` for analog triggers; implement edge detection ourselves.

### B5.5 Deadzone, saturation, response curve

```ts
export interface AxisShaping { deadzone: number /*0.05*/; saturation: number /*0.98*/; curve: number /*0..1 cubic blend*/; invert: boolean; }
export function shapeAxis(x: number, s: AxisShaping): number {
  if (s.invert) x = -x;
  const a = Math.abs(x);
  if (a < s.deadzone) return 0;
  let m = Math.min(1, (a - s.deadzone) / (s.saturation - s.deadzone));     // rescaled so output starts at 0 at the deadzone edge
  m = (1 - s.curve) * m + s.curve * m * m * m;                              // k·x³ + (1−k)·x blend
  return Math.sign(x) * m;
}
// 2-D stick: scaled *radial* deadzone to avoid the "square deadzone corner snap"
export function shapeStick(x: number, y: number, s: AxisShaping): [number, number] {
  const mag = Math.hypot(x, y); if (mag < s.deadzone) return [0, 0];
  const m = Math.min(1, (mag - s.deadzone) / (s.saturation - s.deadzone));
  const k = ((1 - s.curve) * m + s.curve * m ** 3) / mag;
  return [x * k, y * k];
}
```

Scaled radial deadzone and cubic blend per [bugnet.io](https://bugnet.io/blog/how-to-fix-square-deadzone-corner-snapping) and the
FRC "a·x³+(1−a)·x" paper ([Chief Delphi](https://www.chiefdelphi.com/media/papers/2421)). Defaults: Xbox sticks deadzone
0.12, curve 0.3; joysticks deadzone 0.04, curve 0.25 (pitch/roll), 0.4 (twist rudder); triggers deadzone 0.02.
Expose MSFS-style "sensitivity −100..100" as `curve = max(0, −s/100)` plus gain `1 + max(0, s/100)·0.5`.

### B5.6 Throttle axes (unipolar, often inverted)

Sliders report −1..1 with **full forward = −1** on most Logitech/Thrustmaster sticks: `throttle = (1 − a)/2` when
`inverted`, else `(a + 1)/2`; 3 % end deadzones so idle/full are reachable; optional detent: bottom 8 % = idle cut
(`throttle 0`) and, for jets, a reverse zone. Calibration stores observed `min/max` per device because some drivers
report 0..1 only (UE5 guide notes a 0..1 throttle range on the Extreme 3D Pro —
[technical guide](https://medium.com/@Jamesroha/setting-up-a-logitech-extreme-3d-pro-joystick-in-ue5-technical-guide-f8b4abd030ce)).
Expose `mixture`/`propeller` as extra axes for HOTAS throttles with multiple levers (TWCS, Bravo).

### B5.7 Default joystick preset (Extreme 3D Pro / T.16000M, Chromium on Windows/macOS)

| Control | Axis/button | SimAxis / SimAction |
|---|---|---|
| Stick X / Y | `axes[0]` / `axes[1]` | `roll` / `pitch` (pitch: pull back = +1 = nose up, so **invert** Y which is −1 up) |
| Twist | `axes[5]` | `yaw` (curve 0.4) |
| Slider | `axes[6]` (inverted) | `throttle` |
| Hat | `axes[9]` (Windows/macOS) or two axes (Linux) | `lookYaw`/`lookPitch` snap views (cockpit), `trimNoseUp/Down` when `Alt` held |
| Trigger (btn 0) | | `brakesHold` |
| Thumb (btn 1) | | `cameraNext` (Extreme 3D) / `apToggle` |
| Btns 2–5 | | `flapsUp`, `flapsDown`, `gearToggle`, `parkingBrakeToggle` |
| Base 6–11 | | `trimNoseDown`, `trimNoseUp`, `cameraReset`, `cameraCockpit`/`cameraExternal`, `pause`, `toggleMenu` |

### B5.8 Rumble

`gp.vibrationActuator?.playEffect('dual-rumble', { startDelay: 0, duration: 120, weakMagnitude: 0.4, strongMagnitude: 0.8 })`
— Chromium/Edge; Firefox/Safari support is partial/absent (MDN: "not Baseline";
[GamepadHapticActuator.playEffect](https://developer.mozilla.org/en-US/docs/Web/API/GamepadHapticActuator/playEffect)). Use for
touchdown (strong ∝ |vs|), stall buffet (weak 0.25, 100 ms pulses at 10 Hz), ground roll (weak ∝ speed). Always feature-detect.

## B6. Touch (phones/tablets)

- Layout (landscape): left virtual stick (radius 120 CSS px, dynamic — appears where the thumb lands) → `pitch`/`roll`;
  right vertical slider (0..1, sticky) → `throttle`; right stick or two bottom buttons → `yaw`; buttons for flaps ±, gear,
  brakes (hold), camera, pause, menu. Pinch → zoom; two-finger drag on empty space → free-look.
- Implementation: Pointer Events only (`pointerdown/move/up/cancel`), one state per `pointerId`, `setPointerCapture`,
  `touch-action: none` on the canvas and overlay, `<meta name="viewport" content="width=device-width, user-scalable=no">`.
  A dependency-free stick is ~150 lines; [nipplejs](https://github.com/yoannmoinet/nipplejs) (MIT, verify LICENSE) offers
  the same "dynamic/semi/static" modes if preferred.
- Shape the stick with `shapeStick` (deadzone 0.08, curve 0.3). Stick radius 120 px ⇒ full deflection; "fly-by-slide"
  (no auto-centre) option for throttle only.
- **Tilt**: `DeviceOrientationEvent.requestPermission()` exists only on iOS ≥ 13 and must be called from a tap
  (`touchend`/`click`, not `touchstart`) over HTTPS; Android needs no permission
  ([dev.to summary](https://dev.to/li/how-to-requestpermission-for-devicemotion-and-deviceorientation-events-in-ios-13-46g2)).
  Map `gamma → roll` (±30° = full), `beta − beta₀ → pitch` (±20°), low-pass α = 0.2, recalibrate neutral on enable.
- Haptics: `navigator.vibrate(ms)` (Android only). Lock landscape via `screen.orientation.lock('landscape')` after
  entering fullscreen (**not supported on iOS Safari**).

## B7. `InputManager` design (rebindable actions)

```ts
// src/input/bindings.ts
export type Chord = { code: string; ctrl?: boolean; shift?: boolean; alt?: boolean };           // KeyboardEvent.code based
export type AxisSource =
  | { kind: 'gamepad'; axis: number; shaping: AxisShaping; unipolar?: boolean }                // stick/slider
  | { kind: 'gamepad-buttons'; neg?: number; pos?: number; ramp: number }                     // e.g. LT/RT → yaw, A/B → throttle
  | { kind: 'keys'; neg?: Chord; pos?: Chord; tap: number; ramp: number; ret: number; autoCentre: boolean }
  | { kind: 'mouse-yoke'; component: 'x' | 'y'; shaping: AxisShaping }
  | { kind: 'touch'; control: 'stick-x' | 'stick-y' | 'throttle' | 'rudder' | 'tilt-roll' | 'tilt-pitch' };
export type ActionTrigger =
  | { kind: 'key'; chord: Chord }
  | { kind: 'gamepad-button'; button: number; modifier?: number }                             // modifier = another button held
  | { kind: 'hat'; axis: number; dir: 'up' | 'down' | 'left' | 'right' }
  | { kind: 'touch-button'; id: string };
export interface BindingProfile {
  id: string; name: string; version: 1;
  device: 'keyboard' | 'mouse' | 'touch' | { kind: 'standard-gamepad' } | { kind: 'hid'; vendor: string; product: string };
  axes: Array<{ axis: SimAxis; source: AxisSource }>;
  actions: Array<{ action: SimAction; trigger: ActionTrigger; whileHeld?: boolean }>;       // whileHeld → populates InputSnapshot.held
}

// src/input/inputManager.ts
export interface InputSource { readonly id: string; attach(el: HTMLElement): void; detach(): void; poll(dt: number, out: FrameInput): void; }
export class InputManager {
  constructor(private canvas: HTMLElement, private profiles: BindingProfile[], private store = new BindingStore('fs.bindings.v1')) {}
  poll(dt: number): InputSnapshot;      // merges KeyboardSource, MouseSource, GamepadSource, TouchSource with per-axis arbitration
  startRebind(target: { action: SimAction } | { axis: SimAxis }, timeoutMs = 4000): Promise<ActionTrigger | AxisSource | null>; // captures next chord / button / axis with |Δ|>0.5
  setProfile(deviceKey: string, p: BindingProfile): void;  // persists
  on(event: 'deviceConnected' | 'deviceDisconnected' | 'conflict', cb: (...a: unknown[]) => void): () => void;
}
```

Default keyboard profile as data (chord strings parsed by `parseChord('Ctrl+NumpadDecimal')`):

```ts
export const KEYBOARD_MSFS_2020: Record<string, SimAction | [SimAction, 'held']> = {
  'F1': 'throttleCut', 'F2': 'throttleDec', 'F3': 'throttleInc', 'F4': 'throttleFull',
  'Ctrl+Shift+F1': 'mixtureLean', 'Ctrl+Shift+F2': 'mixtureDec', 'Ctrl+Shift+F3': 'mixtureInc', 'Ctrl+Shift+F4': 'mixtureRich',
  'F5': 'flapsRetract', 'F6': 'flapsUp', 'F7': 'flapsDown', 'F8': 'flapsFull',
  'KeyG': 'gearToggle', 'Ctrl+NumpadDecimal': 'parkingBrakeToggle', 'NumpadDecimal': ['brakesHold', 'held'],
  'Numpad7': 'trimNoseDown', 'Numpad1': 'trimNoseUp', 'Ctrl+Numpad0': 'rudderTrimLeft', 'Ctrl+NumpadEnter': 'rudderTrimRight',
  'Ctrl+Numpad4': 'aileronTrimLeft', 'Ctrl+Numpad6': 'aileronTrimRight',
  'Ctrl+KeyE': 'engineAutoStart', 'Ctrl+Shift+KeyE': 'engineShutdown', 'KeyM': 'magnetosNext', 'Shift+KeyM': 'magnetosPrev',
  'KeyL': 'lightsAll', 'Ctrl+KeyL': 'lightsLanding', 'Alt+KeyN': 'lightsNav', 'Alt+KeyH': 'lightsBeacon', 'KeyO': 'lightsStrobe', 'Alt+KeyJ': 'lightsTaxi',
  'KeyZ': 'apToggle', 'Ctrl+KeyH': 'apHdg', 'Ctrl+KeyT': 'apAlt', 'Ctrl+KeyN': 'apNav', 'Ctrl+KeyA': 'apApr', 'Ctrl+KeyF': 'fdToggle', 'KeyB': 'altimeterStd',
  'End': 'cameraNext', 'Insert': 'cameraDrone', 'Ctrl+Space': 'cameraReset', 'KeyS': 'cameraChase',
  'Escape': 'toggleMenu', 'Pause': 'pause', 'KeyY': 'slewToggle', 'ScrollLock': 'toggleAtc', 'KeyR': 'timeNormal', 'Ctrl+NumpadAdd': 'timeFaster', 'Ctrl+NumpadSubtract': 'timeSlower',
  'F11': 'toggleHud', 'F12': 'screenshot', 'Shift+KeyR': 'repairRefuel',
};
export const KEYBOARD_AXES: Array<{ axis: SimAxis; neg: string; pos: string; tap: number; ramp: number; ret: number; autoCentre: boolean }> = [
  { axis: 'pitch', neg: 'Numpad8', pos: 'Numpad2', tap: 0.15, ramp: 2.5, ret: 3.0, autoCentre: true },   // Num 8 = nose down = −pitch
  { axis: 'roll',  neg: 'Numpad4', pos: 'Numpad6', tap: 0.15, ramp: 2.5, ret: 3.0, autoCentre: true },
  { axis: 'yaw',   neg: 'Numpad0', pos: 'NumpadEnter', tap: 0.20, ramp: 3.0, ret: 4.0, autoCentre: true },
  { axis: 'brakeLeft',  pos: 'NumpadMultiply', neg: '', tap: 0, ramp: 4.0, ret: 6.0, autoCentre: true },
  { axis: 'brakeRight', pos: 'NumpadSubtract', neg: '', tap: 0, ramp: 4.0, ret: 6.0, autoCentre: true },
];
```

Poll algorithm per frame: (1) keyboard: update `KeyAxis` states, collect edge actions (ignoring `repeat`), fill `held`;
(2) mouse: pointer deltas (free-look) or virtual stick (yoke), wheel → `cameraZoom`; (3) gamepads: for each connected pad
load its profile by `deviceKey`, shape axes, edge-detect buttons, decode hats; (4) touch overlay state; (5) arbitration:
for each `SimAxis` take the source with the latest `lastChange` within 0.5 s, else keep the previous value (throttle-type
axes are *absolute* from sticks but *incremental* from keys/buttons — when a slider owns the axis, keyboard increments
are ignored until the slider is idle 2 s); (6) emit `InputSnapshot`. Conflict handling in the rebind UI: same chord bound
twice → offer swap; `Escape` cancels capture; capture ignores modifier-only presses.

Unit-testable in Node: `shapeAxis`, `shapeStick`, `KeyAxis`, `parseGamepadId`, hat decoding, arbitration (fake sources).
Playwright: dispatch `keydown`/`keyup` with `code`, assert `ControlInputs.throttle` ramps; emulate touch pointers.

---

## Appendix — licences of referenced assets/libraries

| Item | Licence | Use |
|---|---|---|
| Three.js audio classes (r187) | MIT | spatialisation |
| Kenney Interface Sounds / UI Audio | CC0 (verify pack file) | optional UI clicks |
| Freesound clips | per clip: CC0 / CC BY / CC BY-NC — bundle **CC0 only**, credit CC BY | optional RPM loops |
| nipplejs | MIT | optional touch stick |
| feross/unmute-ios-audio | MIT | optional iOS silent-switch workaround |
| VinZu17/Engine-Sound-Simulator | MIT | reference only (architecture) |
| Chromium gamepad sources | BSD-3 | reference only (axis/hat behaviour) |
| Paul Kellet pink-noise filter (musicdsp) | public domain code snippet | noise generator |
