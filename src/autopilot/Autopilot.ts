/**
 * GFC-700-style attitude-based autopilot and flight director for the C172.
 *
 * Structure (docs/research/05 §5.2):
 *   lateral mode  → bank command φc (limited, slewed) → roll PID (+ roll-rate damping) → aileron servo
 *   vertical mode → VS command ḣc → VS→pitch PI → pitch command θc (limited, slewed)
 *                   (PIT / FLC command θc directly)   → pitch PID (+ pitch-rate damping) → elevator servo
 *   auto-trim slowly moves the trim wheel so the elevator servo returns to centre; the yaw damper adds
 *   rudder from washed-out yaw rate and works independently of the AP.
 *
 * The outer loops run whenever the AP or the flight director is on, so the FD bars (`fdRollRad`,
 * `fdPitchRad`) always show the commanded attitude. The inner loops only run while engaged.
 *
 * Conventions: SI/rad inside; `ControlInputs` pitch + = nose up (stick back), roll + = right,
 * yaw + = nose right, pitchTrim + = nose up. Heading bug and OBS are magnetic, flight-plan tracks true.
 */
import type { AircraftState, Autopilot, AutopilotState, ControlInputs, FlightPlan, LateralMode, NavRadioState, VerticalMode } from '../core/types';
import type { EventBus } from '../core/events';
import { clamp, wrap360, wrapPi } from '../core/math';
import { DEG, FPM, FT, KT, NM } from '../core/units';
import { Pid } from './pid';
import { Differentiator, RateLimiter, Washout } from './filters';
import { type AutopilotConfig, type DeepPartial, defaultAutopilotConfig, mergeConfig } from './config';
import { cdiToDots, effectiveBankLimit, gpsInterceptTrack, headingToBank, locInterceptTrack, vorInterceptTrack } from './lateral';
import { altCaptureDistance, altitudeToVs, glideslopeVs, levelFlightPitch } from './vertical';
import { alphaLimitedPitch, loadFactorPitchRate, wingsFirst } from './level';

export type DisconnectReason = 'pilot' | 'override' | 'stall' | 'bank' | 'overspeed' | 'crash' | 'power';
export type ApButton =
  | 'AP' | 'FD' | 'YD' | 'HDG' | 'NAV' | 'APR' | 'ALT' | 'VS' | 'FLC' | 'LVL'
  | 'NOSE_UP' | 'NOSE_DN' | 'HDG_SYNC' | 'ALT_SYNC';
/** Which navigation source NAV mode follows ('auto': flight plan when one exists, else NAV1). */
export type NavSource = 'auto' | 'gps' | 'nav1' | 'nav2';
export type AltAlert = 'none' | 'approach' | 'deviation';
export interface NavInputs { nav1: NavRadioState; nav2: NavRadioState; plan: FlightPlan | null }

export interface GfcAutopilotState extends AutopilotState {
  /** why the servos last dropped off; cleared on engage */
  disconnectReason: DisconnectReason | null;
  /** autopilot clock (s) at the last mode / engagement change (UI flashes the annunciator ~10 s) */
  modeChangeT: number;
  /** autopilot clock (s) at the last disconnect (UI flashes "AP" red and sounds the tone) */
  disconnectT: number;
  /** autopilot clock, s (sum of update dt) */
  t: number;
  /** altitude alerter: 1000 ft before the armed altitude, or ±200 ft off a held altitude */
  altAlert: AltAlert;
  /**
   * LVL (level mode) active: wings level + zero vertical speed, nothing armed, recovery from unusual
   * attitudes allowed. The shared contract has no 'LVL' mode, so `lateral` reads 'ROL' and
   * `vertical` reads 'VS' meanwhile; annunciators should show "LVL" in both fields when this is set.
   */
  lvl: boolean;
}

export interface GfcAutopilotOptions {
  config?: DeepPartial<AutopilotConfig>;
  /** when given, 'autopilot:changed' is emitted on every mode / engagement change */
  events?: EventBus;
}

type SourceKind = 'none' | 'gps' | 'vor' | 'loc';
interface ResolvedSource { kind: SourceKind; radio: NavRadioState | null; plan: FlightPlan | null }

const VS_BASED: ReadonlySet<VerticalMode> = new Set<VerticalMode>(['VS', 'ALT', 'ALTS', 'GS']);
const NAV_MODES: ReadonlySet<LateralMode> = new Set<LateralMode>(['NAV', 'GPS', 'LOC', 'APR']);

const copyInputs = (src: ControlInputs, dst: ControlInputs): void => {
  dst.pitch = src.pitch; dst.roll = src.roll; dst.yaw = src.yaw;
  dst.pitchTrim = src.pitchTrim; dst.rudderTrim = src.rudderTrim; dst.aileronTrim = src.aileronTrim;
  dst.flapsIndex = src.flapsIndex; dst.throttle = src.throttle; dst.mixture = src.mixture; dst.propeller = src.propeller;
  dst.brakeLeft = src.brakeLeft; dst.brakeRight = src.brakeRight; dst.parkingBrake = src.parkingBrake;
  dst.magnetos = src.magnetos; dst.starter = src.starter; dst.fuelSelector = src.fuelSelector;
  dst.gearDown = src.gearDown; dst.speedbrake = src.speedbrake;
  dst.lights.nav = src.lights.nav; dst.lights.beacon = src.lights.beacon; dst.lights.strobe = src.lights.strobe;
  dst.lights.landing = src.lights.landing; dst.lights.taxi = src.lights.taxi; dst.lights.panel = src.lights.panel;
  dst.pitotHeat = src.pitotHeat; dst.carbHeat = src.carbHeat;
};

export class GfcAutopilot implements Autopilot {
  readonly state: GfcAutopilotState = {
    engaged: false, flightDirector: false, lateral: 'OFF', vertical: 'OFF', armedLateral: null, armedVertical: null,
    headingBugDeg: 0, altitudeTargetM: 0, verticalSpeedTargetMs: 0, iasTargetMs: 100 * KT, pitchTargetRad: 0, rollTargetRad: 0,
    fdPitchRad: 0, fdRollRad: 0, outPitch: 0, outRoll: 0, outYaw: 0, yawDamper: false, trimCommand: 0,
    disconnectReason: null, modeChangeT: 0, disconnectT: Number.NEGATIVE_INFINITY, t: 0, altAlert: 'none', lvl: false,
  };
  readonly config: AutopilotConfig;
  navSource: NavSource = 'auto';

  private readonly events: EventBus | undefined;
  private readonly rollPid: Pid;
  private readonly pitchPid: Pid;
  private readonly vsPid: Pid;
  private readonly flcPid: Pid;
  private readonly rollCmd: RateLimiter;
  private readonly pitchCmd: RateLimiter;
  private readonly rollServo: RateLimiter;
  private readonly pitchServo: RateLimiter;
  private readonly ydWashout: Washout;
  private readonly lateralDotsRate = new Differentiator(1.0);
  private readonly blended: ControlInputs;
  private readonly src: ResolvedSource = { kind: 'none', radio: null, plan: null };
  private readonly changedPayload: { state: AutopilotState };
  private readonly disconnectCbs = new Set<(reason: DisconnectReason) => void>();
  private readonly modeCbs = new Set<(state: GfcAutopilotState) => void>();

  private lastAc: AircraftState | null = null;
  private lastNav: NavInputs | null = null;
  private pilotPitch = 0;
  private pilotRoll = 0;
  private pilotTrim = 0;
  private overrideTimer = 0;
  private trimTimer = 0;
  private trimRunning = false;
  private gsLostTimer = 0;
  private sourceLostTimer = 0;
  private locIntegral = 0;
  private gsIntegral = 0;
  private altCaptureK = 0;
  private altCaptureVs = 0;
  private vsCmd = 0;
  private pendingEngageSync = false;
  /** LVL wings-first phase is flying the load-factor (unload) law instead of the θ loop */
  private lvlUnloading = false;
  /** avionics bus powered (from `AircraftState.electrical`; flight models without one count as powered) */
  private powered = true;
  private unpoweredT = 0;

  constructor(opts: GfcAutopilotOptions = {}) {
    this.config = mergeConfig(defaultAutopilotConfig(), opts.config);
    this.events = opts.events;
    const { limits: L, gains: g } = this.config;
    this.rollPid = new Pid({ ...g.roll, outMin: -L.servoAuthority, outMax: L.servoAuthority });
    this.pitchPid = new Pid({ ...g.pitch, outMin: -L.servoAuthority, outMax: L.servoAuthority });
    this.vsPid = new Pid({ kp: g.vsToPitchKp, ki: g.vsToPitchKi, kd: 0, outMin: L.pitchMinRad, outMax: L.pitchMaxRad, iLim: L.pitchMaxRad, tt: 2 });
    // FLC: negative gains — faster than target → nose up; derivative on IAS = acceleration damping
    this.flcPid = new Pid({ kp: -g.flcKp, ki: -g.flcKi, kd: -g.flcKd, tauD: g.flcTauD, outMin: L.pitchMinRad, outMax: L.pitchMaxRad, iLim: L.pitchMaxRad, tt: 2 });
    this.rollCmd = new RateLimiter(L.rollCmdRateRadS);
    this.pitchCmd = new RateLimiter(L.pitchCmdRateRadS);
    this.rollServo = new RateLimiter(L.servoRatePerS);
    this.pitchServo = new RateLimiter(L.servoRatePerS);
    this.ydWashout = new Washout(g.ydWashoutS);
    this.blended = {
      pitch: 0, roll: 0, yaw: 0, pitchTrim: 0, rudderTrim: 0, aileronTrim: 0, flapsIndex: 0, throttle: 0, mixture: 1, propeller: 1,
      brakeLeft: 0, brakeRight: 0, parkingBrake: false, magnetos: 3, starter: false, fuelSelector: 'both', gearDown: true, speedbrake: 0,
      lights: { nav: false, beacon: false, strobe: false, landing: false, taxi: false, panel: 0 }, pitotHeat: false, carbHeat: false,
    };
    this.changedPayload = { state: this.state };
  }

  // ───────────────────────────── diagnostics ─────────────────────────────

  /** Bank command currently fed to the roll loop / FD bar, rad. */
  get rollCommandRad(): number { return this.rollCmd.value; }
  /** Pitch command currently fed to the pitch loop / FD bar, rad. */
  get pitchCommandRad(): number { return this.pitchCmd.value; }
  /** Vertical-speed command of the active VS-based mode, m/s (0 in PIT/FLC). */
  get vsCommandMs(): number { return this.vsCmd; }

  /** Subscribe to disconnects; returns an unsubscribe function. */
  onDisconnect(cb: (reason: DisconnectReason) => void): () => void {
    this.disconnectCbs.add(cb);
    return () => { this.disconnectCbs.delete(cb); };
  }

  /** Subscribe to mode / engagement changes (annunciator updates); returns an unsubscribe function. */
  onModeChange(cb: (state: GfcAutopilotState) => void): () => void {
    this.modeCbs.add(cb);
    return () => { this.modeCbs.delete(cb); };
  }

  // ───────────────────────────── engagement ─────────────────────────────

  /** False while the avionics bus is unpowered: the AP, FD and YD are off and cannot be turned on. */
  get isPowered(): boolean { return this.powered; }

  engage(on: boolean): void {
    const s = this.state;
    if (on === s.engaged) return;
    if (!on) { this.disconnect('pilot'); return; }
    if (!this.powered) return;
    s.engaged = true;
    s.disconnectReason = null;
    if (s.lateral === 'OFF') this.selectRollHold();
    if (s.vertical === 'OFF') this.selectPitchHold();
    this.overrideTimer = 0;
    this.trimTimer = 0;
    this.trimRunning = false;
    s.trimCommand = this.pilotTrim;
    if (this.lastAc) this.syncServos(this.lastAc);
    else this.pendingEngageSync = true;
    this.modeChanged();
  }

  /** Drop the servos. Modes are kept while the flight director is on, cleared otherwise. */
  disconnect(reason: DisconnectReason = 'pilot'): void {
    const s = this.state;
    if (!s.engaged) return;
    s.engaged = false;
    s.lvl = false;
    this.lvlUnloading = false;
    s.outPitch = 0;
    s.outRoll = 0;
    s.disconnectReason = reason;
    s.disconnectT = s.t;
    this.overrideTimer = 0;
    this.trimTimer = 0;
    this.trimRunning = false;
    this.pendingEngageSync = false;
    if (!s.flightDirector) this.clearModes();
    for (const cb of this.disconnectCbs) cb(reason);
    this.modeChanged();
  }

  setFlightDirector(on: boolean): void {
    const s = this.state;
    if (on === s.flightDirector || (on && !this.powered)) return;
    s.flightDirector = on;
    if (on) {
      if (s.lateral === 'OFF') this.selectRollHold();
      if (s.vertical === 'OFF') this.selectPitchHold();
    } else if (!s.engaged) this.clearModes();
    this.modeChanged();
  }

  setYawDamper(on: boolean): void {
    if (on === this.state.yawDamper || (on && !this.powered)) return;
    this.state.yawDamper = on;
    if (this.lastAc) this.ydWashout.reset(this.lastAc.rates[2]);
    this.modeChanged();
  }

  /**
   * LVL (blue button): AP on at any attitude, wings level, zero vertical speed, every armed mode
   * disarmed, the selected altitude left alone (LVL does not hold an altitude). Recovery from unusual
   * attitudes: the bank / overspeed / stall-warning disconnects are suspended, the wings are levelled
   * first (faster roll-command slew), then the pitch returns to zero VS at a load-factor-limited
   * rate and never above the LVL angle-of-attack ceiling. Any mode selection ends LVL.
   */
  level(): void {
    if (!this.powered) return;
    const s = this.state;
    const ac = this.lastAc;
    s.lateral = 'ROL';
    s.rollTargetRad = 0;
    s.armedLateral = null;
    s.armedVertical = null;
    s.verticalSpeedTargetMs = 0;
    this.enterVsMode('VS');
    s.lvl = true;
    if (ac) {
      // AP off: the commands start from the attitude the aircraft is in, even far outside the limits
      if (!s.engaged) { this.rollCmd.reset(ac.euler[0]); this.pitchCmd.reset(ac.euler[1]); }
      // zero-VS loop primed with the level-flight pitch (≈ α), so its P term pulls in proportion to the sink rate
      this.vsPid.resetToOutput(levelFlightPitch(ac.euler[1], ac.verticalSpeedMs, ac.aero.tas), ac.verticalSpeedMs, ac.verticalSpeedMs);
    }
    if (!s.engaged) this.engage(true);
    else this.modeChanged();
  }

  /** Reset to power-on state. */
  reset(): void {
    const s = this.state;
    s.engaged = false; s.flightDirector = false; s.yawDamper = false;
    this.clearModes();
    s.outPitch = 0; s.outRoll = 0; s.outYaw = 0; s.trimCommand = 0;
    s.fdPitchRad = 0; s.fdRollRad = 0;
    s.disconnectReason = null; s.altAlert = 'none'; s.lvl = false;
    this.rollPid.reset(); this.pitchPid.reset(); this.vsPid.reset(); this.flcPid.reset();
    this.ydWashout.reset(); this.lateralDotsRate.reset();
    this.locIntegral = 0; this.gsIntegral = 0; this.overrideTimer = 0; this.trimTimer = 0; this.trimRunning = false; this.sourceLostTimer = 0; this.gsLostTimer = 0;
    this.lastAc = null; this.lastNav = null; this.pendingEngageSync = false; this.lvlUnloading = false; this.powered = true; this.unpoweredT = 0;
  }

  // ───────────────────────────── mode selection ─────────────────────────────

  setLateral(mode: LateralMode): void {
    const s = this.state;
    if (!this.powered && mode !== 'OFF') return;
    s.lvl = false;
    if (mode !== 'OFF' && !s.engaged && !s.flightDirector) this.setFlightDirector(true); // a mode key turns the FD on
    switch (mode) {
      case 'OFF':
        if (s.engaged || s.flightDirector) this.selectRollHold();
        else { s.lateral = 'OFF'; s.armedLateral = null; }
        break;
      case 'ROL':
        this.selectRollHold();
        break;
      case 'HDG':
        if (s.lateral !== 'HDG') {
          if (NAV_MODES.has(s.lateral)) s.armedLateral = null; // leaving a captured nav mode drops it entirely
          s.lateral = 'HDG';
          if (s.vertical === 'GS') this.selectPitchHold();
        }
        break;
      default:
        this.armOrCaptureLateral(mode);
    }
    this.modeChanged();
  }

  setVertical(mode: VerticalMode): void {
    const s = this.state;
    if (!this.powered && mode !== 'OFF') return;
    s.lvl = false;
    if (mode !== 'OFF' && mode !== 'GS' && !s.engaged && !s.flightDirector) this.setFlightDirector(true);
    switch (mode) {
      case 'OFF':
        if (s.engaged || s.flightDirector) this.selectPitchHold();
        else { s.vertical = 'OFF'; s.armedVertical = null; }
        break;
      case 'PIT': this.selectPitchHold(); break;
      case 'VS': this.enterVsMode('VS'); break;
      case 'ALT': case 'ALTS': this.enterVsMode('ALT'); break;
      case 'FLC': this.enterFlc(); break;
      case 'GS':
        if (s.lateral === 'APR' || s.armedLateral === 'APR') s.armedVertical = 'GS';
        break;
      default:
        break;
    }
    this.modeChanged();
  }

  // Setters ignore non-finite values: a NaN target would otherwise run into the loop integrators.
  setHeadingBug(deg: number): void { if (Number.isFinite(deg)) this.state.headingBugDeg = wrap360(deg); }
  setAltitudeTarget(m: number): void { if (Number.isFinite(m)) this.state.altitudeTargetM = m; }
  setVerticalSpeedTarget(ms: number): void {
    const L = this.config.limits;
    if (Number.isFinite(ms)) this.state.verticalSpeedTargetMs = clamp(ms, -L.vsSelectMaxMs, L.vsSelectMaxMs);
  }
  setIasTarget(ms: number): void { if (Number.isFinite(ms)) this.state.iasTargetMs = Math.max(ms, 0); }
  setPitchTarget(rad: number): void {
    const L = this.config.limits;
    if (Number.isFinite(rad)) this.state.pitchTargetRad = clamp(rad, L.pitchMinRad, L.pitchMaxRad);
  }
  /** Select which receiver NAV mode follows. */
  setNavSource(src: NavSource): void { this.navSource = src; }

  /** Panel-button semantics (toggle / sync) on top of the plain setters. */
  press(button: ApButton): void {
    const s = this.state;
    const ac = this.lastAc;
    switch (button) {
      case 'AP': this.engage(!s.engaged); break;
      case 'FD': this.setFlightDirector(!s.flightDirector); break;
      case 'YD': this.setYawDamper(!s.yawDamper); break;
      case 'HDG': this.setLateral(s.lateral === 'HDG' ? 'ROL' : 'HDG'); break;
      case 'NAV':
        if (s.lateral === 'NAV' || s.armedLateral === 'NAV') { s.armedLateral = null; this.setLateral('ROL'); }
        else this.setLateral('NAV');
        break;
      case 'APR':
        if (s.lateral === 'APR' || s.armedLateral === 'APR') { s.armedLateral = null; this.setLateral('ROL'); }
        else this.setLateral('APR');
        break;
      case 'ALT':
        if (s.vertical === 'ALT' || s.vertical === 'ALTS') this.setVertical('PIT');
        else {
          if (ac) s.altitudeTargetM = Math.round(ac.altitudeIndicatedM / (10 * FT)) * 10 * FT;
          this.setVertical('ALT');
        }
        break;
      case 'VS':
        if (s.vertical === 'VS') this.setVertical('PIT');
        else {
          if (ac) this.setVerticalSpeedTarget(Math.round(ac.verticalSpeedMs / (100 * FPM)) * 100 * FPM);
          this.setVertical('VS');
        }
        break;
      case 'FLC':
        if (s.vertical === 'FLC') this.setVertical('PIT');
        else {
          if (ac) this.setIasTarget(Math.round(ac.aero.ias / KT) * KT);
          this.setVertical('FLC');
        }
        break;
      case 'LVL': this.level(); break;
      case 'NOSE_UP': this.nudge(+1); break;
      case 'NOSE_DN': this.nudge(-1); break;
      case 'HDG_SYNC': if (ac) this.setHeadingBug(ac.headingMagRad / DEG); break;
      case 'ALT_SYNC': if (ac) this.setAltitudeTarget(Math.round(ac.altitudeIndicatedM / (100 * FT)) * 100 * FT); break;
      default: break;
    }
  }

  private nudge(dir: 1 | -1): void {
    const s = this.state;
    if (s.lvl) { s.lvl = false; this.modeChanged(); } // UP/DN in LVL turns it into plain VS
    switch (s.vertical) {
      case 'PIT': this.setPitchTarget(s.pitchTargetRad + dir * 0.5 * DEG); break;
      case 'VS': this.setVerticalSpeedTarget(s.verticalSpeedTargetMs + dir * 100 * FPM); break;
      case 'FLC': this.setIasTarget(s.iasTargetMs - dir * KT); break;
      default: break;
    }
  }

  // ───────────────────────────── per-frame update ─────────────────────────────

  update(dt: number, ac: AircraftState, nav: NavInputs): void {
    if (!(dt > 0)) return;
    if (dt > 0.25) dt = 0.25;
    const s = this.state;
    const { limits: L, gains: g, protections: p } = this.config;
    s.t += dt;
    this.lastAc = ac;
    this.lastNav = nav;

    // The GFC 700 runs off the avionics bus: losing it drops the servos, the FD and the YD. A short
    // debounce rides through a flight model publishing its bus a step late (e.g. right after reset).
    const busOk = !ac.electrical || ac.electrical.avionicsPowered;
    this.unpoweredT = busOk ? 0 : this.unpoweredT + dt;
    this.powered = this.unpoweredT < p.powerLossS;
    if (!this.powered) {
      if (s.engaged) this.disconnect('power');
      if (s.flightDirector) this.setFlightDirector(false);
      if (s.yawDamper) this.setYawDamper(false);
    }

    if (this.pendingEngageSync) {
      this.pendingEngageSync = false;
      if (s.lateral === 'ROL' && s.rollTargetRad === 0) this.selectRollHold();
      if (s.vertical === 'PIT' && s.pitchTargetRad === 0) this.selectPitchHold();
      this.rollCmd.reset(ac.euler[0]);
      this.pitchCmd.reset(ac.euler[1]);
      this.syncServos(ac);
    }

    // Gain scheduling with airspeed (gains were tuned at the reference speed).
    let scale = 1;
    if (g.qbarScheduling) {
      const r = g.qbarRefSpeedMs / Math.max(ac.aero.ias, 10);
      scale = clamp(Math.pow(r, g.qbarScheduleExponent), g.qbarScaleMin, g.qbarScaleMax);
    }
    this.rollPid.gainScale = scale;
    this.pitchPid.gainScale = scale;

    // Protections.
    if (s.engaged) {
      // LVL is the recovery mode: it stays engaged in steep banks, overspeed and stall warning
      // (its α ceiling keeps the pitch command out of the stall).
      if (ac.crashed) this.disconnect('crash');
      else if (!s.lvl && p.disconnectOnStallWarning && (ac.aero.stallWarning || ac.warnings.stall)) this.disconnect('stall');
      else if (!s.lvl && Math.abs(ac.euler[0]) > p.maxBankRad) this.disconnect('bank');
      else if (!s.lvl && p.disconnectOnOverspeed && ac.warnings.overspeed) this.disconnect('overspeed');
      else {
        const over = Math.abs(this.pilotPitch) > p.overrideThreshold || Math.abs(this.pilotRoll) > p.overrideThreshold;
        this.overrideTimer = over ? this.overrideTimer + dt : 0;
        if (this.overrideTimer >= p.overrideTimeS) this.disconnect('override');
      }
    }

    const active = s.engaged || s.flightDirector;
    if (active) {
      // modes exist exactly while the AP or FD is on (robust to the state being written directly)
      if (s.lateral === 'OFF') this.selectRollHold();
      if (s.vertical === 'OFF') this.selectPitchHold();
      this.updateLateralModes(dt, ac, nav);
      this.updateVerticalModes(dt, ac, nav);
    } else if (s.lateral !== 'OFF' || s.vertical !== 'OFF' || s.armedLateral !== null || s.armedVertical !== null) {
      this.clearModes();
      s.lvl = false;
    }
    this.rollCmd.ratePerS = s.lvl ? L.lvlRollCmdRateRadS : L.rollCmdRateRadS;
    this.pitchCmd.ratePerS = s.lvl ? loadFactorPitchRate(L.lvlLoadFactor, ac.aero.tas, L.pitchCmdRateRadS) : L.pitchCmdRateRadS;

    // LVL wings-first unloading (inner loop below); on its end the pitch command restarts at θ
    const unloading = s.engaged && s.lvl && wingsFirst(ac.euler[0], L.lvlWingsFirstBankRad);
    if (this.lvlUnloading && !unloading) this.pitchCmd.reset(ac.euler[1]);

    // Outer loops → attitude commands (also the FD bars).
    const prevRollCmd = this.rollCmd.value, prevPitchCmd = this.pitchCmd.value;
    if (active && s.lateral !== 'OFF') this.rollCmd.update(this.lateralCommand(dt, ac, nav), dt);
    else this.rollCmd.reset(ac.euler[0]);
    if (active && s.vertical !== 'OFF') this.pitchCmd.update(this.verticalCommand(dt, ac, nav), dt);
    else { this.pitchCmd.reset(ac.euler[1]); this.vsCmd = 0; }
    s.fdRollRad = this.rollCmd.value;
    s.fdPitchRad = this.pitchCmd.value;

    // Inner loops → servos. Damping uses Euler attitude rates (body p in a steady turn is not φ̇).
    if (s.engaged) {
      const p = ac.rates[0], q = ac.rates[1], r = ac.rates[2]; // indexed: no iterator before the JIT warms up
      const sinPhi = Math.sin(ac.euler[0]), cosPhi = Math.cos(ac.euler[0]);
      const tanTheta = Math.tan(clamp(ac.euler[1], -1.4, 1.4));
      const rollRate = p + tanTheta * (q * sinPhi + r * cosPhi);
      const pitchRate = q * cosPhi - r * sinPhi;
      const rollFf = g.rollFeedForward * scale * (this.rollCmd.value - prevRollCmd) / dt;
      const pitchFf = g.pitchFeedForward * scale * (this.pitchCmd.value - prevPitchCmd) / dt;
      const roll = this.rollPid.update(this.rollCmd.value, ac.euler[0], dt, rollRate) + rollFf;
      let pitch: number;
      if (unloading) {
        // LVL upset recovery, wings first: unload instead of holding θ. An Euler-pitch loop reverses
        // beyond 90° of bank (pulling then lowers the nose) and needs 1/cos φ g to hold the nose in a
        // steep bank, so fly a load-factor law toward 1 g (blending to 0 g inverted) with body
        // pitch-rate damping and a push whenever α exceeds the LVL ceiling ("unload, roll, then
        // pull"). The θ loop takes over bumplessly below the wings-first bank.
        const cphi = Math.cos(ac.euler[0]);
        const nTarget = cphi >= 0 ? 1 : Math.max(0, 1 + cphi);
        const alphaExcess = Math.max(0, ac.aero.alpha - L.lvlAlphaMaxRad);
        pitch = scale * (g.lvlUnloadKn * (nTarget - ac.loadFactor[2]) - g.pitch.kd * q) - g.pitch.kp * alphaExcess;
        this.lvlUnloading = true;
      } else {
        if (this.lvlUnloading) {
          this.lvlUnloading = false;
          this.pitchPid.resetToOutput(s.outPitch, this.pitchCmd.value, ac.euler[1], pitchRate);
        }
        pitch = this.pitchPid.update(this.pitchCmd.value, ac.euler[1], dt, pitchRate) + pitchFf;
      }
      s.outRoll = this.rollServo.update(clamp(roll, -L.servoAuthority, L.servoAuthority), dt);
      s.outPitch = this.pitchServo.update(clamp(pitch, -L.servoAuthority, L.servoAuthority), dt);
      this.updateAutoTrim(dt);
    } else {
      s.outRoll = 0;
      s.outPitch = 0;
    }

    // Yaw damper: rudder opposes washed-out body yaw rate (steady turn rate passes through).
    if (s.yawDamper) {
      const w = this.ydWashout.update(ac.rates[2], dt);
      s.outYaw = clamp(-g.ydGain * w, -g.ydAuthority, g.ydAuthority);
    } else {
      this.ydWashout.reset(ac.rates[2]);
      s.outYaw = 0;
    }

    this.updateAltAlert(ac);
  }

  /**
   * Merge the servo outputs into the pilot's inputs. Returns a private copy (no allocation)
   * with pitch/roll replaced while engaged and the yaw damper's rudder added; `inputs` itself is
   * untouched except for `pitchTrim`, which follows the auto-trim servo (see config.behaviour).
   */
  apply(inputs: ControlInputs): ControlInputs {
    const s = this.state;
    this.pilotPitch = inputs.pitch;
    this.pilotRoll = inputs.roll;
    this.pilotTrim = inputs.pitchTrim;
    if (!s.engaged) {
      s.trimCommand = inputs.pitchTrim;
      if (!s.yawDamper) return inputs;
    }
    const o = this.blended;
    copyInputs(inputs, o);
    if (s.engaged) {
      o.pitch = s.outPitch;
      o.roll = s.outRoll;
      o.pitchTrim = s.trimCommand;
      if (this.config.behaviour.writeTrimToInputs) inputs.pitchTrim = s.trimCommand;
    }
    if (s.yawDamper) o.yaw = clamp(inputs.yaw + s.outYaw, -1, 1);
    return o;
  }

  // ───────────────────────────── mode state machine ─────────────────────────────

  private selectRollHold(): void {
    const s = this.state;
    const L = this.config.limits;
    const ac = this.lastAc;
    s.lateral = 'ROL';
    const roll = ac ? ac.euler[0] : 0;
    s.rollTargetRad = Math.abs(roll) < L.rolWingsLevelRad ? 0 : clamp(roll, -L.bankRad, L.bankRad);
    if (s.vertical === 'GS') this.selectPitchHold();
  }

  private selectPitchHold(): void {
    const s = this.state;
    const L = this.config.limits;
    s.vertical = 'PIT';
    s.pitchTargetRad = clamp(this.lastAc ? this.lastAc.euler[1] : 0, L.pitchMinRad, L.pitchMaxRad);
    if (s.armedVertical === 'ALTS') s.armedVertical = null; // re-armed automatically on the next update
  }

  private clearModes(): void {
    const s = this.state;
    s.lateral = 'OFF'; s.vertical = 'OFF'; s.armedLateral = null; s.armedVertical = null;
  }

  private enterVsMode(mode: 'VS' | 'ALT' | 'ALTS' | 'GS'): void {
    const s = this.state;
    if (!VS_BASED.has(s.vertical) && this.lastAc) {
      const vs = this.lastAc.verticalSpeedMs;
      this.vsPid.resetToOutput(this.pitchCmd.value, vs, vs);
    }
    s.vertical = mode;
    if (s.armedVertical === 'ALTS' && (mode === 'ALT' || mode === 'ALTS')) s.armedVertical = null;
  }

  private enterFlc(): void {
    const s = this.state;
    if (s.vertical !== 'FLC') {
      const ias = this.lastAc ? this.lastAc.aero.ias : s.iasTargetMs;
      this.flcPid.setOutputLimits(this.config.limits.pitchMinRad, this.config.limits.pitchMaxRad);
      this.flcPid.resetToOutput(this.pitchCmd.value, s.iasTargetMs, ias);
    }
    s.vertical = 'FLC';
    if (s.armedVertical === 'ALTS') s.armedVertical = null;
  }

  private armOrCaptureLateral(mode: LateralMode): void {
    const s = this.state;
    const g = this.config.gains;
    if (s.lateral === mode) { s.armedLateral = null; return; }
    s.armedLateral = mode;
    this.lateralDotsRate.reset();
    if (!this.lastNav) return;
    const src = this.resolveSource(mode, this.lastNav);
    if (src.kind === 'none') return;
    const dots = this.deviationDots(src);
    if (Math.abs(dots) <= g.lateralCaptureDots || (s.lateral === 'ROL' && this.config.behaviour.autoInterceptFromRol)) this.captureLateral();
  }

  private captureLateral(): void {
    const s = this.state;
    const mode = s.armedLateral;
    if (!mode) return;
    s.lateral = mode;
    s.armedLateral = null;
    this.locIntegral = 0;
    this.sourceLostTimer = 0;
    if (mode === 'APR' && this.src.kind === 'loc') s.armedVertical = 'GS';
    this.modeChanged();
  }

  private updateLateralModes(dt: number, ac: AircraftState, nav: NavInputs): void {
    const s = this.state;
    const g = this.config.gains;
    if (s.armedLateral) {
      const src = this.resolveSource(s.armedLateral, nav);
      if (src.kind !== 'none') {
        const dots = this.deviationDots(src);
        const rate = this.lateralDotsRate.update(dots, dt);
        const closing = dots * rate < 0;
        const lead = Math.abs(rate) > 1e-6 ? Math.abs(dots / rate) : Number.POSITIVE_INFINITY;
        if (Math.abs(dots) <= g.lateralCaptureDots || (closing && lead <= g.captureLeadS)) this.captureLateral();
      }
    }
    if (NAV_MODES.has(s.lateral)) {
      const src = this.resolveSource(s.lateral, nav);
      if (src.kind === 'none') {
        this.sourceLostTimer += dt;
        if (this.sourceLostTimer >= g.sourceLossGraceS) {
          this.selectRollHold();
          s.rollTargetRad = 0;
          if (s.armedVertical === 'GS') s.armedVertical = null;
          this.modeChanged();
        }
      } else this.sourceLostTimer = 0;
    }
    void ac;
  }

  private updateVerticalModes(dt: number, ac: AircraftState, nav: NavInputs): void {
    const s = this.state;
    const g = this.config.gains;
    const err = s.altitudeTargetM - ac.altitudeIndicatedM;
    const vs = ac.verticalSpeedMs;

    // Glideslope: armed in APR, captures within half a dot (from below in the normal case).
    if (s.armedVertical === 'GS') {
      if (s.lateral !== 'APR') { s.armedVertical = null; this.modeChanged(); }
      else {
        const r = this.radioFor(nav);
        if (r.valid && r.gsValid && r.isLocalizer && Math.abs(cdiToDots(r.gsDeviation)) <= g.gsCaptureDots) {
          this.enterVsMode('GS');
          this.gsIntegral = 0;
          this.gsLostTimer = 0;
          s.armedVertical = null;
          this.modeChanged();
        }
      }
    }
    if (s.vertical === 'GS') {
      const r = this.radioFor(nav);
      // own timer: the lateral source-loss timer is reset every frame while the localizer is valid
      this.gsLostTimer = r.valid && r.gsValid && Number.isFinite(r.gsDeviation) ? 0 : this.gsLostTimer + dt;
      if (s.lateral !== 'APR' || this.gsLostTimer >= g.sourceLossGraceS) { this.selectPitchHold(); this.modeChanged(); }
    }

    // Altitude pre-select: armed whenever a non-ALT mode flies toward (or away from) the target.
    // It keeps working while GS is armed (the GFC 700 arms ALTS and GS together; `armedVertical`
    // holds one value, so GS keeps the display): a descent below the glideslope must still stop at
    // the selected altitude, and GS stays armed to capture from the level-off.
    if (!s.lvl && (s.vertical === 'PIT' || s.vertical === 'VS' || s.vertical === 'FLC')) {
      const gsArmed = s.armedVertical === 'GS';
      const closing = err * vs > 0;
      // within the hold band: capture unless (commanded to be) climbing/descending away from the
      // target — in VS mode the selected VS tells the direction before the aircraft follows it
      const dir = s.vertical === 'VS' ? s.verticalSpeedTargetMs : vs;
      if (Math.abs(err) <= g.altHoldThresholdM && (err * dir > 0 || Math.abs(dir) < g.altLevelVsMs)) {
        this.enterVsMode('ALT');
        if (!gsArmed) s.armedVertical = null;
        this.modeChanged();
      } else if (closing && Math.abs(err) <= altCaptureDistance(vs, g)) {
        // Capture law: VS = K·err with K chosen so the command is continuous at capture and
        // never faster than the current VS → smooth exponential level-off.
        this.altCaptureVs = Math.abs(vs);
        this.altCaptureK = clamp(Math.abs(vs) / Math.max(Math.abs(err), 1), g.altToVs, 4 * g.altToVs);
        this.enterVsMode('ALTS');
        if (!gsArmed) s.armedVertical = null;
        this.modeChanged();
      } else if (!gsArmed && s.armedVertical !== 'ALTS') {
        s.armedVertical = 'ALTS';
        this.modeChanged();
      }
    } else if (s.armedVertical === 'ALTS') {
      s.armedVertical = null;
      this.modeChanged();
    }
    if (s.vertical === 'ALTS' && Math.abs(err) <= g.altHoldThresholdM) {
      s.vertical = 'ALT';
      this.modeChanged();
    }
  }

  // ───────────────────────────── outer loops ─────────────────────────────

  private lateralCommand(dt: number, ac: AircraftState, nav: NavInputs): number {
    const s = this.state;
    const { limits: L, gains: g } = this.config;
    const tas = Math.max(ac.aero.tas, 15);
    switch (s.lateral) {
      case 'ROL':
        return clamp(s.rollTargetRad, -L.bankRad, L.bankRad);
      case 'HDG': {
        const lim = effectiveBankLimit(L.bankRad, L.turnRateRadS, tas);
        return headingToBank(s.headingBugDeg * DEG, ac.headingMagRad, g.hdgToBank, lim);
      }
      case 'NAV': case 'GPS': case 'LOC': case 'APR': {
        const src = this.resolveSource(s.lateral, nav);
        if (src.kind === 'none') return 0; // wings level during the source-loss grace period
        const approach = src.kind === 'loc';
        const lim = effectiveBankLimit(approach ? L.bankAprRad : L.bankRad, L.turnRateRadS, tas);
        const trackTrue = ac.groundSpeedMs > 10 ? ac.trackRad : ac.headingTrueRad;
        if (src.kind === 'gps' && src.plan) {
          const trackCmd = gpsInterceptTrack(src.plan.desiredTrackDeg * DEG, src.plan.crossTrackM, g);
          return headingToBank(trackCmd, trackTrue, g.hdgToBank, lim);
        }
        const r = src.radio;
        if (!r) return 0;
        const magvar = wrapPi(ac.headingTrueRad - ac.headingMagRad);
        const trackMag = trackTrue - magvar;
        const course = r.obsDeg * DEG;
        const dist = r.dmeNm > 0 ? r.dmeNm * NM : g.fallbackDistanceM;
        let trackCmd: number;
        if (src.kind === 'vor') trackCmd = vorInterceptTrack(course, r.cdi, dist, g);
        else {
          const dots = cdiToDots(r.cdi);
          this.locIntegral = clamp(this.locIntegral + g.locKi * dots * dt, -g.locIntegralMaxRad, g.locIntegralMaxRad);
          trackCmd = locInterceptTrack(course, dots, dist, this.locIntegral, g);
        }
        return headingToBank(trackCmd, trackMag, g.hdgToBank, lim);
      }
      default:
        return 0;
    }
  }

  private verticalCommand(dt: number, ac: AircraftState, nav: NavInputs): number {
    const s = this.state;
    const { limits: L, gains: g } = this.config;
    const theta = ac.euler[1];
    const vs = ac.verticalSpeedMs;
    const err = s.altitudeTargetM - ac.altitudeIndicatedM;
    let pitch: number;
    let lo = L.pitchMinRad, hi = L.pitchMaxRad;
    switch (s.vertical) {
      case 'PIT':
        this.vsCmd = 0;
        pitch = s.pitchTargetRad;
        break;
      case 'FLC': {
        this.vsCmd = 0;
        // Direction protection: never descend while climbing to the target and vice versa.
        const lvl = clamp(levelFlightPitch(theta, vs, ac.aero.tas), L.pitchMinRad, L.pitchMaxRad);
        if (err >= 0) this.flcPid.setOutputLimits(lvl, L.pitchMaxRad);
        else this.flcPid.setOutputLimits(L.pitchMinRad, lvl);
        pitch = this.flcPid.update(s.iasTargetMs, ac.aero.ias, dt);
        break;
      }
      case 'VS':
        this.vsCmd = clamp(s.verticalSpeedTargetMs, -L.vsSelectMaxMs, L.vsSelectMaxMs);
        if (s.lvl && wingsFirst(ac.euler[0], L.lvlWingsFirstBankRad)) {
          // LVL, steep bank: hold the attitude (no pull while banked) and keep the VS loop primed
          this.vsPid.resetToOutput(levelFlightPitch(theta, vs, ac.aero.tas), vs, vs);
          pitch = theta;
          lo = Math.min(lo, theta);
          hi = Math.max(hi, theta);
        } else pitch = this.vsPid.update(this.vsCmd, vs, dt);
        break;
      case 'ALT':
        this.vsCmd = altitudeToVs(err, g.altToVs, L.altVsLimitMs);
        pitch = this.vsPid.update(this.vsCmd, vs, dt);
        break;
      case 'ALTS':
        this.vsCmd = altitudeToVs(err, this.altCaptureK, this.altCaptureVs);
        pitch = this.vsPid.update(this.vsCmd, vs, dt);
        break;
      case 'GS': {
        const r = this.radioFor(nav);
        // no usable deviation (signal-loss grace period): fly the nominal path rate
        const dots = r.gsValid && Number.isFinite(r.gsDeviation) ? cdiToDots(r.gsDeviation) : 0;
        const dist = r.dmeNm > 0 ? r.dmeNm * NM : g.fallbackDistanceM;
        this.gsIntegral = clamp(this.gsIntegral + g.gsKi * dots * dt, -g.gsIntegralMaxMs, g.gsIntegralMaxMs);
        this.vsCmd = glideslopeVs(ac.groundSpeedMs, dots, dist, this.gsIntegral, g, L.gsVsMinMs, L.gsVsMaxMs);
        pitch = this.vsPid.update(this.vsCmd, vs, dt);
        break;
      }
      default:
        this.vsCmd = 0;
        pitch = theta;
    }
    if (s.lvl) pitch = Math.min(pitch, alphaLimitedPitch(theta, ac.aero.alpha, L.lvlAlphaMaxRad));
    return clamp(pitch, lo, hi);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** Seed the inner loops and servo slew limiters so the first engaged frame reproduces the pilot's stick. */
  private syncServos(ac: AircraftState): void {
    const s = this.state;
    const p = ac.rates[0], q = ac.rates[1], r = ac.rates[2];
    const sinPhi = Math.sin(ac.euler[0]), cosPhi = Math.cos(ac.euler[0]);
    const tanTheta = Math.tan(clamp(ac.euler[1], -1.4, 1.4));
    this.rollPid.resetToOutput(this.pilotRoll, this.rollCmd.value, ac.euler[0], p + tanTheta * (q * sinPhi + r * cosPhi));
    this.pitchPid.resetToOutput(this.pilotPitch, this.pitchCmd.value, ac.euler[1], q * cosPhi - r * sinPhi);
    this.rollServo.reset(this.rollPid.output);
    this.pitchServo.reset(this.pitchPid.output);
    s.outRoll = this.rollPid.output;
    s.outPitch = this.pitchPid.output;
  }

  /** Spec §5.3 auto-trim: relieve a steady servo load with the trim, with a start delay and hysteresis. */
  private updateAutoTrim(dt: number): void {
    const s = this.state;
    const g = this.config.gains;
    const out = s.outPitch;
    if (this.trimRunning) {
      if (Math.abs(out) < g.trimStopBand) { this.trimRunning = false; this.trimTimer = 0; }
    } else {
      this.trimTimer = Math.abs(out) > g.trimDeadband ? this.trimTimer + dt : 0;
      if (this.trimTimer >= g.trimDelayS) this.trimRunning = true;
    }
    if (this.trimRunning) s.trimCommand = clamp(s.trimCommand + Math.sign(out) * g.trimRatePerS * dt, -1, 1);
  }

  private updateAltAlert(ac: AircraftState): void {
    const s = this.state;
    const err = Math.abs(s.altitudeTargetM - ac.altitudeIndicatedM);
    let alert: AltAlert = 'none';
    if ((s.vertical === 'ALT' || s.vertical === 'ALTS') && err > 200 * FT) alert = 'deviation';
    else if (s.armedVertical === 'ALTS' && err <= 1000 * FT) alert = 'approach';
    s.altAlert = alert;
  }

  private radioFor(nav: NavInputs): NavRadioState {
    return this.navSource === 'nav2' ? nav.nav2 : nav.nav1;
  }

  private resolveSource(mode: LateralMode, nav: NavInputs): ResolvedSource {
    const s = this.src;
    s.kind = 'none'; s.radio = null; s.plan = null;
    const plan = nav.plan;
    const planOk = plan !== null && plan.waypoints.length > 0 && Number.isFinite(plan.desiredTrackDeg) && Number.isFinite(plan.crossTrackM);
    let radio: NavRadioState | null = null;
    switch (mode) {
      case 'GPS':
        if (planOk) { s.kind = 'gps'; s.plan = plan; }
        break;
      case 'NAV':
        if (this.navSource === 'gps' || (this.navSource === 'auto' && planOk)) {
          if (planOk) { s.kind = 'gps'; s.plan = plan; }
        } else radio = this.radioFor(nav);
        break;
      case 'LOC': case 'APR':
        radio = this.radioFor(nav);
        break;
      default:
        break;
    }
    if (radio && radio.valid && Number.isFinite(radio.cdi) && Number.isFinite(radio.obsDeg)) {
      s.kind = radio.isLocalizer ? 'loc' : 'vor';
      s.radio = radio;
    }
    return s;
  }

  /** Lateral deviation of a resolved source in dots (two-dot scale; GPS: 1 nm per dot). */
  private deviationDots(src: ResolvedSource): number {
    if (src.kind === 'gps' && src.plan) return src.plan.crossTrackM / this.config.gains.gpsMetresPerDot;
    if (src.radio) return cdiToDots(src.radio.cdi);
    return 0;
  }

  private modeChanged(): void {
    const s = this.state;
    s.modeChangeT = s.t;
    for (const cb of this.modeCbs) cb(s);
    this.events?.emit('autopilot:changed', this.changedPayload);
  }
}
