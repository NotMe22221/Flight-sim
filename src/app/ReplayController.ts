/**
 * Replay playback: freezes the live simulation and drives the visual aircraft state from the
 * ReplayRecorder ring buffer, with play/pause, scrubbing and speed. Cameras keep working, so the
 * drone and orbit views can be used to review a landing.
 */
import { eulerFromQ, qConj } from '../core/math';
import type { AircraftState, Quat } from '../core/types';
import { emptyReplayFrame, type ReplayRecorder } from '../activities/ReplayRecorder';
import type { LocalFrame } from '../geo/wgs84';

export class ReplayController {
  active = false;
  playing = false;
  speed = 1;
  /** current playback time (sim seconds, recorder clock) */
  t = 0;
  private readonly frame = emptyReplayFrame();
  private readonly qbn: Quat = [1, 0, 0, 0];

  constructor(private readonly recorder: ReplayRecorder) {}

  get start(): number { return this.recorder.startTime; }
  get end(): number { return this.recorder.endTime; }
  get available(): boolean { return this.recorder.length > 30; }

  enter(): boolean {
    if (!this.available) return false;
    this.active = true;
    this.playing = true;
    this.t = this.start;
    return true;
  }

  exit(): void { this.active = false; this.playing = false; }

  seek(t: number): void { this.t = Math.min(Math.max(t, this.start), this.end); }

  /** Advance playback and write the sampled pose into `out` (a copy of the live state for non-recorded fields). */
  update(dt: number, out: AircraftState, frame: LocalFrame): void {
    if (!this.active) return;
    if (this.playing) {
      this.t += dt * this.speed;
      if (this.t >= this.end) { this.t = this.end; this.playing = false; }
    }
    const f = this.frame;
    if (!this.recorder.sample(this.t, f)) return;
    out.posNED[0] = f.posNED[0]; out.posNED[1] = f.posNED[1]; out.posNED[2] = f.posNED[2];
    out.qNB[0] = f.qNB[0]; out.qNB[1] = f.qNB[1]; out.qNB[2] = f.qNB[2]; out.qNB[3] = f.qNB[3];
    eulerFromQ(qConj(f.qNB, this.qbn), out.euler);
    out.headingTrueRad = out.euler[2] < 0 ? out.euler[2] + 2 * Math.PI : out.euler[2];
    // nested objects of `out` alias the live flight-model state: replace them, never mutate them
    out.geo = frame.nedToGeodetic(f.posNED[0], f.posNED[1], f.posNED[2], { lat: 0, lon: 0, alt: 0 });
    out.altitudeMslM = f.altitudeMslM;
    out.verticalSpeedMs = f.verticalSpeedMs;
    out.aero = { ...out.aero, ias: f.iasMs };
    out.onGround = f.onGround;
    out.surfaces = { ...out.surfaces, ...f.surfaces };
    out.engine = { ...out.engine, rpm: f.rpm };
    out.gear = out.gear.map((g, i) => (i < 3 ? { ...g, compressionM: f.gearCompression[i], wheelSpeedMs: f.wheelSpeed[i] } : g));
  }

  /** Lights recorded with the frame (for the visual model's light state). */
  get lights() { return this.frame.lights; }
}
