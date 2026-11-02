/**
 * Aircraft systems not modelled by the FDM but needed by the gauges: vacuum pump, electrical bus,
 * float-type fuel senders, fallback oil model and hour meters. Constants from docs/research/05 §1.3.
 */
import { clamp } from '../core/math';
import type { ControlInputs } from '../core/types';
import { ELECTRICAL, FUEL } from './c172';
import { AsymmetricLag, Lag } from './filters';

/** Engine-driven vacuum pump: ~5 inHg above 1 200 RPM, regulator limit 5.2 inHg. */
export function suctionInHg(engineRunning: boolean, rpm: number): number {
  if (!engineRunning || rpm <= 0) return 0;
  return clamp(5.0 * Math.min(1, rpm / 1200), 0, 5.2);
}

/** Sum of switched electrical loads in amps. */
export function electricalLoadA(inputs: ControlInputs, flapsMoving: boolean, avionicsOn: boolean): number {
  const l = inputs.lights;
  let a = avionicsOn ? 8 : 0;
  if (l.nav) a += 3;
  if (l.beacon) a += 2.5;
  if (l.strobe) a += 3;
  if (l.landing) a += 8;
  if (l.taxi) a += 5;
  a += 2 * clamp(l.panel, 0, 1);
  if (inputs.pitotHeat) a += 7;
  if (flapsMoving) a += 15;
  return a;
}

/** 28 V bus with a 60 A alternator; without the alternator the battery carries the load. */
export class ElectricalSystem {
  voltsV: number = ELECTRICAL.batteryV;
  ampsA = 0;
  alternatorOnline = false;
  private readonly voltLag = new Lag(0.4, ELECTRICAL.batteryV);
  private readonly chargeLag = new Lag(120, 0);
  private batteryV: number = ELECTRICAL.batteryV;

  step(inputs: ControlInputs, engineRunning: boolean, rpm: number, flapsMoving: boolean, dt: number): void {
    const masterOn = inputs.magnetos !== 0 || engineRunning; // we have no master switch in ControlInputs; mags off ≈ cold & dark
    const load = masterOn ? electricalLoadA(inputs, flapsMoving, true) : 0;
    this.alternatorOnline = engineRunning && rpm > ELECTRICAL.alternatorMinRpm;
    if (this.alternatorOnline) {
      // recharge current decays from ~12 A toward 2 A as the battery tops up
      if (this.chargeLag.value < 1) this.chargeLag.reset(12);
      const charge = 2 + this.chargeLag.step(0, dt);
      this.ampsA = Math.min(60, load + charge);
      this.voltsV = this.voltLag.step(ELECTRICAL.busV, dt);
      this.batteryV = Math.min(ELECTRICAL.batteryV, this.batteryV + 0.002 * dt);
    } else {
      this.ampsA = -load;
      this.batteryV = Math.max(20, this.batteryV - (load / 60) * 0.004 * dt);
      this.voltsV = this.voltLag.step(masterOn ? this.batteryV - 0.02 * load : 0, dt);
      if (!masterOn) this.chargeLag.reset(0);
    }
  }

  get lowVolts(): boolean { return this.voltsV > 1 && this.voltsV < ELECTRICAL.lowVoltsV; }

  reset(engineRunning: boolean): void {
    this.batteryV = ELECTRICAL.batteryV;
    this.voltLag.reset(engineRunning ? ELECTRICAL.busV : ELECTRICAL.batteryV);
    this.voltsV = this.voltLag.value; this.ampsA = 0; this.chargeLag.reset(0);
  }
}

/** Float sender + gauge: slow (τ 2 s), reads usable fuel, sloshes with bank and pitch. */
export class FuelGauge {
  private readonly lag = new Lag(2, 0);
  gal = 0;
  constructor(private readonly unusableGal = FUEL.unusableGalPerTank, private readonly maxGal = FUEL.maxGal) {}
  step(kg: number, rollRad: number, pitchRad: number, dt: number): number {
    const usable = Math.max(0, kg / FUEL.kgPerGal - this.unusableGal);
    const fill = clamp(usable / this.maxGal, 0, 1);
    const slosh = 0.6 * Math.sin(rollRad) * (1 - fill) + 0.4 * Math.sin(pitchRad);
    const bias = fill > 0.5 ? 0.5 * (fill - 0.5) * 2 : 0; // floats read a little high when fuller
    this.gal = clamp(this.lag.step(usable + slosh + bias, dt), 0, this.maxGal);
    return this.gal;
  }
  reset(kg: number): void { this.lag.reset(Math.max(0, kg / FUEL.kgPerGal - this.unusableGal)); this.gal = this.lag.value; }
}

/** Oil temperature/pressure estimate used when the FDM reports no sane values. */
export class OilFallback {
  readonly tempF = new AsymmetricLag(120, 300, 60);
  pressPsi = 0;
  private readonly pressLag = new Lag(3, 0);
  step(engineRunning: boolean, rpm: number, pctPower: number, oatC: number, dt: number): void {
    const target = engineRunning ? 1.8 * oatC + 32 + 100 + 70 * clamp(pctPower, 0, 1) : 1.8 * oatC + 32;
    const t = this.tempF.step(target, dt);
    const p = engineRunning ? Math.min(90, 25 + (65 * rpm) / 2700) * (1 + 0.25 * Math.max(0, (150 - t) / 150)) : 0;
    this.pressPsi = this.pressLag.step(p, dt);
  }
  reset(oatC: number, engineRunning: boolean): void {
    this.tempF.reset(engineRunning ? 1.8 * oatC + 32 + 140 : 1.8 * oatC + 32);
    this.pressLag.reset(engineRunning ? 75 : 0); this.pressPsi = this.pressLag.value;
  }
}

/** Hobbs runs on oil pressure; the tach meter runs at rpm / 2 300 of real time. */
export class HourMeters {
  hobbsHours = 0;
  tachHours = 0;
  step(oilPressPsi: number, rpm: number, dt: number): void {
    if (oilPressPsi > 20) this.hobbsHours += dt / 3600;
    if (rpm > 0) this.tachHours += (dt / 3600) * (rpm / 2300);
  }
}
